/**
 * 消息列表 (对应 app.js addMessage 的渲染容器)
 */
import { useRef } from 'react';
import { useAppStore } from '../../store/useAppStore';
import { useAutoScroll } from '../../hooks/useAutoScroll';
import Message from './Message';

interface Props {
  peerId: string;
}

export default function MessageList({ peerId }: Props) {
  const messages = useAppStore((s) => s.chats[peerId]?.messages ?? []);
  const containerRef = useRef<HTMLDivElement>(null);
  useAutoScroll(containerRef, [peerId, messages.length]);

  return (
    <div className="chat-messages" ref={containerRef}>
      {messages.map((m) => (
        <Message key={m.message_id} message={m} />
      ))}
    </div>
  );
}
