// 端到端测试: WS 客户端以 Bob 身份发 read 回执, 验证网关 → message-service ACK 链路
// 用法: node scripts/test-ack.mjs <access_token> <max_read_msg_id>
import WebSocket from "ws";

const token = process.argv[2];
const maxReadMsgId = process.argv[3];   // 保持 string: 模拟前端防精度丢失的传输方式
if (!token || !maxReadMsgId) {
  console.error("usage: node scripts/test-ack.mjs <access_token> <max_read_msg_id>");
  process.exit(1);
}

const ws = new WebSocket("ws://localhost:3000/ws");
const timeout = setTimeout(() => { console.error("TIMEOUT"); process.exit(1); }, 15000);

ws.on("open", () => {
  console.log("[1] WS connected, sending auth...");
  ws.send(JSON.stringify({
    type: "auth",
    seq: 1,
    payload: { access_token: token, device_type: "desktop", device_name: "e2e-test" },
  }));
});

ws.on("message", (data) => {
  const msg = JSON.parse(data.toString());
  console.log("[recv]", JSON.stringify(msg));

  if (msg.type === "auth_ok" || (msg.type === "rpc_result" && msg.seq === 1)) {
    console.log("[2] authenticated, sending read receipt...");
    ws.send(JSON.stringify({
      type: "read",
      seq: 2,
      payload: { peer_type: 1, peer_id: 0, max_read_msg_id: maxReadMsgId },
    }));
  }

  if (msg.type === "rpc_result" && msg.seq === 2) {
    console.log("[3] ACK rpc_result received =>", JSON.stringify(msg.payload));
    clearTimeout(timeout);
    ws.close();
    process.exit(msg.payload && msg.payload.error_code === 0 ? 0 : 1);
  }

  if (msg.type === "error") {
    clearTimeout(timeout);
    process.exit(1);
  }
});

ws.on("error", (err) => { console.error("WS error:", err.message); process.exit(1); });
