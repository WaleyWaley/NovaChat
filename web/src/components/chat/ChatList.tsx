/**
 * 会话列表 / 搜索结果列表 (对应 app.js renderSearchResults + createChatItem)
 * searchResults 非空时显示搜索结果; 否则按 chatOrder 渲染已有会话。
 */
import { useAppStore } from '../../store/useAppStore';
import ChatItem from './ChatItem';
import type { SearchUser } from '../../types';

export default function ChatList() {
  const searchResults = useAppStore((s) => s.searchResults);
  const chats = useAppStore((s) => s.chats);
  const chatOrder = useAppStore((s) => s.chatOrder);
  const me = useAppStore((s) => s.me);
  const activePeerId = useAppStore((s) => s.activePeerId);

  if (searchResults) {
    const results = searchResults.filter(
      (u) => String(u.user_id) !== String(me?.user_id)
    );
    if (results.length === 0) {
      return (
        <div className="chat-list">
          <div style={{ padding: '20px', textAlign: 'center', color: 'var(--text-muted)' }}>
            No users found
          </div>
        </div>
      );
    }
    return (
      <div className="chat-list">
        {results.map((u: SearchUser) => (
          <ChatItem
            key={u.user_id}
            peerId={String(u.user_id)}
            name={u.first_name || u.username}
            username={u.username}
            active={false}
          />
        ))}
      </div>
    );
  }

  return (
    <div className="chat-list">
      {chatOrder.map((pid) => {
        const chat = chats[pid];
        if (!chat) return null;
        return (
          <ChatItem
            key={pid}
            peerId={pid}
            name={chat.peerName}
            username={chat.peerName}
            unread={chat.unread}
            active={activePeerId === pid}
          />
        );
      })}
    </div>
  );
}
