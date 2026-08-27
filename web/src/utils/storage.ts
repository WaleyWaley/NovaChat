/**
 * localStorage 持久化 — 对应旧代码的两个 key:
 *   'novachat_user'  登录用户 JSON (含 access_token)
 *   'nc_names'       peerId → 显示名 缓存
 */
import type { Me } from '../types';

const USER_KEY = 'novachat_user';
const NAMES_KEY = 'nc_names';

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
