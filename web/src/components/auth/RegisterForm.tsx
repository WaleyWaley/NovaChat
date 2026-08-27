/**
 * 注册表单 (对应 app.js:96-128)
 */
import { useState, type FormEvent } from 'react';
import { register, setAuthToken } from '../../api/rest';
import { useAppStore } from '../../store/useAppStore';
import type { Me } from '../../types';

export default function RegisterForm() {
  const [username, setUsername] = useState('');
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const showToast = useAppStore((s) => s.showToast);
  const loginFlow = useAppStore((s) => s.loginFlow);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setAuthToken(null); // 清除旧 token, 注册不需要鉴权

    if (!firstName.trim()) {
      setError('First name is required');
      return;
    }

    try {
      const result = await register(username.trim(), password, firstName.trim(), lastName.trim());
      if (result.error_code && result.error_code !== 0) {
        showToast('❌ ' + (result.error_message || 'Registration failed'), 'error');
        setError(result.error_message || 'Registration failed');
        return;
      }
      showToast('✅ Account created! Logging in...', 'success');
      const user: Me = {
        user_id: result.user_id,
        username: username.trim(),
        first_name: firstName.trim(),
        access_token: result.access_token,
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
        placeholder="Username (3-32 chars, letters only)"
        autoComplete="username"
        value={username}
        onChange={(e) => setUsername(e.target.value)}
      />
      <input
        type="text"
        placeholder="First Name"
        value={firstName}
        onChange={(e) => setFirstName(e.target.value)}
      />
      <input
        type="text"
        placeholder="Last Name (optional)"
        value={lastName}
        onChange={(e) => setLastName(e.target.value)}
      />
      <input
        type="password"
        placeholder="Password (min 8 chars)"
        autoComplete="new-password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
      />
      <button type="submit" className="auth-submit">
        Create Account
      </button>
      <p className="auth-error">{error}</p>
    </form>
  );
}
