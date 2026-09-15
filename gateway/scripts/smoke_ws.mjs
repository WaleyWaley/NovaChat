// 双账号 WS 冒烟测试 — 网关重构后的端到端回归
//
// 覆盖:
//   1. 注册即登录 (REST) → 2. 双开 WS + auth → 3. A→B 发消息 (A 收 rpc_result 确认, B 收 NEW_MESSAGE 推送)
//   4. B→A 反向 → 5. ping/pong → 6. A 输入中 → B 收 USER_TYPING 推送
//
// 用法: node scripts/smoke_ws.mjs [gateway_base]   (默认 http://localhost:3000, 直连网关绕过 nginx)
// 退出码: 0 = 全部通过, 1 = 失败/超时
import WebSocket from "ws";

const BASE = process.argv[2] ?? "http://localhost:3000";
const WS_URL = BASE.replace(/^http/, "ws") + "/ws";
const WAIT_TIMEOUT = 10000;

// update_type 兼容三种形态: 数字 (网关构造) / 数字字符串 / protobuf 枚举名 (C++ 推送)
const isNewMessageUpdate = (m) =>
  m.type === "update" && [0, "0", "UPDATE_NEW_MESSAGE"].includes(m.payload?.update_type);
const isTypingUpdate = (m) =>
  m.type === "update" && [5, "5", "USER_TYPING"].includes(m.payload?.update_type);

let failures = 0;
function fail(name, detail) {
  failures++;
  console.error(`  ❌ ${name}: ${detail}`);
}
function pass(name) {
  console.log(`  ✅ ${name}`);
}

// ---- 工具 ----

async function registerUser(tag) {
  const username = `smoke_${Date.now()}_${tag}`;
  const res = await fetch(`${BASE}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password: "smoke123456", first_name: tag }),
  });
  const body = await res.json();
  // proto3 会省略 error_code=0 字段 (undefined 也算成功)
  if (body.error_code && body.error_code !== 0) throw new Error(`register failed: ${JSON.stringify(body)}`);
  return { token: body.access_token, user: body.user };
}

/** 建 WS 连接 + 收集消息队列 */
function openWs() {
  const ws = new WebSocket(WS_URL);
  const queue = [];
  const waiters = [];
  ws.on("message", (data) => {
    const msg = JSON.parse(data.toString());
    queue.push(msg);
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].pred(msg)) {
        const [w] = waiters.splice(i, 1);
        clearTimeout(w.timer);
        w.resolve(msg);
      }
    }
  });
  return {
    ws,
    send: (obj) => ws.send(JSON.stringify(obj)),
    waitFor(pred, timeout = WAIT_TIMEOUT, label = "message") {
      const hit = queue.find(pred);
      if (hit) return Promise.resolve(hit);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timeout waiting for ${label}`)), timeout);
        waiters.push({ pred, resolve, timer });
      });
    },
  };
}

function open(sock) {
  return new Promise((resolve, reject) => {
    sock.ws.once("open", resolve);
    sock.ws.once("error", reject);
  });
}

function close(sock) {
  try { sock.ws.close(); } catch {}
}

// ---- 测试 ----

console.log(`Smoke test against ${BASE}\n`);

// 1. 注册两个账号 (注册即登录)
const alice = await registerUser("a");
const bob = await registerUser("b");
pass(`registered ${alice.user.username} (id=${alice.user.user_id}) and ${bob.user.username} (id=${bob.user.user_id})`);

// 2. 双开 WS + auth
const a = openWs();
const b = openWs();
await open(a);
await open(b);

a.send({ type: "auth", seq: 1, payload: { access_token: alice.token, device_type: "web", device_name: "smoke" } });
b.send({ type: "auth", seq: 1, payload: { access_token: bob.token, device_type: "web", device_name: "smoke" } });
try {
  await a.waitFor((m) => m.type === "auth_ok" && m.seq === 1, WAIT_TIMEOUT, "alice auth_ok");
  await b.waitFor((m) => m.type === "auth_ok" && m.seq === 1, WAIT_TIMEOUT, "bob auth_ok");
  pass("both WebSockets authenticated (auth_ok)");
} catch (err) { fail("ws auth", err.message); }

// 3. A → B 发消息 (peer_id 用 string 传 — 雪花 ID 超出 JS Number 精度, Number() 会静默舍入)
const textAB = `hello from smoke A ${Date.now()}`;
a.send({ type: "send_msg", seq: 100, payload: { peer_type: 1, peer_id: bob.user.user_id, msg_type: 0, text: textAB } });
try {
  const confirm = await a.waitFor((m) => m.type === "rpc_result" && m.seq === 100, WAIT_TIMEOUT, "A rpc_result");
  if (confirm.payload?.error_code !== 0 || !confirm.payload?.data?.message_id) {
    throw new Error(`bad rpc_result: ${JSON.stringify(confirm)}`);
  }
  pass(`A got rpc_result confirmation (message_id=${confirm.payload.data.message_id})`);

  const push = await b.waitFor(isNewMessageUpdate, WAIT_TIMEOUT, "B NEW_MESSAGE push");
  const inner = push.payload?.data?.newMessage ?? push.payload?.data?.new_message;
  if (!inner || inner.text !== textAB) throw new Error(`bad update payload: ${JSON.stringify(push.payload).slice(0, 300)}`);
  pass("B received NEW_MESSAGE update with matching text");
} catch (err) { fail("A→B message", err.message); }

// 4. B → A 反向
const textBA = `hello back from smoke B ${Date.now()}`;
b.send({ type: "send_msg", seq: 200, payload: { peer_type: 1, peer_id: alice.user.user_id, msg_type: 0, text: textBA } });
try {
  await b.waitFor((m) => m.type === "rpc_result" && m.seq === 200, WAIT_TIMEOUT, "B rpc_result");
  const push = await a.waitFor(isNewMessageUpdate, WAIT_TIMEOUT, "A NEW_MESSAGE push");
  const inner = push.payload?.data?.newMessage ?? push.payload?.data?.new_message;
  if (!inner || inner.text !== textBA) throw new Error(`bad update payload: ${JSON.stringify(push.payload).slice(0, 300)}`);
  pass("B→A message delivered both ways");
} catch (err) { fail("B→A message", err.message); }

// 5. ping/pong
a.send({ type: "ping", seq: 300 });
try {
  await a.waitFor((m) => m.type === "pong" && m.seq === 300, WAIT_TIMEOUT, "pong");
  pass("ping → pong heartbeat");
} catch (err) { fail("ping/pong", err.message); }

// 6. typing: A 输入中 → B 收 USER_TYPING (update_type=5)
a.send({ type: "typing", seq: 400, payload: { peer_type: 1, peer_id: bob.user.user_id, is_typing: true } });
try {
  const push = await b.waitFor(isTypingUpdate, WAIT_TIMEOUT, "B USER_TYPING push");
  const d = push.payload?.data ?? {};
  if (d.is_typing !== true || String(d.from_peer?.id) !== String(alice.user.user_id)) {
    throw new Error(`bad typing payload: ${JSON.stringify(push.payload).slice(0, 300)}`);
  }
  pass("A typing → B received USER_TYPING update");
} catch (err) { fail("typing", err.message); }

close(a);
close(b);
// 等 socket 完全关闭再退出 (Windows 下 process.exit 撞上关闭中的 libuv 句柄会触发断言)
await new Promise((r) => setTimeout(r, 500));

console.log(failures === 0 ? "\n✅ ALL SMOKE TESTS PASSED" : `\n❌ ${failures} test(s) FAILED`);
process.exitCode = failures === 0 ? 0 : 1;
