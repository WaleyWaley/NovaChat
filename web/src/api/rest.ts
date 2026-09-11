/**
 * NovaChat Web — REST API 层 (对应旧 api.js 的 REST 部分)
 * Token 由模块级变量持有, 自动注入 Authorization: Bearer 头。
 */
import type { Me, SearchUser } from '../types';
import { loadSavedUser, saveUser } from '../utils/storage';

export interface LoginResult {
  access_token?: string;
  refresh_token?: string;
  user?: { user_id: number; first_name?: string };
  error_code?: number;
  error_message?: string;
}

export interface RegisterResult {
  user_id: number;
  access_token: string;
  refresh_token?: string;
  error_code?: number;
  error_message?: string;
}

let authToken: string | null = null;
let refreshToken: string | null = null;
let refreshPromise: Promise<string | null> | null = null; // 单飞: 并发 401 只触发一次刷新

export function setAuthToken(token: string | null): void {
  authToken = token;
}

export function getAuthToken(): string | null {
  return authToken;
}

export function setRefreshToken(token: string | null): void {
  refreshToken = token;
}

export function getRefreshToken(): string | null {
  return refreshToken;
}

/**
 * 静默续期: 用 refresh_token 调 /api/auth/refresh 换新 access_token (轮转)。
 * 成功返回新 access_token, 失败返回 null。并发调用共享同一次请求 (单飞)。
 */
export async function refreshAuthToken(): Promise<string | null> {
  if (!refreshToken) return null;
  if (!refreshPromise) {
    refreshPromise = (async () => {
      try {
        const res = await fetch('/api/auth/refresh', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refresh_token: refreshToken }),
        });
        if (!res.ok) return null;
        const data = (await res.json()) as {
          error_code?: number;
          access_token?: string;
          refresh_token?: string;
        };
        if (data.error_code !== 0 || !data.access_token) return null;
        authToken = data.access_token;
        if (data.refresh_token) refreshToken = data.refresh_token;
        persistTokens(); // 同步 localStorage, 防止刷新页面后回到旧 token
        return authToken;
      } catch {
        return null;
      } finally {
        refreshPromise = null;
      }
    })();
  }
  return refreshPromise;
}

/** 把最新 token 写回 localStorage 的登录态 (下次打开页面用新 token 恢复) */
function persistTokens(): void {
  const saved = loadSavedUser();
  if (saved) {
    saveUser({
      ...saved,
      access_token: authToken ?? saved.access_token,
      refresh_token: refreshToken ?? saved.refresh_token,
    });
  }
}

/** 401 且错误码为过期/会话失效 → 尝试静默续期, 返回 true 表示调用方应重试 */
async function tryRefreshOn401(res: Response): Promise<boolean> {
  let code = 0;
  try {
    const body = (await res.clone().json()) as { error_code?: number };
    code = body.error_code ?? 0;
  } catch {
    return false;
  }
  if (code !== 1002 && code !== 1003) return false;
  return (await refreshAuthToken()) !== null;
}

/** 续期彻底失败 → 清登录态回登录页 (动态 import 避免与 store 的静态循环依赖) */
async function forceLogout(): Promise<void> {
  authToken = null;
  refreshToken = null;
  const { useAppStore } = await import('../store/useAppStore');
  useAppStore.getState().logout();
}

function buildHeaders(withAuth: boolean): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (withAuth && authToken) headers['Authorization'] = `Bearer ${authToken}`;
  return headers;
}

