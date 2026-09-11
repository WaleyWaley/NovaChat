/**
 * NovaChat Web — 全局状态 (Zustand)
 * 对应旧 app.js 的 State 对象 + 散落的 UI 状态。
 * 纯对象不可变更新 (不用 Map); WebSocket/WebRTC 连接对象不在此处。
 */
import { create } from 'zustand';
import { wsManager } from '../api/ws';
import {
  getConversation,
  getDialogs,
  getUserProfile,
  patchProfile,
  removeAvatar,
  setAuthToken,
  setRefreshToken,
  uploadAvatar,
} from '../api/rest';
import {
  loadClearedWatermarks,
  loadDeletedIds,
  loadUserAvatars,
  loadUserNames,
  saveClearedWatermarks,
  saveDeletedIds,
  saveUser,
  saveUserAvatars,
  saveUserNames,
} from '../utils/storage';
import type { Chat, Me, Message, MessageStatus, RoomParticipant, SearchUser } from '../types';

// ===== UI 状态 =====

export interface CallUiState {
  status: 'idle' | 'outgoing' | 'incoming' | 'connected';
  peerId: string | null;
  peerName: string;
  seconds: number;
}

export interface RoomUiState {
  roomId: string | null;
  participants: RoomParticipant[];
  seconds: number;
  invite: { fromName: string; roomId: string } | null;
}

export interface Toast {
  id: number;
  text: string;
  type: 'info' | 'success' | 'error';
}

const IDLE_CALL: CallUiState = { status: 'idle', peerId: null, peerName: '', seconds: 0 };
const IDLE_ROOM: RoomUiState = { roomId: null, participants: [], seconds: 0, invite: null };

// ===== Store =====

interface AppStore {
  // auth
  me: Me | null;
  // chats
  chats: Record<string, Chat>;
  chatOrder: string[];
  activePeerId: string | null;
  userNames: Record<string, string>;
  userAvatars: Record<string, string>;   // Phase 4.3: peerId → 头像文件名
  searchResults: SearchUser[] | null;
  // ui
  toasts: Toast[];
  menuOpen: boolean;
  profileOpen: boolean;                  // Phase 4.3: 个人设置面板
  call: CallUiState;
  room: RoomUiState;

  // actions
  setMe(me: Me | null): void;
  loginFlow(me: Me): Promise<void>;
  logout(): void;
  openChat(peerId: string | number, peerName: string): void;
  closeChat(): void;
  sendMessage(peerId: string | number, text: string): void;
  addOutgoingMessage(peerId: string, seq: number, text: string): void;
  confirmMessage(seq: number, realId: string | number): void;
  addIncomingMessage(peerId: string, msg: { message_id: string; text: string; created_at: number }): void;
  markActiveChatRead(): void;
  markMessagesReceived(maxReadMsgId: string): void;
  loadHistory(): Promise<void>;
  upsertUserName(peerId: string, name: string): void;
  upsertPeerAvatar(peerId: string, avatarId: string): void;
  resolvePeerName(peerId: string): Promise<void>;
  refreshSelfProfile(): Promise<void>;      // Phase 4.3: 登录后补拉自己的完整资料
  updateMyName(firstName: string): Promise<boolean>;
  uploadMyAvatar(file: File): Promise<boolean>;
  removeMyAvatar(): Promise<boolean>;
  deleteMessage(peerId: string, messageId: string): void;    // Phase 4.3: 本端删除单条
  clearChatHistory(peerId: string): void;                    // Phase 4.3: 清空会话记录
  setSearchResults(users: SearchUser[] | null): void;
  showToast(text: string, type?: Toast['type']): void;
  dismissToast(id: number): void;
  setMenuOpen(open: boolean): void;
  setProfileOpen(open: boolean): void;
  setCallState(patch: Partial<CallUiState>): void;
  setRoomState(patch: Partial<RoomUiState>): void;
  resetChatState(): void;
}

let toastSeq = 0;

