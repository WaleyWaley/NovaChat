/**
 * 主聊天界面: 左侧边栏 + 右侧聊天区 (对应 index.html:40-75)
 * 移动端类名切换复刻 app.js:345-351 的 DOM 操作。
 */
import { useAppStore } from '../../store/useAppStore';
import { useMobileLayout } from '../../hooks/useMobileLayout';
import Sidebar from './Sidebar';
import ChatMain from './ChatMain';

export default function ChatScreen() {
  const activePeerId = useAppStore((s) => s.activePeerId);
  const mobile = useMobileLayout();

  return (
    <div className="chat-container">
      <div className={`sidebar${mobile && activePeerId ? ' hidden' : ''}`}>
        <Sidebar />
      </div>
      <div className={`chat-main${mobile && activePeerId ? ' active' : ''}`}>
        <ChatMain />
      </div>
    </div>
  );
}
