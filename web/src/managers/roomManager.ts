/**
 * 多人语音房间 (mesh WebRTC) 状态机 — 移植 app.js:698-873
 * 模块级单例; peerConns Map 留在 React 之外 (不参与渲染);
 * UI 状态 (roomId/participants/seconds/invite) 经 setRoomState 推入 store。
 */
import { wsManager } from '../api/ws';
import { useAppStore } from '../store/useAppStore';
import { ensureMicStream, releaseMicStream, RTC_CONFIG } from './media';
import type { RoomParticipant, WsEvent } from '../types';

type RoomSignal = Extract<WsEvent, { kind: 'room_signal' }>['payload'];
type RoomWebrtc = NonNullable<RoomSignal['webrtc']>;

let roomId: string | null = null;
let participants: RoomParticipant[] = [];
const peerConns = new Map<string, RTCPeerConnection>();
let roomStartTime = 0;
let roomTimer: ReturnType<typeof setInterval> | null = null;

const store = () => useAppStore.getState();

function isInRoom(): boolean {
  return !!roomId;
}

function startRoomTimer(): void {
  if (roomTimer) return;
  roomStartTime = Date.now();
  const timer = setInterval(() => {
    if (!roomId) {
      clearInterval(timer);
      roomTimer = null;
      return;
    }
    const sec = Math.floor((Date.now() - roomStartTime) / 1000);
    store().setRoomState({ seconds: sec });
  }, 1000);
  roomTimer = timer;
}

/** 🔊 按钮: 未入房创建, 已入房退出 (对应 app.js:701-705) */
function toggle(): void {
  if (roomId) {
    leaveRoom();
    return;
  }
  wsManager.sendRoomSignal('create');
}

function join(roomIdToJoin: string): void {
  wsManager.sendRoomSignal('join', { room_id: roomIdToJoin });
}

function invite(userIds: string[]): void {
  if (!roomId) return;
  wsManager.sendRoomSignal('invite', { room_id: roomId, invite_user_ids: userIds });
}

function leaveRoom(): void {
  if (roomId) {
    wsManager.sendRoomSignal('leave', { room_id: roomId });
    peerConns.forEach((conn) => conn.close());
    peerConns.clear();
  }
  roomId = null;
  participants = [];
  if (roomTimer) {
    clearInterval(roomTimer);
    roomTimer = null;
  }
  roomStartTime = 0;
  releaseMicStream();
  store().setRoomState({ roomId: null, participants: [], seconds: 0, invite: null });
}

/** 入站房间信令分发 (对应 app.js:707-738) */
function handleSignal(sig: RoomSignal): void {
  const { action, room_id, from_user_id, from_username, participants: parts, webrtc } = sig;

  if (action === 'created' || action === 'joined') {
    roomId = room_id ?? null;
    participants = parts ?? [];
    startRoomTimer();
    store().setRoomState({ roomId, participants });
    if (action === 'joined' && parts) {
      for (const p of parts) {
        if (String(p.userId) === String(store().me?.user_id)) continue;
        void createPeerForRoom(String(p.userId), p.username, true);
      }
    }
  } else if (action === 'user_joined') {
    participants = parts ?? participants;
    if (from_user_id && String(from_user_id) !== String(store().me?.user_id)) {
      void createPeerForRoom(String(from_user_id), from_username || 'User', false);
    }
    store().setRoomState({ participants });
  } else if (action === 'user_left') {
    participants = parts ?? participants;
    if (from_user_id) closePeer(String(from_user_id));
    store().setRoomState({ participants });
    // 只剩自己时自动退房 (对应 app.js:730-732; 统一转字符串比较)
    if (
      participants.length <= 1 &&
      String(participants[0]?.userId ?? '') === String(store().me?.user_id)
    ) {
      leaveRoom();
    }
  } else if (action === 'webrtc' && webrtc) {
    void handleRoomWebRTC(webrtc);
  } else if (action === 'invited') {
    store().setRoomState({ invite: { fromName: from_username || 'User', roomId: room_id ?? '' } });
  }
}

/** 与房间内某成员建立 mesh peer 连接 (对应 app.js:804-825) */
async function createPeerForRoom(peerId: string, _peerName: string, createOffer: boolean): Promise<void> {
  if (peerConns.has(peerId)) return;
  try {
    const stream = await ensureMicStream();
    const conn = new RTCPeerConnection(RTC_CONFIG);
    stream.getTracks().forEach((t) => conn.addTrack(t, stream));
    conn.onicecandidate = (e) => {
      if (e.candidate) {
        wsManager.sendRoomSignal('webrtc', {
          room_id: roomId,
          webrtc: { signal_type: 'ice_candidate', to_user_id: peerId, data: { candidate: e.candidate } },
        });
      }
    };
    conn.ontrack = (e) => {
      const a = new Audio();
      a.srcObject = e.streams[0];
      a.play().catch(() => {});
    };
    peerConns.set(peerId, conn);
    if (createOffer) {
      const offer = await conn.createOffer();
      await conn.setLocalDescription(offer);
      wsManager.sendRoomSignal('webrtc', {
        room_id: roomId,
        webrtc: { signal_type: 'offer', to_user_id: peerId, data: { sdp: offer } },
      });
    }
  } catch (e) {
    console.error(e);
  }
}

/** mesh WebRTC 信令 (对应 app.js:827-851) */
async function handleRoomWebRTC(w: RoomWebrtc): Promise<void> {
  const peerId = String(w.from_user_id);
  const d = w.data as { sdp?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit };

  if (w.signal_type === 'offer') {
    if (!d.sdp) return;
    let conn = peerConns.get(peerId);
    if (!conn) {
      conn = new RTCPeerConnection(RTC_CONFIG);
      const stream = await ensureMicStream();
      stream.getTracks().forEach((t) => conn!.addTrack(t, stream));
      conn.onicecandidate = (e) => {
        if (e.candidate) {
          wsManager.sendRoomSignal('webrtc', {
            room_id: roomId,
            webrtc: { signal_type: 'ice_candidate', to_user_id: peerId, data: { candidate: e.candidate } },
          });
        }
      };
      conn.ontrack = (e) => {
        const a = new Audio();
        a.srcObject = e.streams[0];
        a.play().catch(() => {});
      };
      peerConns.set(peerId, conn);
    }
    await conn.setRemoteDescription(new RTCSessionDescription(d.sdp));
    const answer = await conn.createAnswer();
    await conn.setLocalDescription(answer);
    wsManager.sendRoomSignal('webrtc', {
      room_id: roomId,
      webrtc: { signal_type: 'answer', to_user_id: peerId, data: { sdp: answer } },
    });
  } else if (w.signal_type === 'answer') {
    if (!d.sdp) return;
    const conn = peerConns.get(peerId);
    if (conn) conn.setRemoteDescription(new RTCSessionDescription(d.sdp)).catch(() => {});
  } else if (w.signal_type === 'ice_candidate' && d.candidate) {
    const conn = peerConns.get(peerId);
    if (conn) conn.addIceCandidate(new RTCIceCandidate(d.candidate)).catch(() => {});
  }
}

function closePeer(peerId: string): void {
  const conn = peerConns.get(peerId);
  if (conn) {
    conn.close();
    peerConns.delete(peerId);
  }
}

export const roomManager = {
  toggle,
  join,
  invite,
  leaveRoom,
  handleSignal,
  isInRoom,
};
