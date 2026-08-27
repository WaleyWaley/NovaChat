/**
 * 右侧聊天区: 有活动会话显示聊天窗口, 否则显示占位 (对应 app.js openChat 的 placeholder 切换)
 */
import { useAppStore } from '../../store/useAppStore';
import ChatWindow from './ChatWindow';

export default function ChatMain() {
  const activePeerId = useAppStore((s) => s.activePeerId);

  if (!activePeerId) {
    return (
      <div className="chat-placeholder">
        <div className="placeholder-logo">✧</div>
        <h2>Welcome to NovaChat</h2>
        <p>Select a chat or start a new conversation</p>
      </div>
    );
  }
  return <ChatWindow peerId={activePeerId} />;
}
