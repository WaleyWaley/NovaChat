/**
 * 共享麦克风流 (对应旧 app.js 的模块级 localStream 变量)
 * 1v1 通话与语音房间共用; 抽取出来避免 callManager ↔ roomManager 循环导入。
 */

/**
 * WebRTC 配置 — 多 STUN 兜底:
 * stun.l.google.com 在国内经常不可达, 加 miwifi/qq 作为备选,
 * 否则跨网络呼叫时 ICE 收集不到 srflx 候选, 表现为"接通了但没声音"。
 */
export const RTC_CONFIG: RTCConfiguration = {
  iceServers: [
    { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
    { urls: 'stun:stun.miwifi.com:3478' },
    { urls: 'stun:stun.qq.com:3478' },
  ],
};

let sharedStream: MediaStream | null = null;

export async function ensureMicStream(): Promise<MediaStream> {
  if (sharedStream) return sharedStream;
  console.log('Requesting microphone...');
  sharedStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
  console.log('Microphone OK');
  return sharedStream;
}

export function releaseMicStream(): void {
  if (sharedStream) {
    sharedStream.getTracks().forEach((t) => t.stop());
    sharedStream = null;
  }
}
