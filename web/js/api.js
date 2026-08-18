/**
 * NovaChat Web — API 层 (REST + WebSocket)
 */

const API = {
  // ---- 配置 ----
  _baseUrl: '',     // 同源, 通过 nginx 代理
  _wsUrl: '',       // WebSocket URL
  _ws: null,
  _wsSeq: 0,
  _wsHandlers: {},
  _messageHandler: null,

  init(baseUrl) {
    this._baseUrl = baseUrl;
    // WebSocket: 同 host, /ws 路径
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    this._wsUrl = `${proto}//${location.host}/ws`;
  },

  // ===== REST API =====

  async _post(path, body) {
    const headers = { 'Content-Type': 'application/json' };
    if (this._token) headers['Authorization'] = `Bearer ${this._token}`;
    const res = await fetch(`${this._baseUrl}${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  },

  async register(username, password, firstName, lastName) {
    return this._post('/api/auth/register', {
      username, password, first_name: firstName, last_name: lastName || ''
    });
  },

  async login(username, password) {
    return this._post('/api/auth/login', { username, password });
  },

  async getUserProfile(username) {
    return this._post('/api/user/profile', { username });
  },

  async getUserProfile(idOrName) {
    const body = /^\d+$/.test(String(idOrName))
      ? { user_id: Number(idOrName) }
      : { username: String(idOrName) };
    // 直连 user-service 不需要网关 JWT
    try {
      const res = await fetch('/api/user/profile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      return res.json();
    } catch { return {}; }
  },

  async searchUsers(query, limit = 20) {
    return this._post('/api/user/search', { query, limit });
  },

  // ===== WebSocket =====

  connect(accessToken) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this._wsUrl);
      ws.onopen = () => {
        this._ws = ws;
        // 发送认证
        this._send({ type: 'auth', seq: this._nextSeq(), payload: { access_token: accessToken } });
      };
      ws.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data);
          this._handleMessage(msg);
          if (msg.type === 'auth_ok') resolve(msg.payload);
        } catch (err) {
          console.error('WS parse error:', err);
        }
      };
      ws.onerror = (err) => { console.error('WS error:', err); reject(err); };
      ws.onclose = (e) => {
        console.log('WS closed:', e.code, e.reason);
        this._ws = null;
        // 自动重连
        if (e.code !== 1000 && e.code !== 4001) {
          setTimeout(() => {
            if (API._token) API.connect(API._token);
          }, 3000);
        }
      };
    });
  },

  _token: null,

  onMessage(handler) { this._messageHandler = handler; },

  _nextSeq() { return ++this._wsSeq; },

  _send(msg) {
    if (this._ws && this._ws.readyState === WebSocket.OPEN) {
      this._ws.send(JSON.stringify(msg));
    }
  },

  _handleMessage(msg) {
    switch (msg.type) {
      case 'auth_ok':
        break;
      case 'pong':
        break;
      case 'update':
        // 服务端推送: 新消息
        console.log('RECEIVED UPDATE:', JSON.stringify(msg.payload));
        if (this._messageHandler) this._messageHandler(msg.payload);
        break;
      case 'rpc_result':
        // WebSocket RPC 代理的结果 — 保留 seq 用于匹配
        if (msg.payload && msg.payload.data) {
          if (this._messageHandler) this._messageHandler({
            rpc_result: { ...msg.payload, seq: msg.seq }
          });
        }
        break;
      case 'error':
        console.error('Server error:', msg.payload);
        break;
      case 'call_signal':
        if (this._messageHandler) this._messageHandler({ call_signal: msg.payload });
        break;
      case 'room_signal':
        if (this._messageHandler) this._messageHandler({ room_signal: msg.payload });
        break;
      case 'kicked':
        console.warn('Kicked:', msg.payload);
        break;
    }
  },

  // Phase 4: WebRTC 信令
  sendCallSignal(signalType, toUserId, data) {
    this._send({ type: 'call_signal', seq: this._nextSeq(), payload: { signal_type: signalType, to_user_id: toUserId, data } });
  },
  // Phase 4.1: 房间信令
  sendRoomSignal(action, opts = {}) {
    this._send({ type: 'room_signal', seq: this._nextSeq(), payload: { action, ...opts } });
  },

  // 通过 WebSocket RPC 代理发消息
  sendMessage(peerId, text) {
    const seq = this._nextSeq();
    this._send({
      type: 'send_msg',
      seq,
      payload: {
        peer_type: 1, // USER
        peer_id: peerId,
        msg_type: 0,  // TEXT
        text,
      }
    });
    return seq;
  },

  // 心跳
  startPing(intervalMs = 30000) {
    setInterval(() => {
      this._send({ type: 'ping', seq: this._nextSeq() });
    }, intervalMs);
  },

  disconnect() {
    if (this._ws) {
      this._ws.close(1000, 'User logout');
      this._ws = null;
    }
  }
};
