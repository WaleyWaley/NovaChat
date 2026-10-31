import WebSocket from "ws";
import { MiniWebSocketServer } from "./MiniWebSocketServer.js";

const PORT = 3302;
const server = new MiniWebSocketServer(PORT);
server.start();

function connect(name: string): Promise<WebSocket> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://localhost:${PORT}`);
    ws.on("open", () => {
      ws.send(JSON.stringify({ type: "auth", seq: 1, payload: { username: name, user_id: name } }));
    });
    ws.on("message", (d) => {
      const m = JSON.parse(d.toString());
      if (m.type === "auth_ok") resolve(ws);
    });
    ws.on("close", (code, reason) => {
      console.log(`[test] ${name} closed: code=${code}, reason=${reason.toString()}`);
    });
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  console.log("\n=== 场景：正常断开后在线数 ===");
  const a1 = await connect("alice");
  const b1 = await connect("bob");
  console.log(`连接 alice + bob 后 online count = ${server.getOnlineCount()} (期望 2)`);

  await sleep(300);
  console.log("\n[test] alice 主动断开 (client.close)...");
  a1.close();
  await sleep(1500);
  console.log(`alice 断开后 online count = ${server.getOnlineCount()} (期望 1)`);

  console.log("\n[test] bob 主动断开...");
  b1.close();
  await sleep(1500);
  console.log(`bob 断开后 online count = ${server.getOnlineCount()} (期望 0)`);

  console.log("\n=== 场景：断开后同用户重连 ===");
  const a2 = await connect("alice");
  console.log(`alice 重连后 online count = ${server.getOnlineCount()} (期望 1)`);
  a2.close();

  server.stop();
  process.exit(0);
}

main();
