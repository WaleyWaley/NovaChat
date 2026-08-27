/**
 * 已登录状态静默恢复 (对应 app.js:33-44)
 * 失败不提示, 清除存储并停留登录页。
 */
import { useEffect } from 'react';
import { setAuthToken } from '../api/rest';
import { wsManager } from '../api/ws';
import { useAppStore } from '../store/useAppStore';
import { loadSavedUser, saveUser } from '../utils/storage';

let checked = false; // 模块级 guard: StrictMode 双挂载不重复连接

export function useSavedSession(): void {
  useEffect(() => {
    if (checked) return;
    checked = true;

    const saved = loadSavedUser();
    if (!saved) return;

    setAuthToken(saved.access_token);
    wsManager
      .connect(saved.access_token)
      .then((payload) => {
        // auth_ok payload 合并进用户信息 (对应 app.js:135)
        useAppStore.getState().setMe({ ...saved, ...payload });
        wsManager.startPing();
      })
      .catch(() => {
        // token 过期, 清除并显示登录页
        saveUser(null);
        setAuthToken(null);
      });
  }, []);
}
