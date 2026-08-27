/**
 * 消息输入栏 (对应 app.js openChat 里的 send 逻辑:305-331)
 * 乐观发送: store.sendMessage 同步写入 store 再发 WS。
 */
import { useEffect, useRef, useState } from 'react';
import { useAppStore } from '../../store/useAppStore';

interface Props {
  peerId: string;
}

export default function ChatInputBar({ peerId }: Props) {
  const [text, setText] = useState('');
  const sendMessage = useAppStore((s) => s.sendMessage);
  const inputRef = useRef<HTMLInputElement>(null);

  // 切换会话时聚焦 (旧模板的 autofocus 属性不够)
  useEffect(() => {
    inputRef.current?.focus();
  }, [peerId]);

  const send = () => {
    const t = text.trim();
    if (!t) return;
    sendMessage(peerId, t);
    setText('');
  };

  return (
    <div className="chat-input-bar">
      <input
        ref={inputRef}
        type="text"
        className="chat-input"
        placeholder="Write a message..."
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            send();
          }
        }}
      />
      <button className="send-btn" onClick={send}>
        Send
      </button>
    </div>
  );
}
