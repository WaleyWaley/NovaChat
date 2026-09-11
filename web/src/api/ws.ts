/**
 * NovaChat Web — WsManager (对应旧 api.js 的 WebSocket 部分)
 * 模块级单例, 位于 React 之外:
 *   connect/seq/自动重连/心跳/发送封装/事件发射器
 * StrictMode 防护: connect 缓存 in-flight promise, startPing 幂等。
 */
import type { CallSignalPayload, OutboundMsg, ReadReceiptPayload, RoomSignalPayload, SendMsgPayload, WsEvent } from '../types';
import { refreshAuthToken } from './rest';

type WsHandler<T extends WsEvent['kind']> = (event: Extract<WsEvent, { kind: T }>) => void;

class WsManager {
  private ws: WebSocket | null = null;
  private seq = 0;
  private token: string | null = null;
  private authed = false;
  private everAuthed = false; // 曾认证成功过 (用于区分"首次连接失败"与"重连时过期")
  private handlers = new Map<WsEvent['kind'], Set<(e: WsEvent) => void>>();
  private connectPromise: Promise<Record<string, unknown>> | null = null;
  private pendingAuth: {
    resolve: (p: Record<string, unknown>) => void;
    reject: (err: Error) => void;
  } | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;

  get isOpen(): boolean {
    return !!this.ws && this.ws.readyState === WebSocket.OPEN;
  }

