// 网关层真实数据演示: 注册 → 登录 → 双 WS 认证 → 发消息 (打印每一步的真实数据)
// 用法: node scripts/demo_flow.mjs [gateway_base]
import WebSocket from "ws";

const BASE = process.argv[2] ?? "http://localhost:3000";
const WS_URL = BASE.replace(/^http/, "ws") + "/ws";
const print = (label, obj) => console.log(label + ":\n" + JSON.stringify(obj, null, 2));

async function register(tag, first_name) {
  const username = `demo_${Date.now()}_${tag}`;
  const res = await fetch(`${BASE}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password: "demo123456", first_name }),
  });
  const body = await res.json();
  if (body.error_code && body.error_code !== 0) throw new Error("register failed: " + JSON.stringify(body));
  return body;
}

/** WS 连接 + 收集全部帧 */
function openWs() {
  const ws = new WebSocket(WS_URL);
  const frames = [];
  const waiters = [];
  ws.on("message", (data) => {
    const msg = JSON.parse(data.toString());
    frames.push(msg);
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].pred(msg)) {
        const [w] = waiters.splice(i, 1);
        clearTimeout(w.timer);
        w.resolve(msg);
      }
    }
  });
  return {
    ws, frames,
    send: (obj) => ws.send(JSON.stringify(obj)),
    waitFor(pred, timeout = 8000, label = "msg") {
      const hit = frames.find(pred);
      if (hit) return Promise.resolve(hit);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("timeout waiting " + label)), timeout);
        waiters.push({ pred, resolve, timer });
      });
    },
  };
}
const open = (s) => new Promise((res, rej) => { s.ws.once("open", res); s.ws.once("error", rej); });

// ================= ① 注册 C (小明) =================
const c = await register("c", "小明");
console.log("========== ① 注册 C (小明) ==========");
console.log("请求: POST /api/auth/register  { username: 'demo_xxx_c', password: 'demo123456', first_name: '小明' }");
print("响应 (网关 → 前端)", { user_id: c.user.user_id, username: c.user.username, first_name: c.user.first_name, access_token: c.access_token.slice(0, 40) + "...", refresh_token: c.refresh_token.slice(0, 40) + "...", expires_at: c.expires_at });
const jwtPayload = JSON.parse(Buffer.from(c.access_token.split(".")[1], "base64url").toString());
print("access_token (JWT) 解码后的 payload", jwtPayload);

// ================= ② 登录 C =================
const login = await (await fetch(`${BASE}/api/auth/login`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ username: c.user.username, password: "demo123456", device_type: "web", device_name: "demo" }),
})).json();
console.log("\n========== ② 登录 C ==========");
console.log("请求: POST /api/auth/login { username, password, device_type: 'web' }");
print("响应", { error_code: login.error_code, user_id: login.user.user_id, access_token: login.access_token.slice(0, 40) + "...", expires_at: login.expires_at });

// ================= ③ 注册 D (小红) + 双 WS 认证 =================
const d = await register("d", "小红");
console.log("\n========== ③ D (小红) 注册 + 双方 WS 认证 ==========");
print("D 注册得到", { user_id: d.user.user_id, username: d.user.username });

const cws = openWs();
const dws = openWs();
await open(cws);
await open(dws);
console.log("C 连接 WS 后收到的第一帧:", JSON.stringify(cws.frames[0]));
cws.send({ type: "auth", seq: 1, payload: { access_token: c.access_token, device_type: "web", device_name: "demo" } });
dws.send({ type: "auth", seq: 1, payload: { access_token: d.access_token, device_type: "web", device_name: "demo" } });
await cws.waitFor((m) => m.type === "auth_ok", 8000, "C auth_ok");
await dws.waitFor((m) => m.type === "auth_ok", 8000, "D auth_ok");
print("C 的 auth_ok 帧", cws.frames.find((m) => m.type === "auth_ok"));

// ================= ④ C 发消息给 D =================
const text = "你好呀，这是网关层的真实数据演示";
const idemKey = `demo-key-${Date.now()}`;
console.log("\n========== ④ C 发消息给 D ==========");
console.log(`C 发送 WS 帧: { type: 'send_msg', seq: 100, payload: { peer_type: 1, peer_id: '${d.user.user_id}', msg_type: 0, text: '${text}', idempotency_key: '${idemKey}' } }`);
cws.send({ type: "send_msg", seq: 100, payload: { peer_type: 1, peer_id: d.user.user_id, msg_type: 0, text, idempotency_key: idemKey } });
const confirm = await cws.waitFor((m) => m.type === "rpc_result" && m.seq === 100, 8000, "C rpc_result");
const push = await dws.waitFor((m) => m.type === "update", 8000, "D update");
print("C 收到的 rpc_result 帧 (发送确认)", confirm);
print("D 收到的 update 帧 (新消息推送)", push);

console.log("\n========== 完成 (保持 WS 打开 2s 后可查 Redis/MySQL) ==========");
await new Promise((r) => setTimeout(r, 2000));
cws.ws.close();
dws.ws.close();
process.exitCode = 0;
