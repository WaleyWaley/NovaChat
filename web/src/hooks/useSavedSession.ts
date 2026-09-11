/**
 * 已登录状态静默恢复 (对应 app.js:33-44)
 * 失败不提示, 清除存储并停留登录页。
 */
import { useEffect } from 'react';
import { setAuthToken, getAuthToken, setRefreshToken } from '../api/rest';
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
    setRefreshToken(saved.refresh_token ?? null);
    wsManager
      .connect(saved.access_token)
      .then((payload) => {
        // auth_ok payload 合并进用户信息 (对应 app.js:135)
        useAppStore.getState().setMe({ ...saved, ...payload });
        wsManager.startPing();
        void useAppStore.getState().loadHistory();        // Phase 4.2: 恢复会话历史
        void useAppStore.getState().refreshSelfProfile(); // Phase 4.3: 补拉头像等完整资料
      })
      .catch(() => {
        // token 过期, 清除并显示登录页
        // 竞态保护: 只有当前 token 仍是这次尝试的旧 token 才清空
        // (用户可能已在此期间手动重新登录, 新 token 不能被误清)
        if (getAuthToken() === saved.access_token) {
          saveUser(null);
          setAuthToken(null);
          setRefreshToken(null);
        }
      });
  }, []);
}
