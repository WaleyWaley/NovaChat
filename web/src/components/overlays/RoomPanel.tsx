/**
 * 语音房间面板 (对应 app.js showRoomPanel:744-768 + renderRoomPanel:770-783)
 * 固定在右下角; 纯 store 消费者。
 */
import { useAppStore } from '../../store/useAppStore';
import { roomManager } from '../../managers/roomManager';
import { avatarColor, initialOf } from '../../utils/avatar';

export default function RoomPanel() {
  const room = useAppStore((s) => s.room);
  const me = useAppStore((s) => s.me);
  const userNames = useAppStore((s) => s.userNames);
  const showToast = useAppStore((s) => s.showToast);

  if (!room.roomId) return null;

  const m = Math.floor(room.seconds / 60);
  const s = (room.seconds % 60).toString().padStart(2, '0');

  const onInvite = () => {
    // 聚焦搜索框, 搜索后点击用户即邀请 (对应 app.js:763)
    document.getElementById('search-input')?.focus();
    showToast('Search & click user to invite', 'info');
  };

  return (
    <div
      style={{
        position: 'fixed',
        bottom: '80px',
        right: '20px',
        width: '280px',
        background: 'var(--bg-primary)',
        borderRadius: '16px',
        boxShadow: '0 8px 40px rgba(0,0,0,0.5)',
        zIndex: 9999,
        border: '1px solid var(--border)',
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          padding: '14px 16px',
          borderBottom: '1px solid var(--border)',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
        }}
      >
        <span style={{ fontWeight: 600 }}>🔊 Voice Room</span>
        <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
          {m}:{s}
        </span>
      </div>
      <div style={{ padding: '8px 16px', maxHeight: '200px', overflowY: 'auto' }}>
        {room.participants.map((p) => {
          const isMe = String(p.userId) === String(me?.user_id);
          const cached = userNames[String(p.userId)];
          const displayName = isMe
            ? (me?.first_name || me?.username || 'You')
            : cached || p.username || 'User ' + String(p.userId).slice(-6);
          const color = avatarColor(displayName);
          return (
            <div key={p.userId} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0' }}>
              <div
                style={{
                  width: 36,
                  height: 36,
                  borderRadius: '50%',
                  background: color,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: 14,
                  fontWeight: 700,
                  color: '#fff',
                  flexShrink: 0,
                }}
              >
                {initialOf(displayName)}
              </div>
              <span style={{ fontSize: 14 }}>
                {displayName}
                {isMe ? ' (You)' : ''}
              </span>
            </div>
          );
        })}
      </div>
      <div
        style={{
          padding: '12px 16px',
          display: 'flex',
          gap: 10,
          justifyContent: 'center',
          borderTop: '1px solid var(--border)',
        }}
      >
        <button
          style={{
            padding: '8px 14px',
            borderRadius: 20,
            border: 'none',
            background: 'var(--accent)',
            color: '#fff',
            fontSize: 13,
            cursor: 'pointer',
          }}
          onClick={onInvite}
        >
          + Invite
        </button>
        <button
          style={{
            padding: '8px 14px',
            borderRadius: 20,
            border: 'none',
            background: 'var(--danger)',
            color: '#fff',
            fontSize: 13,
            cursor: 'pointer',
          }}
          onClick={() => roomManager.leaveRoom()}
        >
          Leave
        </button>
      </div>
    </div>
  );
}
