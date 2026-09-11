/**
 * 聊天窗口 (对应 index.html 的 chat-window-template + app.js openChat:271-352)
 * 原来的 <template> 克隆逻辑消失 — ChatWindow 就是模板本身。
 */
import { useAppStore } from '../../store/useAppStore';
import { callManager } from '../../managers/callManager';
import Avatar from '../common/Avatar';
import MessageList from './MessageList';
import ChatInputBar from './ChatInputBar';

interface Props {
  peerId: string;
}

export default function ChatWindow({ peerId }: Props) {
  const chat = useAppStore((s) => s.chats[peerId]);
  const closeChat = useAppStore((s) => s.closeChat);
  const call = useAppStore((s) => s.call);
  const avatarId = useAppStore((s) => s.userAvatars[peerId]);
  const clearChatHistory = useAppStore((s) => s.clearChatHistory);

  if (!chat) return null;
  const peerName = chat.peerName;

  const onCallClick = () => {
    // 通话中再点 = 挂断 (对应 app.js:528)
    if (callManager.isActive()) {
      callManager.hangUp();
      return;
    }
    void callManager.startCall(peerId, peerName);
  };

  const onClearHistory = () => {
    // Phase 4.3: 纯本端清空 (记水位线, 刷新后历史不复活)
    if (!confirm('Clear all messages in this chat? (only on this device)')) return;
    clearChatHistory(peerId);
  };

  return (
    <div className="chat-window">
      <div className="chat-header">
        <button className="back-btn icon-btn" onClick={closeChat}>
          ←
        </button>
        <div className="chat-peer-info">
          <Avatar name={peerName} size={40} avatarId={avatarId ?? null} className="peer-avatar" />
          <div className="peer-detail">
            <span className="peer-name">{peerName}</span>
            <span className="peer-status">last seen recently</span>
          </div>
        </div>
        <button
          className="icon-btn"
          title="Clear chat history (this device only)"
          disabled={chat.messages.length === 0}
          style={chat.messages.length === 0 ? { opacity: 0.4, cursor: 'not-allowed' } : undefined}
          onClick={onClearHistory}
        >
          🗑
        </button>
        <button
          className={`call-btn icon-btn${call.status !== 'idle' ? ' calling' : ''}`}
          title={call.status !== 'idle' ? 'Hang Up' : 'Call'}
          onClick={onCallClick}
        >
          📞
        </button>
      </div>
      <MessageList peerId={peerId} />
      <ChatInputBar peerId={peerId} />
    </div>
  );
}
