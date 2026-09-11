/**
 * 左侧边栏: 头部(菜单/标题/新建) + 搜索 + 会话列表 + 底部个人信息
 */
import { useRef } from 'react';
import { useAppStore } from '../../store/useAppStore';
import { callManager } from '../../managers/callManager';
import { roomManager } from '../../managers/roomManager';
import SearchBar from './SearchBar';
import ChatList from './ChatList';
import MenuPopup from '../overlays/MenuPopup';
import Avatar from '../common/Avatar';

export default function Sidebar() {
  const me = useAppStore((s) => s.me);
  const logout = useAppStore((s) => s.logout);
  const setMenuOpen = useAppStore((s) => s.setMenuOpen);
  const setProfileOpen = useAppStore((s) => s.setProfileOpen);
  const searchRef = useRef<{ focusAndReset: () => void } | null>(null);

  const onLogout = () => {
    // 清理通话/房间后再登出 (对应 app.js logout + hangUp 包装)
    callManager.hangUp();
    roomManager.leaveRoom();
    logout();
  };

  const myName = me?.first_name || me?.username || '';

  return (
    <>
      <div className="sidebar-header">
        <button className="icon-btn" title="Menu" onClick={() => setMenuOpen(true)}>
          ☰
        </button>
        <span className="sidebar-title">NovaChat</span>
        <button
          className="icon-btn"
          title="New Chat"
          onClick={() => searchRef.current?.focusAndReset()}
        >
          +
        </button>
      </div>
      <div className="sidebar-search" style={{ display: 'flex', gap: '8px' }}>
        <SearchBar ref={searchRef} />
        <button
          className="icon-btn"
          title={roomManager.isInRoom() ? 'Leave Voice Room' : 'Create Voice Room'}
          style={{ fontSize: '18px' }}
          onClick={() => roomManager.toggle()}
        >
          <RoomButtonIcon />
        </button>
      </div>
      <ChatList />
      <div className="sidebar-footer">
        <div
          className="user-info"
          title="Profile settings"
          onClick={() => setProfileOpen(true)}
          style={{ cursor: 'pointer' }}
        >
          <Avatar name={myName} size={36} avatarId={me?.avatar_photo_id ?? null} className="user-avatar" />
          <div className="user-detail">
            <span id="my-username">{myName}</span>
            <span className="user-status">online</span>
          </div>
        </div>
        <button className="icon-btn" title="Logout" onClick={onLogout}>
          ⏻
        </button>
      </div>
      <MenuPopup />
    </>
  );
}

/** 🔊 按钮图标: 在房间中显示 ✕ (store 驱动, 替代旧 $('#create-room-btn').textContent) */
function RoomButtonIcon() {
  const roomId = useAppStore((s) => s.room.roomId);
  return <>{roomId ? '✕' : '🔊'}</>;
}
