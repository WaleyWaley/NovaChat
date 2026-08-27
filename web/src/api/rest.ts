/**
 * NovaChat Web — REST API 层 (对应旧 api.js 的 REST 部分)
 * Token 由模块级变量持有, 自动注入 Authorization: Bearer 头。
 */
import type { Me, SearchUser } from '../types';

export interface LoginResult {
  access_token?: string;
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

export function setAuthToken(token: string | null): void {
  authToken = token;
}

async function post<T>(path: string, body: unknown, withAuth = true): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (withAuth && authToken) headers['Authorization'] = `Bearer ${authToken}`;
  const res = await fetch(path, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
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
  const body = /^\d+$/.test(String(idOrName))
    ? { user_id: Number(idOrName) }
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

// ---- 复用旧登录流的字段 (api.js 登录返回值只含 access_token + user) ----
export type { Me };
