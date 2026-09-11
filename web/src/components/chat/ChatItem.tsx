/**
 * 会话/用户列表项 (对应 app.js createChatItem:236-268)
 * 在语音房间中点击 = 发送邀请 (对应 app.js:256-261)。
 */
import { useAppStore } from '../../store/useAppStore';
import { roomManager } from '../../managers/roomManager';
import Avatar from '../common/Avatar';

interface Props {
  peerId: string;
  name: string;
  username: string;
  unread?: number;
  active?: boolean;
  avatarId?: string | null;
}

export default function ChatItem({ peerId, name, username, unread = 0, active = false, avatarId }: Props) {
  const openChat = useAppStore((s) => s.openChat);
  const roomId = useAppStore((s) => s.room.roomId);
  const showToast = useAppStore((s) => s.showToast);

  const onClick = () => {
    // 如果在房间中, 点击用户直接邀请 (对应 app.js:256-261)
    if (roomId) {
      roomManager.invite([peerId]);
      showToast(`📨 Invited ${name} to room`, 'info');
      return;
    }
    openChat(peerId, name);
  };

  return (
    <div className={`chat-item${active ? ' active' : ''}`} onClick={onClick}>
      <Avatar name={name} avatarId={avatarId} className="chat-item-avatar" />
      <div className="chat-item-content">
        <div className="chat-item-name">{name}</div>
        <div className="chat-item-preview">@{username || 'unknown'}</div>
      </div>
      <div className="chat-item-meta">
        <span className="chat-item-time" />
        {unread > 0 && <span className="chat-item-badge">{unread > 99 ? '99+' : unread}</span>}
      </div>
    </div>
  );
}
