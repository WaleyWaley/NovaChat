/**
 * 根组件: me 决定显示聊天屏还是登录屏; 全局浮层常驻挂载。
 */
import { useEffect } from 'react';
import { useAppStore } from './store/useAppStore';
import { initWsBridge } from './managers/wsBridge';
import { useSavedSession } from './hooks/useSavedSession';
import AuthScreen from './components/auth/AuthScreen';
import ChatScreen from './components/chat/ChatScreen';
import ToastHost from './components/ToastHost';
import CallOverlay from './components/overlays/CallOverlay';
import RoomPanel from './components/overlays/RoomPanel';
import RoomInviteOverlay from './components/overlays/RoomInviteOverlay';

export default function App() {
  const me = useAppStore((s) => s.me);

  useSavedSession();
  useEffect(() => {
    initWsBridge();
  }, []);

  return (
    <>
      {me ? <ChatScreen /> : <AuthScreen />}
      <ToastHost />
      <CallOverlay />
      <RoomPanel />
      <RoomInviteOverlay />
    </>
  );
}
