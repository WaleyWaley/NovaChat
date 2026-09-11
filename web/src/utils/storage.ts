/**
 * localStorage 持久化 — key 清单:
 *   'novachat_user'   登录用户 JSON (含 access_token)
 *   'nc_names'        peerId → 显示名 缓存
 *   'nc_avatars'      peerId → 头像文件名 缓存 (Phase 4.3)
 *   'nc_deleted'      peerId → 已删除的消息 id 数组 (前端删除墓碑, Phase 4.3)
 *   'nc_cleared'      peerId → 清空聊天记录的水位线 (最大 message_id, Phase 4.3)
 */
import type { Me } from '../types';

const USER_KEY = 'novachat_user';
const NAMES_KEY = 'nc_names';
const AVATARS_KEY = 'nc_avatars';
const DELETED_KEY = 'nc_deleted';
const CLEARED_KEY = 'nc_cleared';

export function loadSavedUser(): Me | null {
  try {
    const raw = localStorage.getItem(USER_KEY);
    return raw ? (JSON.parse(raw) as Me) : null;
  } catch {
    return null;
  }
}

export function saveUser(user: Me | null): void {
  if (user) localStorage.setItem(USER_KEY, JSON.stringify(user));
  else localStorage.removeItem(USER_KEY);
}

export function loadUserNames(): Record<string, string> {
  try {
    const raw = localStorage.getItem(NAMES_KEY);
    return raw ? (JSON.parse(raw) as Record<string, string>) : {};
  } catch {
    return {};
  }
}

export function saveUserNames(names: Record<string, string>): void {
  localStorage.setItem(NAMES_KEY, JSON.stringify(names));
}

// ---- Phase 4.3: 头像缓存 ----

export function loadUserAvatars(): Record<string, string> {
  try {
    const raw = localStorage.getItem(AVATARS_KEY);
    return raw ? (JSON.parse(raw) as Record<string, string>) : {};
  } catch {
    return {};
  }
}

export function saveUserAvatars(avatars: Record<string, string>): void {
  localStorage.setItem(AVATARS_KEY, JSON.stringify(avatars));
}

// ---- Phase 4.3: 前端删除墓碑 ----

/** peerId → 已删除 message_id 数组 (每会话封顶 1000 条) */
export function loadDeletedIds(): Record<string, string[]> {
  try {
    const raw = localStorage.getItem(DELETED_KEY);
    return raw ? (JSON.parse(raw) as Record<string, string[]>) : {};
  } catch {
    return {};
  }
}

export function saveDeletedIds(deleted: Record<string, string[]>): void {
  localStorage.setItem(DELETED_KEY, JSON.stringify(deleted));
}

// ---- Phase 4.3: 清空聊天记录水位线 ----

/** peerId → 清空时的最大 message_id (雪花 ID 单调递增, 历史中小于等于它的不再加载) */
export function loadClearedWatermarks(): Record<string, string> {
  try {
    const raw = localStorage.getItem(CLEARED_KEY);
    return raw ? (JSON.parse(raw) as Record<string, string>) : {};
  } catch {
    return {};
  }
}

export function saveClearedWatermarks(watermarks: Record<string, string>): void {
  localStorage.setItem(CLEARED_KEY, JSON.stringify(watermarks));
}
