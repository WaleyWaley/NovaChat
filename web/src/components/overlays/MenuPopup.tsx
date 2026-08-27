/**
 * 菜单弹层 (对应 app.js:173-195 的 #nova-menu)
 * 全屏透明背景点击关闭, 替代旧的延迟 document 一次性监听。
 */
import { useAppStore } from '../../store/useAppStore';

export default function MenuPopup() {
  const menuOpen = useAppStore((s) => s.menuOpen);
  const setMenuOpen = useAppStore((s) => s.setMenuOpen);

  if (!menuOpen) return null;

  return (
    <>
      <div
        style={{ position: 'fixed', inset: 0, zIndex: 9999 }}
        onClick={() => setMenuOpen(false)}
      />
      <div
        style={{
          position: 'absolute',
          top: '50px',
          left: '10px',
          width: '260px',
          background: 'var(--bg-primary)',
          borderRadius: '12px',
          boxShadow: '0 8px 40px rgba(0,0,0,0.6)',
          zIndex: 10000,
          border: '1px solid var(--border)',
          padding: '16px',
        }}
      >
        <div style={{ fontSize: '16px', fontWeight: 700, marginBottom: '12px' }}>✧ NovaChat</div>
        <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '14px' }}>
          v0.3 — Phase 4 Complete
        </div>
        <div style={{ fontSize: '13px', lineHeight: 2 }}>
          <div>💬 <b>Messaging</b> — Real-time chat + Push</div>
          <div>📞 <b>1v1 Calls</b> — WebRTC P2P Audio</div>
          <div>🔊 <b>Group Voice</b> — Mesh Multi-peer</div>
          <div>🔐 <b>Auth</b> — JWT + PBKDF2</div>
          <div>🗄️ <b>Storage</b> — MySQL + Redis</div>
          <div>🐳 <b>Deploy</b> — Docker Compose</div>
        </div>
        <div
          style={{
            marginTop: '12px',
            paddingTop: '10px',
            borderTop: '1px solid var(--border)',
            fontSize: '11px',
            color: 'var(--text-muted)',
          }}
        >
          C++ bRPC + TypeScript Gateway + WebRTC
        </div>
      </div>
    </>
  );
}
