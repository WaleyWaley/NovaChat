/**
 * 1v1 WebRTC 通话状态机 (移植 app.js:518-696)
 * 模块级单例, 位于 React 之外; UI 状态经 setCallState 推入 store。
 * 修复旧 bug: 'answer' 分支引用未定义的 peerId (app.js:615) → 改用 currentCallPeerId。
 */
import { wsManager } from '../api/ws';
import { useAppStore } from '../store/useAppStore';
import { roomManager } from './roomManager';
import { ensureMicStream, releaseMicStream, RTC_CONFIG } from './media';
import type { WsEvent } from '../types';

type CallSignal = Extract<WsEvent, { kind: 'call_signal' }>['payload'];

let pc: RTCPeerConnection | null = null;
let currentCallPeerId: string | null = null;
let pendingOffer: unknown = null; // 呼入 call_start 携带的 offer, 供 accept() 使用
let timer: ReturnType<typeof setInterval> | null = null;

const store = () => useAppStore.getState();

function playRemote(e: RTCTrackEvent): void {
  const audio = new Audio();
  audio.srcObject = e.streams[0];
  audio.play().catch(() => {});
}

function startTimer(): void {
  if (timer) clearInterval(timer);
  store().setCallState({ seconds: 0 });
  timer = setInterval(() => {
    store().setCallState({ seconds: store().call.seconds + 1 });
  }, 1000);
}

function stopTimer(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

/**
 * 创建 peer 连接并同步挂载音轨。
 * ⚠️ addTrack 必须在 createOffer/createAnswer 之前同步完成,
 * 否则 offer 里没有音轨, 对方 ontrack 永不触发 → 接通了但听不见声音。
 * (旧 app.js 是 await getUserMedia 后同步 addTrack, 移植时误改成异步导致此 bug)
 */
function makePeerConnection(peerId: string, stream: MediaStream): RTCPeerConnection {
  const conn = new RTCPeerConnection(RTC_CONFIG);
  stream.getTracks().forEach((t) => conn.addTrack(t, stream));
  conn.onicecandidate = (e) => {
    if (e.candidate) wsManager.sendCallSignal('ice_candidate', peerId, { candidate: e.candidate });
  };
  conn.ontrack = playRemote;
  return conn;
}

/** 呼出 (对应 app.js:541-560 + setupCallButton) */
async function startCall(peerId: string, peerName: string): Promise<void> {
  if (pc) {
    hangUp();
    return;
  }
  currentCallPeerId = peerId;
  try {
    const stream = await ensureMicStream();
    pc = makePeerConnection(peerId, stream);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    console.log('Sending call_start to', peerId);
    wsManager.sendCallSignal('call_start', peerId, { sdp: offer });
    store().setCallState({ status: 'outgoing', peerId, peerName });
    startTimer();
  } catch (err) {
    alert('Microphone access denied: ' + (err as Error).message);
    currentCallPeerId = null;
  }
}

/** 应答呼入 (accept 与 call_answer_accept 共用, 对应 app.js:591-610 + acceptCall) */
async function answerIncoming(peerId: string, sdp: unknown): Promise<void> {
  try {
    const stream = await ensureMicStream();
    pc = makePeerConnection(peerId, stream);
    await pc.setRemoteDescription(new RTCSessionDescription((sdp as { sdp: RTCSessionDescriptionInit }).sdp));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    wsManager.sendCallSignal('answer', peerId, { sdp: answer });
    store().setCallState({ status: 'connected', peerId });
  } catch (e) {
    console.error(e);
    hangUp();
  }
}

/** 入站信令分发 (对应 app.js:562-621) */
function handleSignal(sig: CallSignal): void {
  const { signal_type, from_user_id, from_username, data } = sig;
  const peerId = String(from_user_id);

  // 呼入: 显示接听界面
  if (signal_type === 'call_start' && !pc) {
    currentCallPeerId = peerId;
    pendingOffer = data;
    store().setCallState({ status: 'incoming', peerId, peerName: from_username || 'User' });
    return;
  }
  // 忙线时忽略第二个呼入 (对应 app.js:611)
  if (signal_type === 'call_start' && pc) return;

  // 我们发出的呼叫被对方接受 (兼容旧协议的 call_answer_accept)
  if (signal_type === 'call_answer_accept' && !pc) {
    const sdp = (data as { sdp?: unknown })?.sdp;
    if (!sdp) return;
    void answerIncoming(peerId, data);
    return;
  }

  // 对方应答我们的呼叫
  if (signal_type === 'answer' && pc) {
    pc.setRemoteDescription(new RTCSessionDescription((data as { sdp: RTCSessionDescriptionInit }).sdp)).catch(
      () => {}
    );
    // 修复 app.js:615: 旧代码引用未定义的 peerId, 导致连接后不显示 Connected
    store().setCallState({ status: 'connected', peerId: currentCallPeerId ?? peerId });
  } else if (signal_type === 'ice_candidate' && pc && (data as { candidate?: unknown })?.candidate) {
    pc.addIceCandidate(new RTCIceCandidate((data as { candidate: RTCIceCandidateInit }).candidate)).catch(
      () => {}
    );
  } else if (signal_type === 'call_end') {
    hangUp();
  }
}

/** 接听 (CallOverlay 的接听按钮) */
function accept(): void {
  const peerId = currentCallPeerId;
  const offer = pendingOffer;
  if (!peerId || !offer) return;
  pendingOffer = null;
  void answerIncoming(peerId, offer);
}

/** 拒绝 (对应 app.js:582-586) */
function reject(): void {
  if (currentCallPeerId) {
    wsManager.sendCallSignal('call_end', currentCallPeerId, {});
    currentCallPeerId = null;
  }
  stopTimer();
  store().setCallState({ status: 'idle', peerId: null, peerName: '', seconds: 0 });
}

/** 挂断 (对应 app.js:639-644 + 876-880: 挂断同时退出语音房间) */
function hangUp(): void {
  if (pc) {
    pc.close();
    pc = null;
  }
  releaseMicStream();
  if (currentCallPeerId) {
    wsManager.sendCallSignal('call_end', currentCallPeerId, {});
    currentCallPeerId = null;
  }
  pendingOffer = null;
  stopTimer();
  store().setCallState({ status: 'idle', peerId: null, peerName: '', seconds: 0 });
  roomManager.leaveRoom();
}

function isActive(): boolean {
  return !!pc || store().call.status !== 'idle';
}

export const callManager = {
  startCall,
  handleSignal,
  accept,
  reject,
  hangUp,
  isActive,
};
