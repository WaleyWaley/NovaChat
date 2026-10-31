import WebSocket from "ws";
import { MiniWebSocketServer } from "./MiniWebSocketServer.js";

const PORT = 3303;
const server = new MiniWebSocketServer(PORT);
server.start();

interface Msg {
  type: string;
  seq: number;
  payload?: Record<string, unknown>;
}

function open(name: string, autoAuth = true): Promise<WebSocket> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://localhost:${PORT}`);
    let sentAuth = false;
    ws.on("open", () => resolve(ws));
    ws.on("message", (d) => {
      const m = JSON.parse(d.toString()) as Msg;
      // 收到 welcome 后按需发 auth
      if (autoAuth && m.type === "welcome" && !sentAuth) {
        sentAuth = true;
        ws.send(JSON.stringify({ type: "auth", seq: 1, payload: { username: name, user_id: name } }));
      }
    });
  });
}

/** 等待 service 端返回某个 seq 的响应 */
function waitFor(ws: WebSocket, seq: number): Promise<Msg> {
  return new Promise((resolve) => {
    const h = (d: Buffer) => {
      const m = JSON.parse(d.toString()) as Msg;
      if (m.seq === seq && m.type !== "welcome") {
        ws.off("message", h);
        resolve(m);
      }
    };
    ws.on("message", h);
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  let pass = 0;
  let fail = 0;
  const check = (name: string, cond: boolean, detail: string) => {
    if (cond) {
      pass++;
      console.log(`  ✅ ${name}`);
    } else {
      fail++;
      console.log(`  ❌ ${name} — ${detail}`);
    }
  };

  console.log("\n=== 场景 1：未认证发 send_msg ===");
  {
    const ws = await open("u1", false);
    await sleep(200);
    const p = waitFor(ws, 2);
    ws.send(JSON.stringify({ type: "send_msg", seq: 2 }));
    const m = await p;
    check("返回 error", m.type === "error", `实际 type=${m.type}`);
    check("错误码 1004", m.payload?.code === 1004, `实际 code=${m.payload?.code}`);
    ws.close();
  }

  console.log("\n=== 场景 2：认证后发 send_msg ===");
  {
    const ws = await open("u2");
    await sleep(200);
    const p = waitFor(ws, 5);
    ws.send(JSON.stringify({ type: "send_msg", seq: 5 }));
    const m = await p;
    check("返回 error", m.type === "error", `实际 type=${m.type}`);
    check("错误码 1302 (未知类型)", m.payload?.code === 1302, `实际 code=${m.payload?.code}`);
    check(
      "错误信息包含类型名 send_msg",
      typeof m.payload?.message === "string" && (m.payload.message as string).includes("send_msg"),
      `实际 message=${m.payload?.message}`
    );
    ws.close();
  }

  console.log("\n=== 场景 3：认证后 ping ===");
  {
    const ws = await open("u3");
    await sleep(200);
    const p = waitFor(ws, 9);
    ws.send(JSON.stringify({ type: "ping", seq: 9 }));
    const m = await p;
    check("返回 pong", m.type === "pong", `实际 type=${m.type}`);
    ws.close();
  }

  console.log(`\n=== 结果: ${pass} passed, ${fail} failed ===`);
  server.stop();
  process.exit(fail === 0 ? 0 : 1);
}

main();
