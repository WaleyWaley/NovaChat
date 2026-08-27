/**
 * 单条消息气泡 (对应 app.js addMessage:355-371)
 * React 默认转义文本, 替代旧 escapeHtml。
 */
import { useAppStore } from '../../store/useAppStore';
import { formatTime } from '../../utils/time';
import type { Message as Msg } from '../../types';

interface Props {
  message: Msg;
}

export default function Message({ message }: Props) {
  const me = useAppStore((s) => s.me);
  const isMe = message.is_me || String(message.from_peer.id) === String(me?.user_id);

  // sending '⋯' / sent '✓' / 其余 '✓✓' (对应 app.js:366)
  const glyph = message.status === 'sending' ? '⋯' : message.status === 'sent' ? '✓' : '✓✓';

  return (
    <div className={`message ${isMe ? 'me' : 'you'}`}>
      <div className="message-text">{message.text}</div>
      <div className="msg-time">
        {formatTime(message.created_at || Date.now())}
        {isMe && <span className="message-status">{glyph}</span>}
      </div>
    </div>
  );
}