export const useAppStore = create<AppStore>()((set, get) => ({
  me: null,
  chats: {},
  chatOrder: [],
  activePeerId: null,
  userNames: loadUserNames(),
  userAvatars: loadUserAvatars(),
  searchResults: null,
  toasts: [],
  menuOpen: false,
  profileOpen: false,
  call: IDLE_CALL,
  room: IDLE_ROOM,

  setMe: (me) => {
    setAuthToken(me ? me.access_token : null);
    setRefreshToken(me ? (me.refresh_token ?? null) : null);
    saveUser(me);
    set({ me });
  },

  /** 登录编排 (对应 app.js doConnect): WS 连接成功后才设置 me, 失败则停在登录页 */
  loginFlow: async (me) => {
    // 先给 REST 层挂上 token (即使 WS 稍后失败, REST 也不该用旧 token)
    setAuthToken(me.access_token);
    setRefreshToken(me.refresh_token ?? null);
    const payload = await wsManager.connect(me.access_token);
    saveUser(me);
    set({ me: { ...me, ...payload } }); // auth_ok payload 合并进用户信息 (对应 app.js:135)
    wsManager.startPing();
    void get().loadHistory();          // Phase 4.2: 从服务端恢复会话历史
    void get().refreshSelfProfile();   // Phase 4.3: 补拉头像等完整资料
  },

  logout: () => {
    wsManager.disconnect();
    setAuthToken(null);
    setRefreshToken(null);
    saveUser(null);
    get().resetChatState();
    set({ me: null });
  },

  openChat: (peerId, peerName) => {
    const pid = String(peerId);
    const { chats, chatOrder } = get();
    const chats2 = { ...chats };
    if (!chats2[pid]) {
      chats2[pid] = { peerId: pid, peerName, messages: [], unread: 0 };
    } else {
      chats2[pid] = { ...chats2[pid], peerName, unread: 0 };
    }
    set({
      activePeerId: pid,
      chats: chats2,
      chatOrder: chats[pid] ? chatOrder : [pid, ...chatOrder],
      searchResults: null,
    });
    get().upsertUserName(pid, peerName);
    // 打开会话时重查对方资料 — 名字/头像缓存命中则内部直接跳过,
    // 对方刚换了头像时这里能立刻发现 (否则要等刷新页面)
    void get().resolvePeerName(pid);
    get().markActiveChatRead();   // 打开会话即把已展示的消息标记已读
  },

  closeChat: () => set({ activePeerId: null }),

  /** 发送: 同步写入乐观消息再发 WS (顺序保证: rpc_result 不可能抢先) */
  sendMessage: (peerId, text) => {
    const seq = wsManager.sendMessage(peerId, text);
    get().addOutgoingMessage(String(peerId), seq, text);
  },

  addOutgoingMessage: (peerId, seq, text) => {
    const { me, chats, chatOrder } = get();
    const tempId = 'temp_' + seq;
    const msg: Message = {
      message_id: tempId,
      from_peer: { id: String(me?.user_id ?? 0) },
      text,
      created_at: Date.now(),
      is_me: true,
      status: 'sending' as MessageStatus,
    };
    const chat = chats[peerId];
    const chats2 = { ...chats };
    chats2[peerId] = chat
      ? { ...chat, messages: [...chat.messages, msg] }
      : { peerId, peerName: get().userNames[peerId] ?? 'User ' + peerId.slice(-6), messages: [msg], unread: 0 };
    set({
      chats: chats2,
      chatOrder: chat ? chatOrder : [peerId, ...chatOrder],
    });
  },

  /** rpc_result 回执: 遍历所有会话找 temp_<seq> → 换真实 id (对应 app.js:376-391) */
  confirmMessage: (seq, realId) => {
    const tempId = 'temp_' + seq;
    const newId = String(realId || 'sent_' + seq);
    const { chats } = get();
    const chats2 = { ...chats };
    for (const [pid, chat] of Object.entries(chats)) {
      const idx = chat.messages.findIndex((m) => String(m.message_id) === tempId);
      if (idx >= 0) {
        const messages = [...chat.messages];
        messages[idx] = { ...messages[idx], message_id: newId, status: 'sent' as MessageStatus };
        chats2[pid] = { ...chat, messages };
        break;
      }
    }
    set({ chats: chats2 });
  },

  addIncomingMessage: (peerId, msg) => {
    const { chats, chatOrder, activePeerId, userNames } = get();
    const chat = chats[peerId];
    // 去重 (对应 app.js:442)
    if (chat && chat.messages.some((m) => String(m.message_id) === msg.message_id)) return;

    const incoming: Message = {
      message_id: msg.message_id,
      from_peer: { id: peerId },
      text: msg.text,
      created_at: msg.created_at,
      is_me: false,
    };
    const chats2 = { ...chats };
    if (chat) {
      const unread = activePeerId === peerId ? 0 : chat.unread + 1;
      chats2[peerId] = { ...chat, messages: [...chat.messages, incoming], unread };
    } else {
      const peerName = userNames[peerId] ?? 'User ' + peerId.slice(-6);
      chats2[peerId] = { peerId, peerName, messages: [incoming], unread: activePeerId === peerId ? 0 : 1 };
    }
    set({
      chats: chats2,
      chatOrder: chat ? chatOrder : [peerId, ...chatOrder],
    });
    // 当前正在看这个对话 → 消息已上屏, 立即回执已读
    if (activePeerId === peerId) get().markActiveChatRead();
  },

  /**
   * 已读回执: 取当前对话中"对方发来的、已上屏"的最大 message_id,
   * 发 WS read 消息给网关 → message-service 批量 ACK (message_id <= max)
   */
  markActiveChatRead: () => {
    const { activePeerId, chats } = get();
    if (!activePeerId) return;
    const chat = chats[activePeerId];
    if (!chat) return;

    // 消息按到达顺序追加 → 从尾部找最后一条对方消息即为最大已展示 ID
    for (let i = chat.messages.length - 1; i >= 0; i--) {
      const m = chat.messages[i];
      if (m.is_me) continue;                 // 只 ack 对方发来的消息
      if (m.message_id.startsWith('temp_')) continue;   // 跳过本地临时 ID
      wsManager.sendReadReceipt(m.message_id);
      return;
    }
  },

  /**
   * 已读回执: 对方读了"up to maxReadMsgId"的消息,
   * 把我发出的、id <= maxReadMsgId、状态为 'sent' 的消息全部升级为 'received' (✓✓)
   */
  markMessagesReceived: (maxReadMsgId) => {
    let maxId: bigint;
    try {
      maxId = BigInt(maxReadMsgId);
    } catch {
      return;   // 非法 ID, 忽略
    }
    const { chats } = get();
    const chats2 = { ...chats };
    let changed = false;
    for (const [pid, chat] of Object.entries(chats)) {
      let cChanged = false;
      const messages = chat.messages.map((m) => {
        if (m.is_me && m.status === 'sent' && !m.message_id.startsWith('temp_')) {
          try {
            if (BigInt(m.message_id) <= maxId) {
              cChanged = true;
              return { ...m, status: 'received' as MessageStatus };
            }
          } catch {
            // 非数字 ID 跳过
          }
        }
        return m;
      });
      if (cChanged) {
        chats2[pid] = { ...chat, messages };
        changed = true;
      }
    }
    if (changed) set({ chats: chats2 });
  },

  /**
   * 历史恢复 (Phase 4.2): 登录后从服务端拉取会话列表 + 每个会话最近 50 条双向历史
   * 与本地已有消息合并去重, 不覆盖实时到达的新消息
   */
  loadHistory: async () => {
    const me = get().me;
    if (!me) return;
    const myId = String(me.user_id);

    try {
      const dialogsResp = await getDialogs();
      const dialogs = dialogsResp.dialogs ?? [];
      const chats2: Record<string, Chat> = { ...get().chats };

      for (const d of dialogs) {
        const pid = String(d.peer_id);
        try {
          const conv = await getConversation(pid, 50, 0);
          const historyMsgs: Message[] = (conv.messages ?? [])
            .map((m) => {
              const fromId = String(m.from_peer?.id ?? '0');
              // 服务器枚举序列化为名称 ("MESSAGE_STATUS_READ") 或数字 (3)
              const isRead = m.status === 'MESSAGE_STATUS_READ' ||
                m.status === 3 ||
                (typeof m.status === 'number' && m.status >= 2);
              return {
                message_id: String(m.message_id),
                from_peer: { id: fromId },
                text: m.text ?? '',
                created_at: m.created_at ?? Date.now(),
                is_me: fromId === myId,
                status: fromId === myId
                  ? (isRead ? 'received' : 'sent')
                  : undefined,
              } as Message;
            })
            .reverse();   // 服务器降序返回, 前端按时间升序渲染

          // Phase 4.3: 本端删除过滤 — 墓碑 id (单条删除) + 清空水位线 (清空聊天记录)。
          // 只过滤服务端历史, 绝不过滤 existing.messages (那是本会话实时消息)
          const deleted = new Set(loadDeletedIds()[pid] ?? []);
          const watermark = loadClearedWatermarks()[pid];
          const filtered = historyMsgs.filter((m) => {
            if (deleted.has(String(m.message_id))) return false;
            if (watermark) {
              try {
                if (BigInt(m.message_id) <= BigInt(watermark)) return false;
              } catch { /* 非数字 id 保留 */ }
            }
            return true;
          });

          const existing = chats2[pid];
          if (existing && existing.messages.length > 0) {
            // 合并去重: 历史 + 本地已有, 按 message_id 排序
            const seen = new Set(existing.messages.map((m) => String(m.message_id)));
            const merged = [
              ...filtered.filter((m) => !seen.has(String(m.message_id))),
              ...existing.messages,
            ].sort((a, b) => {
              try { return Number(BigInt(a.message_id) - BigInt(b.message_id)); } catch { return 0; }
            });
            chats2[pid] = { ...existing, messages: merged };
          } else if (filtered.length > 0) {
            chats2[pid] = {
              peerId: pid,
              peerName: get().userNames[pid] ?? 'User ' + pid.slice(-6),
              messages: historyMsgs,
              unread: 0,   // 历史消息默认已读
            };
          }
        } catch (err) {
          console.error('loadHistory conversation failed for', pid, err);
        }
      }

      // 会话顺序: 按服务端 latest_msg_id 降序
      const latestByPeer = new Map(dialogs.map((d) => [String(d.peer_id), String(d.latest_msg_id)]));
      const order = Object.keys(chats2)
        .filter((pid) => chats2[pid]?.messages.length > 0)
        .sort((a, b) => {
          try {
            return Number(BigInt(latestByPeer.get(b) ?? '0') - BigInt(latestByPeer.get(a) ?? '0'));
          } catch { return 0; }
        });

      set({ chats: chats2, chatOrder: order });

      // 异步补真实用户名/头像 (resolvePeerName 内部按两个缓存独立判断,
      // 名字+真实头像都已缓存时零开销直接返回)
      for (const pid of order) {
        void get().resolvePeerName(pid);
      }
    } catch (err) {
      console.error('loadHistory failed:', err);
    }
  },

  upsertUserName: (peerId, name) => {
    const userNames = { ...get().userNames, [peerId]: name };
    // 同步更新会话记录里的显示名 (对应 app.js updatePeerNames:491-492)
    const chat = get().chats[peerId];
    const chats =
      chat && chat.peerName !== name
        ? { ...get().chats, [peerId]: { ...chat, peerName: name } }
        : get().chats;
    saveUserNames(userNames);
    set({ userNames, chats });
  },

  /** Phase 4.3: 缓存 peer 的头像文件名 (空串也缓存 = 已知对方无头像) */
  upsertPeerAvatar: (peerId, avatarId) => {
    const userAvatars = { ...get().userAvatars, [peerId]: avatarId };
    saveUserAvatars(userAvatars);
    set({ userAvatars });
  },

  /** 异步查真实用户名+头像 (对应 app.js:421-440); 两个缓存独立判断 */
  resolvePeerName: async (peerId) => {
    const hasName = !!get().userNames[peerId];
    // 头像缓存只在缓存了"真实头像"时才跳过 — 空串不计数, 每次都重查。
    // 原因: 对方换头像是"对端设备上传, 本端收不到任何通知", 只能靠重查发现。
    // 若把空串当缓存, 对方从无头像 → 有头像的转变本端永远看不到
    const hasAvatar = !!get().userAvatars[peerId];
    if (hasName && hasAvatar) return;
    try {
      const p = await getUserProfile(peerId);
      const user = (p as {
        user?: { first_name?: string; username?: string; avatar_photo_id?: string };
      }).user;
      if (!user) return;
      if (!hasName && (user.username || user.first_name)) {
        get().upsertUserName(peerId, user.first_name || user.username || peerId);
      }
      // 头像无条件更新 (无 → 有 / 旧 → 新)
      if (typeof user.avatar_photo_id === 'string') {
        get().upsertPeerAvatar(peerId, user.avatar_photo_id);
      }
    } catch {
      // 名字解析失败静默 (与旧行为一致)
    }
  },

  /**
   * Phase 4.3: 登录/恢复会话后拉取自己的完整资料 (登录响应只有 user_id/first_name,
   * 没有头像), 合并进 me 并持久化
   */
  refreshSelfProfile: async () => {
    const me = get().me;
    if (!me) return;
    try {
      const p = await getUserProfile(String(me.user_id));
      const user = (p as {
        user?: { first_name?: string; username?: string; avatar_photo_id?: string };
      }).user;
      if (user) {
        get().setMe({
          ...get().me!,
          first_name: user.first_name || get().me!.first_name,
          avatar_photo_id: typeof user.avatar_photo_id === 'string' ? user.avatar_photo_id : undefined,
        });
      }
    } catch {
      // 静默: 拉不到完整资料不影响登录
    }
  },

  /** Phase 4.3: 修改显示名 (PATCH /api/users/me) */
  updateMyName: async (firstName) => {
    try {
      const resp = await patchProfile({ first_name: firstName });
      if (resp.error_code && resp.error_code !== 0) {
        get().showToast(resp.error_message || 'Update failed', 'error');
        return false;
      }
      const newName = resp.user?.first_name || firstName;
      get().setMe({ ...get().me!, first_name: newName });
      get().showToast('✅ Name updated', 'success');
      return true;
    } catch (err) {
      get().showToast(err instanceof Error ? err.message : 'Update failed', 'error');
      return false;
    }
  },

  /** Phase 4.3: 上传头像 (multipart → 网关落盘 → avatar_photo_id) */
  uploadMyAvatar: async (file) => {
    try {
      const resp = await uploadAvatar(file);
      if (resp.error_code && resp.error_code !== 0) {
        get().showToast(resp.error_message || 'Upload failed', 'error');
        return false;
      }
      get().setMe({ ...get().me!, avatar_photo_id: resp.avatar_photo_id });
      get().showToast('✅ Avatar updated', 'success');
      return true;
    } catch (err) {
      get().showToast(err instanceof Error ? err.message : 'Upload failed', 'error');
      return false;
    }
  },

  /** Phase 4.3: 移除头像 */
  removeMyAvatar: async () => {
    try {
      const resp = await removeAvatar();
      if (resp.error_code && resp.error_code !== 0) {
        get().showToast(resp.error_message || 'Remove failed', 'error');
        return false;
      }
      get().setMe({ ...get().me!, avatar_photo_id: '' });
      get().showToast('✅ Avatar removed', 'success');
      return true;
    } catch (err) {
      get().showToast(err instanceof Error ? err.message : 'Remove failed', 'error');
      return false;
    }
  },

  /**
   * Phase 4.3: 本端删除单条消息 (纯前端: 不动服务器、不推对方)。
   * 真实 id 记入 localStorage 墓碑, loadHistory 拉历史时过滤 → 刷新不复活
   */
  deleteMessage: (peerId, messageId) => {
    const { chats } = get();
    const chat = chats[peerId];
    if (!chat) return;
    set({
      chats: {
        ...chats,
        [peerId]: { ...chat, messages: chat.messages.filter((m) => m.message_id !== messageId) },
      },
    });
    // 本地假 id (temp_/sent_) 服务端没有, 无需墓碑
    if (messageId.startsWith('temp_') || messageId.startsWith('sent_')) return;
    const deleted = loadDeletedIds();
    const list = deleted[peerId] ?? [];
    deleted[peerId] = [...list, messageId].slice(-1000); // 封顶防膨胀
    saveDeletedIds(deleted);
  },

  /**
   * Phase 4.3: 清空某会话的聊天记录 (纯前端)。
   * 记录水位线 = 当前最大 message_id; 历史中 <= 水位线的消息不再加载;
   * 之后对方新发的消息 (id > 水位线) 正常出现
   */
  clearChatHistory: (peerId) => {
    const { chats, chatOrder } = get();
    const chat = chats[peerId];
    if (!chat) return;
    let maxId: string | undefined;
    for (const m of chat.messages) {
      try {
        const b = BigInt(m.message_id);
        if (maxId === undefined || b > BigInt(maxId)) maxId = m.message_id;
      } catch { /* 忽略非数字 id */ }
    }
    if (maxId !== undefined) {
      const watermarks = loadClearedWatermarks();
      watermarks[peerId] = maxId;
      saveClearedWatermarks(watermarks);
    }
    set({
      chats: { ...chats, [peerId]: { ...chat, messages: [] } },
      // 从侧栏移除 (保留 chats 条目, 当前窗口继续显示空列表)
      chatOrder: chatOrder.filter((p) => p !== peerId),
    });
  },

  setSearchResults: (users) => set({ searchResults: users }),

  showToast: (text, type = 'info') => {
    const id = ++toastSeq;
    set({ toasts: [...get().toasts, { id, text, type }] });
    setTimeout(() => get().dismissToast(id), 2500);
  },

  dismissToast: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),

  setMenuOpen: (open) => set({ menuOpen: open }),

  setProfileOpen: (open) => set({ profileOpen: open }),

  setCallState: (patch) => set({ call: { ...get().call, ...patch } }),

  setRoomState: (patch) => set({ room: { ...get().room, ...patch } }),

  /** 登出时清空会话 (保留 nc_names/nc_avatars, 与旧行为一致 — app.js:882-898) */
  resetChatState: () =>
    set({
      chats: {},
      chatOrder: [],
      activePeerId: null,
      searchResults: null,
      call: IDLE_CALL,
      room: IDLE_ROOM,
      menuOpen: false,
      profileOpen: false,
    }),
}));
