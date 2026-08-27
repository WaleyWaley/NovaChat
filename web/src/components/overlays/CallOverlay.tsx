/**
 * 全屏通话界面 (对应 app.js showCallScreen:654-673 + 接听/拒绝按钮)
 * 纯 store 消费者; 呼入时显示接听/拒绝双按钮, 其余状态显示挂断。
 */
import { useAppStore } from '../../store/useAppStore';
import { callManager } from '../../managers/callManager';
import { avatarColor, initialOf } from '../../utils/avatar';

const circleBtn = (bg: string): React.CSSProperties => ({
  width: 60,
  height: 60,
  borderRadius: '50%',
  border: 'none',
  background: bg,
  color: '#fff',
  fontSize: 24,
  cursor: 'pointer',
});

export default function CallOverlay() {
  const call = useAppStore((s) => s.call);

  if (call.status === 'idle') return null;

  const color = avatarColor(call.peerName);
  const m = Math.floor(call.seconds / 60);
  const s = (call.seconds % 60).toString().padStart(2, '0');
  const statusText =
    call.status === 'incoming'
      ? 'Incoming call...'
      : call.status === 'connected'
        ? '🔊 Connected'
        : '📞 Calling...';

  return (
    <div
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        background: 'rgba(0,0,0,0.95)',
        zIndex: 10000,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 24,
      }}
    >
      <div
        style={{
          width: 100,
          height: 100,
          borderRadius: '50%',
          background: color,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: 40,
          fontWeight: 700,
          color: '#fff',
        }}
      >
        {initialOf(call.peerName)}
      </div>
      <div style={{ fontSize: 22, fontWeight: 600 }}>{call.peerName}</div>
      <div style={{ fontSize: 15, color: 'var(--text-secondary)' }}>{statusText}</div>
      <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>
        {m}:{s}
      </div>
      <div style={{ display: 'flex', gap: 24, marginTop: 12 }}>
        {call.status === 'incoming' ? (
          <>
            <button style={circleBtn('#4caf50')} onClick={() => void callManager.accept()}>
              📞
            </button>
            <button style={circleBtn('#e74c3c')} onClick={() => callManager.reject()}>
              ✕
            </button>
          </>
        ) : (
          <button style={circleBtn('#e74c3c')} onClick={() => callManager.hangUp()}>
            ✕
          </button>
        )}
      </div>
    </div>
  );
}
