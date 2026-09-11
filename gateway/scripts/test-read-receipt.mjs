// 端到端测试: 模拟 Alice 的 WS 在线, 监听 UPDATE_MESSAGE_READ (对方已读 → 双勾)
// 用法: node scripts/test-read-receipt.mjs <alice_access_token> <timeout_ms>
import WebSocket from "ws";

const token = process.argv[2];
const timeoutMs = Number(process.argv[3] ?? 20000);
if (!token) {
  console.error("usage: node scripts/test-read-receipt.mjs <access_token> [timeout_ms]");
  process.exit(1);
}

const ws = new WebSocket("ws://localhost:3000/ws");
const timer = setTimeout(() => { console.log("TIMEOUT: no read receipt received"); process.exit(1); }, timeoutMs);

ws.on("open", () => {
  console.log("[1] WS connected, authenticating as Alice...");
  ws.send(JSON.stringify({ type: "auth", seq: 1, payload: { access_token: token, device_type: "desktop", device_name: "read-test" } }));
});

ws.on("message", (data) => {
  const msg = JSON.parse(data.toString());
  if (msg.type === "auth_ok") {
    console.log("[2] auth_ok:", JSON.stringify(msg.payload));
    console.log("[3] waiting for UPDATE_MESSAGE_READ push...");
    return;
  }
  if (msg.type === "update") {
    const t = msg.payload?.update_type;
    if (t === 3 || t === "3" || t === "UPDATE_MESSAGE_READ") {
      console.log("[4] ✅ RECEIVED read receipt:", JSON.stringify(msg.payload));
      clearTimeout(timer);
      ws.close();
      process.exit(0);
    }
    console.log("[recv update type=" + t + "]", JSON.stringify(msg.payload).slice(0, 200));
    return;
  }
  if (msg.type === "error") {
    console.error("[err]", JSON.stringify(msg));
    clearTimeout(timer);
    process.exit(1);
  }
});

ws.on("error", (err) => { console.error("WS error:", err.message); process.exit(1); });
