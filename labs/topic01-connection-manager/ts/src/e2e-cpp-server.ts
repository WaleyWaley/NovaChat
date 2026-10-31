import { spawn, type ChildProcess } from "child_process";
import path from "path";
import { fileURLToPath } from "url";
import WebSocket from "ws";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const exe = path.resolve(__dirname, "../../cpp/topic01_conn_mgr.exe");
const PORT = 3401;

function startServer(): ChildProcess {
  // port=3401, heartbeat interval=1s, timeout=2s (方便快速测试)
  const child = spawn(exe, [String(PORT), "1", "2"], { stdio: ["ignore", "pipe", "pipe"] });
  child.stdout?.on("data", (d) => process.stdout.write("[cpp] " + d.toString()));
  child.stderr?.on("data", (d) => process.stderr.write("[cpp:err] " + d.toString()));
  return child;
}

interface Client {
  ws: WebSocket;
  name: string;
  authed: boolean;
  lastPong: boolean;
  closeCode: number | null;
  closeReason: string | null;
}

function connect(name: string, startPing: boolean): Promise<Client> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://localhost:${PORT}/ws`);
    const c: Client = { ws, name, authed: false, lastPong: false, closeCode: null, closeReason: null };
    let pingTimer: NodeJS.Timeout | null = null;

    ws.on("open", () => {
      ws.send(JSON.stringify({ type: "auth", seq: 1, payload: { username: name, user_id: name } }));
    });

    ws.on("message", (d) => {
      const m = JSON.parse(d.toString());
      if (m.type === "auth_ok") {
        c.authed = true;
        if (startPing) {
          pingTimer = setInterval(() => {
            ws.send(JSON.stringify({ type: "ping", seq: 100 }));
          }, 500);
        }
        resolve(c);
      }
      if (m.type === "pong") c.lastPong = true;
    });

    ws.on("close", (code, reason) => {
      c.closeCode = code;
      c.closeReason = reason.toString();
      if (pingTimer) clearInterval(pingTimer);
      console.log(`[test] ${name} closed: code=${code}, reason=${reason.toString()}`);
    });

    ws.on("error", (err) => console.error(`[test] ${name} error:`, err.message));
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const server = startServer();
  await sleep(1500);

  let pass = 0, fail = 0;
  const check = (name: string, ok: boolean, detail = "") => {
    if (ok) { pass++; console.log(`  ✅ ${name}`); }
    else { fail++; console.log(`  ❌ ${name} — ${detail}`); }
  };

  console.log("\n=== 1. 认证 + 心跳 ===");
  const a1 = await connect("alice", true);
  check("alice#1 auth_ok", a1.authed);
  await sleep(1200);
  check("alice#1 收到 pong (心跳保活)", a1.lastPong);
  check("alice#1 未被心跳断开", a1.closeCode === null, `code=${a1.closeCode}`);

  console.log("\n=== 2. 同用户互踢 ===");
  const a2 = await connect("alice", true);
  await sleep(1000);
  check("alice#2 auth_ok", a2.authed);
  check("alice#1 被踢 (4001)", a1.closeCode === 4001, `code=${a1.closeCode}`);
  check("alice#2 仍在线", a2.closeCode === null, `code=${a2.closeCode}`);

  console.log("\n=== 3. 心跳超时断开 ===");
  a2.ws.close();  // 先让 a2 正常断开
  await sleep(500);
  const b = await connect("bob", false);  // bob 不发 ping
  check("bob auth_ok", b.authed);
  console.log("  (bob 不 ping, 等待 ~3.5s 触发心跳超时...)");
  await sleep(3500);
  check("bob 被心跳超时断开 (4002)", b.closeCode === 4002, `code=${b.closeCode}`);

  console.log(`\n=== 结果: ${pass} passed, ${fail} failed ===`);
  server.kill();
  await sleep(300);
  process.exit(fail === 0 ? 0 : 1);
}

main();
