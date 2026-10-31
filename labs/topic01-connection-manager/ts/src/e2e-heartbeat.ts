import { WebSocket } from "ws";
import { MiniConnectionManager } from "./MiniConnectionManager.js";

// 用 mock 对象替代真实 WebSocket，便于快速测试心跳
function mockWs(tag: string): WebSocket {
  return {
    readyState: WebSocket.OPEN,
    close(code?: number, reason?: string) {
      (this as any).readyState = WebSocket.CLOSED;
      console.log(`[mock ${tag}] close(${code}, ${reason})`);
    },
    send(_msg: string) {},
  } as unknown as WebSocket;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const mgr = new MiniConnectionManager();

  console.log("\n=== 心跳超时 + 重连 ===");
  const ws1 = mockWs("alice-1");
  mgr.register("alice", "alice", ws1);

  // 1 秒扫描一次，2 秒超时
  mgr.startHeartbeat(1, 2);

  console.log("[test] 等待 2.5s，让 alice-1 超时...");
  await sleep(2500);
  console.log(`超时后 online count = ${mgr.getOnlineCount()} (期望 0)`);

  console.log("\n[test] alice 用新连接重连...");
  const ws2 = mockWs("alice-2");
  mgr.register("alice", "alice", ws2);
  console.log(`重连后 online count = ${mgr.getOnlineCount()} (期望 1)`);

  console.log("[test] 等待 2.5s，观察新连接是否被误删...");
  await sleep(2500);
  console.log(`等待后 online count = ${mgr.getOnlineCount()} (期望 1)`);
  console.log(`alice 是否在线 = ${mgr.isOnline("alice")} (期望 true)`);

  mgr.stopHeartbeat();
  process.exit(0);
}

main();
