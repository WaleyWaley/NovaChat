/**
 * 单条消息气泡 (对应 app.js addMessage:355-371)
 * React 默认转义文本, 替代旧 escapeHtml。
 * Phase 4.3: hover 显示 ✕ 删除按钮 — 纯本端删除 (不动服务器、不推对方)
 */
import { useAppStore } from '../../store/useAppStore';
import { formatTime } from '../../utils/time';
import type { Message as Msg } from '../../types';

interface Props {
  message: Msg;
}

export default function Message({ message }: Props) {
  const me = useAppStore((s) => s.me);
  const activePeerId = useAppStore((s) => s.activePeerId);
  const deleteMessage = useAppStore((s) => s.deleteMessage);
  const isMe = message.is_me || String(message.from_peer.id) === String(me?.user_id);

  // sending '⋯' / sent '✓' / 其余 '✓✓' (对应 app.js:366)
  const glyph = message.status === 'sending' ? '⋯' : message.status === 'sent' ? '✓' : '✓✓';

  const onDelete = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!activePeerId) return;
    if (!confirm('Delete this message from your view?')) return;
    deleteMessage(activePeerId, message.message_id);
  };

  return (
    <div className={`message ${isMe ? 'me' : 'you'}`}>
      <button className="msg-delete" title="Delete (only for me)" onClick={onDelete}>
        ✕
      </button>
      <div className="message-text">{message.text}</div>
      <div className="msg-time">
        {formatTime(message.created_at || Date.now())}
        {isMe && <span className="message-status">{glyph}</span>}
      </div>
    </div>
  );
}
