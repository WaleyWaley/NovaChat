/**
 * 登录/注册界面 (对应 index.html:11-38)
 */
import { useState } from 'react';
import LoginForm from './LoginForm';
import RegisterForm from './RegisterForm';

export default function AuthScreen() {
  const [tab, setTab] = useState<'login' | 'register'>('login');

  return (
    <div className="auth-container">
      <div className="auth-card">
        <div className="auth-header">
          <div className="auth-logo">✧</div>
          <h1>NovaChat</h1>
          <p>Fast. Secure. Real-time.</p>
        </div>
        <div className="auth-tabs">
          <button
            className={`auth-tab ${tab === 'login' ? 'active' : ''}`}
            data-tab="login"
            onClick={() => setTab('login')}
          >
            Log In
          </button>
          <button
            className={`auth-tab ${tab === 'register' ? 'active' : ''}`}
            data-tab="register"
            onClick={() => setTab('register')}
          >
            Sign Up
          </button>
        </div>
        {tab === 'login' ? <LoginForm /> : <RegisterForm />}
      </div>
    </div>
  );
}