  /**
   * 建连并在 auth_ok 后 resolve 出服务端返回的用户 payload。
   * - 已连且已认证 → 复用 (防 StrictMode 双 socket)
   * - 已连但未认证 (上次 auth 失败, 网关只回 error 不关连接) → 在现有 socket 上重发 auth
   * - auth 失败 (网关回 error / 连接关闭) → reject, 绝不静默挂起
   */
  connect(accessToken: string): Promise<Record<string, unknown>> {
    this.token = accessToken;

    if (this.isOpen && this.authed) return Promise.resolve({});

    if (this.isOpen && !this.authed) {
      return new Promise<Record<string, unknown>>((resolve, reject) => {
        this.pendingAuth = { resolve, reject };
        this._send({ type: 'auth', seq: this._nextSeq(), payload: { access_token: accessToken } });
      });
    }

    if (this.connectPromise) return this.connectPromise;

    this.connectPromise = new Promise<Record<string, unknown>>((resolve, reject) => {
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = new WebSocket(`${proto}//${location.host}/ws`);

      ws.onopen = () => {
        this.ws = ws;
        this.authed = false;
        // 向后端发送认证 (对应 api.js:83)
        this._send({ type: 'auth', seq: this._nextSeq(), payload: { access_token: accessToken } });
      };
      ws.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data) as { type: string; seq?: number; payload?: unknown };
          if (msg.type === 'auth_ok') {
            this.authed = true;
            this.everAuthed = true;
            this._resolveAuth((msg.payload as Record<string, unknown>) ?? {});
          }
          this._handleMessage(msg);
          if (msg.type === 'auth_ok') resolve((msg.payload as Record<string, unknown>) ?? {});
        } catch (err) {
          console.error('WS parse error:', err);
        }
      };
      ws.onerror = (err) => {
        console.error('WS error:', err);
        reject(err);
        this._rejectAuth(err instanceof Error ? err : new Error('WebSocket error'));
      };
      ws.onclose = (e) => {
        console.log('WS closed:', e.code, e.reason);
        if (this.ws === ws) this.ws = null;
        this.authed = false;
        this._rejectAuth(new Error(`Connection closed (${e.code})`));
        // token 到期被网关主动断开 (4003): 静默续期后重连, 不打扰用户
        if (e.code === 4003) {
          void this._refreshAndReconnect();
          return;
        }
        // 自动重连 (对应 api.js:98-104)
        if (e.code !== 1000 && e.code !== 4001) {
          setTimeout(() => {
            // 用户登录后才重连
            if (this.token) this.connect(this.token);
          }, 3000);
        }
      };
    }).finally(() => {
      this.connectPromise = null;
    });

    return this.connectPromise;
  }

  /** pendingAuth 兑现: auth_ok 到达 */
  private _resolveAuth(payload: Record<string, unknown>): void {
    if (this.pendingAuth) {
      const p = this.pendingAuth;
      this.pendingAuth = null;
      p.resolve(payload);
    }
  }

  /** pendingAuth 拒绝: auth 被拒 (网关回 error) 或连接断开 */
  private _rejectAuth(err: Error): void {
    if (this.pendingAuth) {
      const p = this.pendingAuth;
      this.pendingAuth = null;
      p.reject(err);
    }
  }

  on<T extends WsEvent['kind']>(kind: T, handler: WsHandler<T>): void {
    let set = this.handlers.get(kind);
    if (!set) {
      set = new Set();
      this.handlers.set(kind, set);
    }
    set.add(handler as (e: WsEvent) => void);
  }

  off<T extends WsEvent['kind']>(kind: T, handler: WsHandler<T>): void {
    this.handlers.get(kind)?.delete(handler as (e: WsEvent) => void);
  }

  private emit(event: WsEvent): void {
    this.handlers.get(event.kind)?.forEach((h) => h(event));
  }

  /** 通过 WebSocket RPC 代理发消息, 返回 seq (对应 api.js:165-178) */
  sendMessage(peerId: string | number, text: string): number {
    const seq = this._nextSeq();
    const payload: SendMsgPayload = {
      peer_type: 1, // USER
      peer_id: peerId,
      msg_type: 0, // TEXT
      text,
      idempotency_key: this._newIdempotencyKey(),
    };
    this._send({ type: 'send_msg', seq, payload });
    return seq;
  }

  /** 幂等键: 每条消息生成一个 UUID, 服务端据此去重 (重试同一消息时由调用方复用同一 key) */
  private _newIdempotencyKey(): string {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
    return `k-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  /**
   * 已读回执: 告诉服务端"我看到了 up to 这条消息" (对应网关 ClientReadReceiptMessage)
   * max_read_msg_id 传 string — 雪花 ID 59 位超出 JS Number 安全精度 (53 位)
   */
  sendReadReceipt(maxReadMsgId: string | number): number {
    const seq = this._nextSeq();
    const payload: ReadReceiptPayload = {
      peer_type: 1, // USER
      peer_id: 0,   // 网关以鉴权注入的 currentUserId 为准, 不信任此值
      max_read_msg_id: String(maxReadMsgId),
    };
    this._send({ type: 'read', seq, payload });
    return seq;
  }

  /** WebRTC 1v1 信令 (对应 api.js:156-158) */
  sendCallSignal(signalType: string, toUserId: string | number, data: unknown): void {
    const payload: CallSignalPayload = { signal_type: signalType, to_user_id: toUserId, data };
    this._send({ type: 'call_signal', seq: this._nextSeq(), payload });
  }

  /** 语音房间信令 (对应 api.js:160-162) */
  sendRoomSignal(action: string, opts: Record<string, unknown> = {}): void {
    const payload: RoomSignalPayload = { action, ...opts };
    this._send({ type: 'room_signal', seq: this._nextSeq(), payload });
  }

  /** 心跳, 幂等 (对应 api.js:181-185) */
  startPing(intervalMs = 30000): void {
    if (this.pingTimer) return;
    this.pingTimer = setInterval(() => {
      this._send({ type: 'ping', seq: this._nextSeq() });
    }, intervalMs);
  }

  /** 主动断开: 先清 token 再 close(1000), 防止挂起的 3s 重连定时器复活连接 */
  disconnect(): void {
    this.token = null;
    this.authed = false;
    this._rejectAuth(new Error('Disconnected'));
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    if (this.ws) {
      this.ws.close(1000, 'User logout');
      this.ws = null;
    }
  }

  /** token 过期后: 静默续期 → 重连; 续期失败则登出回登录页 */
  private async _refreshAndReconnect(): Promise<void> {
    const renewed = await refreshAuthToken();
    if (!renewed) {
      const { useAppStore } = await import('../store/useAppStore');
      useAppStore.getState().logout();
      return;
    }
    try {
      await this.connect(renewed);
    } catch {
      // 续期后的连接仍失败: 保持断线, 等待用户手动处理
    }
  }

  private _nextSeq(): number {
    return ++this.seq;
  }

  private _send(msg: OutboundMsg): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  /** 入站帧分发 — switch 与旧 api.js:121-153 完全一致 */
  private _handleMessage(msg: { type: string; seq?: number; payload?: unknown }): void {
    switch (msg.type) {
      case 'auth_ok':
        this.emit({ kind: 'auth_ok', payload: (msg.payload as Record<string, unknown>) ?? {} });
        break;
      case 'pong':
        this.emit({ kind: 'pong' });
        break;
      case 'update': {
        // 服务端推送: 新消息 — update_type 原样透传 (缺失时不处理, 与旧代码一致)
        const payload = msg.payload as { update_type?: string | number; data?: unknown };
        console.log('RECEIVED UPDATE:', JSON.stringify(payload));
        this.emit({ kind: 'update', updateType: payload?.update_type, data: payload?.data });
        break;
      }
      case 'rpc_result': {
        // WebSocket RPC 代理的结果 — 保留 seq 用于匹配 (对应 api.js:133-139)
        const payload = msg.payload as { data?: { message_id?: string | number } } | undefined;
        if (payload && payload.data) {
          this.emit({ kind: 'rpc_result', seq: msg.seq ?? 0, data: payload.data });
        }
        break;
      }
      case 'error': {
        console.error('Server error:', msg.payload);
        // 曾认证成功过 (重连场景) 且 token 过期/会话失效 → 静默续期重连
        const code = (msg.payload as { error_code?: number } | undefined)?.error_code;
        if (this.everAuthed && (code === 1002 || code === 1003)) {
          void this._refreshAndReconnect();
          break;
        }
        // auth 被拒时网关回 error (code 1002/1003/1004), 让 connect() reject 而不是挂起
        const message = (msg.payload as { error_message?: string } | undefined)?.error_message;
        this._rejectAuth(new Error(message || 'Auth rejected'));
        this.emit({ kind: 'error', payload: msg.payload });
        break;
      }
      case 'call_signal':
        this.emit({ kind: 'call_signal', payload: msg.payload as Extract<WsEvent, { kind: 'call_signal' }>['payload'] });
        break;
      case 'room_signal':
        this.emit({ kind: 'room_signal', payload: msg.payload as Extract<WsEvent, { kind: 'room_signal' }>['payload'] });
        break;
      case 'kicked':
        console.warn('Kicked:', msg.payload);
        this.emit({ kind: 'kicked', payload: msg.payload });
        break;
    }
  }
}

export const wsManager = new WsManager();
