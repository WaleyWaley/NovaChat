/**
 * WS 事件 → store 桥接 (对应 app.js setupMessageHandler:145-159)
 * App 挂载时调用一次 (模块 flag 幂等)。
 */
import { wsManager } from '../api/ws';
import { useAppStore } from '../store/useAppStore';
import { callManager } from './callManager';
import { roomManager } from './roomManager';
import type { IncomingMessageInner } from '../types';

let initialized = false;

export function initWsBridge(): void {
  if (initialized) return;
  initialized = true;

  // rpc_result: send_msg 回执, seq → 真实 message_id (对应 app.js:147-149)
  wsManager.on('rpc_result', (e) => {
    useAppStore.getState().confirmMessage(e.seq, e.data?.message_id ?? 0);
  });

  // update: 服务端推送新消息 (对应 app.js:150-152 + receiveMessage)
  wsManager.on('update', (e) => {
    if (!(e.updateType === 0 || e.updateType === 'UPDATE_NEW_MESSAGE' || e.updateType === '0')) return;
    const data = e.data as IncomingMessageInner | undefined;
    const inner = (data?.newMessage ?? data?.new_message ?? data) as IncomingMessageInner | undefined;
    if (!inner || !inner.text) return;

    const store = useAppStore.getState();
    const me = store.me;
    const fromId = String(inner.fromPeer?.id ?? inner.from_peer?.id ?? '0');

    // 自己的消息忽略 (对应 app.js:402)
    if (!me || String(me.user_id) === fromId) return;

    const msgId = String(inner.messageId ?? inner.message_id ?? Date.now());
    store.addIncomingMessage(fromId, {
      message_id: msgId,
      text: inner.text,
      created_at: Date.now(),
    });
    // 异步查真实用户名 (对应 app.js:421-440)
    if (!store.userNames[fromId]) void store.resolvePeerName(fromId);
  });

  // UPDATE_MESSAGE_READ: 对方已读我的消息 → 双勾 ✓✓
  wsManager.on('update', (e) => {
    if (!(e.updateType === 3 || e.updateType === 'UPDATE_MESSAGE_READ' || e.updateType === '3')) return;
    const data = e.data as Record<string, unknown> | undefined;
    const rr = (data?.readReceipt ?? data?.read_receipt ?? data) as
      | { maxReadMsgId?: string | number; max_read_msg_id?: string | number }
      | undefined;
    if (!rr) return;
    const maxRead = String(rr.maxReadMsgId ?? rr.max_read_msg_id ?? '0');
    if (maxRead === '0') return;
    useAppStore.getState().markMessagesReceived(maxRead);
  });

  // 信令转发给 WebRTC 管理器
  wsManager.on('call_signal', (e) => callManager.handleSignal(e.payload));
  wsManager.on('room_signal', (e) => roomManager.handleSignal(e.payload));

  wsManager.on('error', (e) => console.error('Server error:', e.payload));
  wsManager.on('kicked', (e) => console.warn('Kicked:', e.payload));
}
