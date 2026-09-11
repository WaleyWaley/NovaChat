/**
 * 登录表单 (对应 app.js:63-93)
 * 注意: 原代码登录成功后误弹 "Account created" toast 的 bug 已修复。
 */
import { useState, type FormEvent } from 'react';
import { login, setAuthToken } from '../../api/rest';
import { useAppStore } from '../../store/useAppStore';
import type { Me } from '../../types';

export default function LoginForm() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const showToast = useAppStore((s) => s.showToast);
  const loginFlow = useAppStore((s) => s.loginFlow);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setAuthToken(null); // 清除旧 token, 登录不需要鉴权

    try {
      const result = await login(username.trim(), password);
      if (result.error_code && result.error_code !== 0) {
        showToast('❌ ' + (result.error_message || 'Login failed'), 'error');
        setError(result.error_message || 'Login failed');
        return;
      }
      // 登录返回已包含用户资料, 直接用 (对应 app.js:77-89)
      showToast('✅ Welcome!', 'success');
      const user: Me = {
        user_id: result.user?.user_id || 0,
        username: username.trim(),
        first_name: result.user?.first_name || username.trim(),
        access_token: result.access_token || '',
        refresh_token: result.refresh_token,
      };
      try {
        await loginFlow(user);
      } catch {
        // WS 连接失败 (对应 app.js:140-142)
        setError('Cannot connect to server. Is the gateway running?');
      }
    } catch (err) {
      setError(`Connection error: ${(err as Error).message}`);
    }
  };

  return (
    <form className="auth-form active" onSubmit={onSubmit}>
      <input
        type="text"
        placeholder="Username"
        autoComplete="username"
        value={username}
        onChange={(e) => setUsername(e.target.value)}
      />
      <input
        type="password"
        placeholder="Password"
        autoComplete="current-password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
      />
      <button type="submit" className="auth-submit">
        Log In
      </button>
      <p className="auth-error">{error}</p>
    </form>
  );
}