async function post<T>(path: string, body: unknown, withAuth = true): Promise<T> {
  const send = (): Promise<Response> =>
    fetch(path, {
      method: 'POST',
      headers: buildHeaders(withAuth),
      body: JSON.stringify(body),
    });
  let res = await send();
  if (res.status === 401 && (await tryRefreshOn401(res))) {
    res = await send(); // 换新 token 后重试一次
  }
  if (!res.ok) {
    if (res.status === 401) await forceLogout();
    throw new Error(`HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

/**
 * 通用请求 (Phase 4.3): 支持任意 method 的请求体
 * 自动注入 Bearer 头; 调用方自设 Content-Type
 * (FormData 上传时绝不能手动设 Content-Type, 浏览器会自动带 multipart boundary)
 */
async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const send = (): Promise<Response> => {
    const headers: Record<string, string> = { ...((init.headers as Record<string, string>) ?? {}) };
    if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
    return fetch(path, { ...init, headers });
  };
  let res = await send();
  if (res.status === 401 && (await tryRefreshOn401(res))) {
    res = await send(); // 换新 token 后重试一次
  }
  if (!res.ok) {
    if (res.status === 401) await forceLogout();
    // 尝试读服务端错误信息 (如 413 "File too large")
    let message = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { error_message?: string };
      if (body.error_message) message = body.error_message;
    } catch {
      // 无 JSON 响应体, 用状态码兜底
    }
    throw new Error(message);
  }
  return res.json() as Promise<T>;
}

export function login(username: string, password: string): Promise<LoginResult> {
  return post<LoginResult>('/api/auth/login', { username, password }, false);
}

export function register(
  username: string,
  password: string,
  firstName: string,
  lastName: string
): Promise<RegisterResult> {
  return post<RegisterResult>(
    '/api/auth/register',
    { username, password, first_name: firstName, last_name: lastName || '' },
    false
  );
}

/**
 * 查用户资料 — 对应 app.js:421-440 名字解析用到的版本 (带 Authorization 头)。
 * 网关 /api/user/profile 需认证 (见 gateway/src/routes/user.ts:130-140)。
 * /^\d+$/ 分流 user_id / username; 任何失败返回空对象。
 */
export async function getUserProfile(idOrName: string | number): Promise<Record<string, unknown>> {
  // user_id 原样传 string: brpc JSON 接受字符串 int64, Number() 转换会丢精度
  const body = /^\d+$/.test(String(idOrName))
    ? { user_id: String(idOrName) }
    : { username: String(idOrName) };
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
    const res = await fetch('/api/user/profile', {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    if (!res.ok) return {};
    return res.json();
  } catch {
    return {};
  }
}

export async function searchUsers(query: string, limit = 20): Promise<{ users?: SearchUser[] }> {
  return post<{ users?: SearchUser[] }>('/api/user/search', { query, limit });
}

// ---- Phase 4.2: 历史恢复 ----

export interface DialogPeerDto {
  peer_type: number;
  peer_id: string | number;
  latest_msg_id: string | number;
}

export interface HistoryMessageDto {
  message_id: string | number;
  from_peer: { type: string; id: string | number };
  to_peer: { type: string; id: string | number };
  type: string;
  text: string;
  status?: string | number;   // 枚举名 "MESSAGE_STATUS_READ" 或数字 3
  created_at: number;
}

/** 会话列表 (我聊过天的对端) */
export async function getDialogs(): Promise<{ dialogs?: DialogPeerDto[] }> {
  return post<{ dialogs?: DialogPeerDto[] }>('/api/messages/dialogs', {});
}

/** 与某个对端的双向历史 (最新优先) */
export async function getConversation(
  peerId: string | number,
  limit = 50,
  offsetId: string | number = 0
): Promise<{ messages?: HistoryMessageDto[]; has_more?: boolean }> {
  return post<{ messages?: HistoryMessageDto[]; has_more?: boolean }>(
    '/api/messages/history',
    { peer_type: 1, peer_id: String(peerId), limit, offset_id: String(offsetId) }
  );
}

// ---- Phase 4.3: 个人资料修改 ----

export interface UpdateProfileResult {
  error_code?: number;
  error_message?: string;
  user?: { user_id: string | number; username?: string; first_name?: string; avatar_photo_id?: string };
}

export interface UploadAvatarResult {
  error_code?: number;
  error_message?: string;
  avatar_photo_id: string;
  avatar_url: string;
}

/** 修改显示名 (网关 PATCH /api/users/me → user-service UpdateProfile) */
export function patchProfile(fields: { first_name?: string }): Promise<UpdateProfileResult> {
  return request<UpdateProfileResult>('/api/users/me', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(fields),
  });
}

/** 上传头像 (multipart; 网关落盘后把文件名写进 avatar_photo_id) */
export function uploadAvatar(file: File): Promise<UploadAvatarResult> {
  const fd = new FormData();
  fd.append('file', file);
  return request<UploadAvatarResult>('/api/users/me/avatar', { method: 'POST', body: fd });
}

/** 移除头像 (网关删文件 + 清空 avatar_photo_id) */
export function removeAvatar(): Promise<{ error_code?: number; error_message?: string }> {
  return request('/api/users/me/avatar', { method: 'DELETE' });
}

// ---- 复用旧登录流的字段 (api.js 登录返回值只含 access_token + user) ----
export type { Me };
