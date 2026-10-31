import WebSocket from "ws";
import { MiniWebSocketServer } from "./MiniWebSocketServer.js";

const PORT = 3301;
const server = new MiniWebSocketServer(PORT);
server.start();

interface Client {
  ws: WebSocket;
  name: string;
  authed: boolean;
  closeCode: number | null;
  closeReason: string | null;
}

function connect(name: string): Promise<Client> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://localhost:${PORT}`);
    const client: Client = { ws, name, authed: false, closeCode: null, closeReason: null };

    ws.on("open", () => {
      ws.send(JSON.stringify({ type: "auth", seq: 1, payload: { username: name, user_id: name } }));
    });

    ws.on("message", (d) => {
      const m = JSON.parse(d.toString());
      if (m.type === "auth_ok") {
        client.authed = true;
        resolve(client);
      }
    });

    ws.on("close", (code, reason) => {
      client.closeCode = code;
      client.closeReason = reason.toString();
      console.log(`[test] ${name} closed: code=${code}, reason=${reason.toString()}`);
    });

    ws.on("error", (err) => {
      console.error(`[test] ${name} error:`, err.message);
    });
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  console.log("\n=== 测试互踢 ===");
  const a1 = await connect("alice");
  console.log(`[test] alice#1 connected, authed=${a1.authed}`);
  await sleep(500);

  const a2 = await connect("alice");
  console.log(`[test] alice#2 connected, authed=${a2.authed}`);
  await sleep(1500);

  console.log("\n=== 结果 ===");
  console.log(`alice#1 readyState=${a1.ws.readyState} (3=CLOSED), closeCode=${a1.closeCode}`);
  console.log(`alice#2 readyState=${a2.ws.readyState} (3=CLOSED), closeCode=${a2.closeCode}`);
  console.log(`server online count=${server.getOnlineCount()}`);

  server.stop();
  process.exit(0);
}

main();
