/**
 * NovaChat Web — 全局状态 (Zustand)
 * 对应旧 app.js 的 State 对象 + 散落的 UI 状态。
 * 纯对象不可变更新 (不用 Map); WebSocket/WebRTC 连接对象不在此处。
 */
import { create } from 'zustand';
import { wsManager } from '../api/ws';
import { getUserProfile, setAuthToken } from '../api/rest';
import { loadUserNames, saveUser, saveUserNames } from '../utils/storage';
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
  searchResults: SearchUser[] | null;
  // ui
  toasts: Toast[];
  menuOpen: boolean;
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
  upsertUserName(peerId: string, name: string): void;
  resolvePeerName(peerId: string): Promise<void>;
  setSearchResults(users: SearchUser[] | null): void;
  showToast(text: string, type?: Toast['type']): void;
  dismissToast(id: number): void;
  setMenuOpen(open: boolean): void;
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
  searchResults: null,
  toasts: [],
  menuOpen: false,
  call: IDLE_CALL,
  room: IDLE_ROOM,

  setMe: (me) => {
    setAuthToken(me ? me.access_token : null);
    saveUser(me);
    set({ me });
  },

  /** 登录编排 (对应 app.js doConnect): WS 连接成功后才设置 me, 失败则停在登录页 */
  loginFlow: async (me) => {
    const payload = await wsManager.connect(me.access_token);
    setAuthToken(me.access_token);
    saveUser(me);
    set({ me: { ...me, ...payload } }); // auth_ok payload 合并进用户信息 (对应 app.js:135)
    wsManager.startPing();
  },

  logout: () => {
    wsManager.disconnect();
    setAuthToken(null);
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

  /** 异步查真实用户名 (对应 app.js:421-440); 已缓存则跳过 */
  resolvePeerName: async (peerId) => {
    if (get().userNames[peerId]) return;
    try {
      const p = await getUserProfile(peerId);
      const user = (p as { user?: { first_name?: string; username?: string } }).user;
      if (user && (user.username || user.first_name)) {
        get().upsertUserName(peerId, user.first_name || user.username || peerId);
      }
    } catch {
      // 名字解析失败静默 (与旧行为一致)
    }
  },

  setSearchResults: (users) => set({ searchResults: users }),

  showToast: (text, type = 'info') => {
    const id = ++toastSeq;
    set({ toasts: [...get().toasts, { id, text, type }] });
    setTimeout(() => get().dismissToast(id), 2500);
  },

  dismissToast: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),

  setMenuOpen: (open) => set({ menuOpen: open }),

  setCallState: (patch) => set({ call: { ...get().call, ...patch } }),

  setRoomState: (patch) => set({ room: { ...get().room, ...patch } }),

  /** 登出时清空会话 (保留 nc_names, 与旧行为一致 — app.js:882-898) */
  resetChatState: () =>
    set({
      chats: {},
      chatOrder: [],
      activePeerId: null,
      searchResults: null,
      call: IDLE_CALL,
      room: IDLE_ROOM,
      menuOpen: false,
    }),
}));
