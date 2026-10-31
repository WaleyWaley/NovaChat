import WebSocket from "ws";

/**
 * 测试客户端
 *
 * 用法：
 *   tsx src/test-client.ts <username> [server_port]
 *
 * 它会：
 * 1. 连接 WS 服务器
 * 2. 发送 auth
 * 3. 每 3 秒发送一次 ping
 * 4. 接收服务器推送并打印
 * 5. 模拟 25 秒不发送 ping，测试心跳超时断开
 *
 * 你可以同时开多个终端跑这个客户端，测试多端互踢、广播等功能。
 */

const username = process.argv[2] || `user_${Date.now()}`;
const port = parseInt(process.argv[3] || "3001", 10);
const url = `ws://localhost:${port}`;

let seq = 0;

function nextSeq(): number {
  return ++seq;
}

const ws = new WebSocket(url);

let pingTimer: NodeJS.Timeout | null = null;
let stopPing = false;

ws.on("open", () => {
  console.log(`[client ${username}] connected`);

  // 发送 auth
  ws.send(
    JSON.stringify({
      type: "auth",
      seq: nextSeq(),
      payload: {
        username,
        user_id: username,
      },
    })
  );
});

ws.on("message", (data) => {
  const msg = JSON.parse(data.toString());
  console.log(`[client ${username}] recv:`, msg);

  if (msg.type === "auth_ok") {
    console.log(`[client ${username}] authenticated, start ping loop`);

    // 每 3 秒 ping 一次
    pingTimer = setInterval(() => {
      if (stopPing) return;
      ws.send(JSON.stringify({ type: "ping", seq: nextSeq() }));
    }, 3000);

    // TODO（可选实验）:
    // 取消下面注释，测试心跳超时：15 秒后停止 ping，预期服务端会在 timeout 后断开连接
    // setTimeout(() => {
    //   console.log(`[client ${username}] stop ping to test heartbeat timeout`);
    //   stopPing = true;
    // }, 15000);
  }

  if (msg.type === "kicked") {
    console.log(`[client ${username}] kicked:`, msg.payload);
    ws.close();
  }
});

ws.on("close", (code, reason) => {
  console.log(`[client ${username}] closed: code=${code}, reason=${reason.toString()}`);
  if (pingTimer) clearInterval(pingTimer);
});

ws.on("error", (err) => {
  console.error(`[client ${username}] error:`, err.message);
});
