// 消息收发 QPS + P50/P99 延迟压测
//
// 用法:
//   node msg-qps.mjs --pairs 50 --duration 30 --auth-file tokens.jsonl
//   node msg-qps.mjs --pairs 200 --duration 30 --window 4 --auth-file tokens.jsonl
//
// 每个 pair = 发送端 + 接收端 (2 个用户, 从 auth-file 依次取)
// 测量两种端到端延迟:
//   ack  P50/P99: 发送 → rpc_result 确认 (含 MySQL INSERT)
//   push P50/P99: 发送 → 对端收到 update (含反向推送)
//
// 消息 text 内嵌 seq 与发送时间戳 (bench:<seq>:<ms>), 接收端据此配对
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

// ws 包就近解析: 优先本目录 node_modules, 回退到网关的依赖
const _require = createRequire(import.meta.url);
let WebSocket;
for (const c of ["ws", "../../gateway/node_modules/ws"]) {
  try { WebSocket = _require(c); break; } catch {}
}
if (!WebSocket) {
  console.error("找不到 ws 包: 运行 cd gateway && npm install, 或在本目录 npm install ws");
  process.exit(1);
}

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

const PAIRS = Number(arg("pairs", 50));
const DURATION = Number(arg("duration", 30));
const WINDOW = Number(arg("window", 1));       // 每个发送端在途消息数 (流水线深度)
const AUTH_FILE = arg("auth-file", "tokens.jsonl");
const BASE = arg("base", "http://localhost:3000");
const WS_URL = BASE.replace(/^http/, "ws") + "/ws";

if (!Number.isInteger(PAIRS) || PAIRS <= 0) {
  console.error("用法: node msg-qps.mjs --pairs <n> --duration <s> [--window 1] --auth-file <tokens.jsonl>");
  process.exit(1);
}

const tokens = readFileSync(AUTH_FILE, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
if (tokens.length < PAIRS * 2) {
  console.error(`tokens 不足: 需要 ${PAIRS * 2} (${PAIRS} 对 × 2), 文件里只有 ${tokens.length} 个。先用 register-pool.mjs 注册。`);
  process.exit(1);
}

// ---------------- 工具 ----------------

function openAuthedWs(token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL);
    const fail = (err) => { clearTimeout(t); reject(err); };
    const t = setTimeout(() => fail(new Error("auth_ok timeout")), 8000);
    ws.once("error", fail);
    ws.on("message", (d) => {
      const m = JSON.parse(d.toString());
      if (m.type === "auth_ok") { clearTimeout(t); resolve(ws); }
    });
    ws.once("open", () => {
      ws.send(JSON.stringify({ type: "auth", seq: 1, payload: { access_token: token, device_type: "bench" } }));
    });
  });
}

function percentile(sortedArr, p) {
  if (sortedArr.length === 0) return 0;
  const idx = Math.min(sortedArr.length - 1, Math.ceil((p / 100) * sortedArr.length) - 1);
  return sortedArr[idx];
}

// ---------------- 单个 pair ----------------

async function runPair(pairIdx, senderToken, receiverToken, peerId) {
  const senderWs = await openAuthedWs(senderToken);
  const receiverWs = await openAuthedWs(receiverToken);

  const ackLats = [];
  const pushLats = [];
  const inFlight = new Map();   // seq → sendTime
  let seq = 0;
  let errors = 0;
  let pushes = 0;
  let running = true;

  // 接收端: 统计 push 延迟 (text 里解析 seq + 发送时间戳)
  receiverWs.on("message", (d) => {
    const m = JSON.parse(d.toString());
    if (m.type !== "update") return;
    const data = m.payload?.data ?? {};
    const inner = data.newMessage ?? data.new_message;
    const text = inner?.text ?? "";
    const match = /^bench:(\d+):(\d+)$/.exec(text);
    if (match) {
      pushes++;
      pushLats.push(Date.now() - Number(match[2]));
    }
  });

  // 发送端: rpc_result 确认 → ack 延迟
  senderWs.on("message", (d) => {
    const m = JSON.parse(d.toString());
    if (m.type !== "rpc_result") return;
    const t0 = inFlight.get(m.seq);
    if (t0 !== undefined) {
      inFlight.delete(m.seq);
      ackLats.push(Date.now() - t0);
      if (m.payload?.error_code && m.payload.error_code !== 0) errors++;
    }
  });

  // 发送泵: 保持 window 条在途 (流水线)
  const pump = () => {
    while (running && inFlight.size < WINDOW) {
      const s = ++seq;
      const now = Date.now();
      inFlight.set(s, now);
      senderWs.send(JSON.stringify({
        type: "send_msg", seq: s,
        payload: { peer_type: 1, peer_id: peerId, msg_type: 0, text: `bench:${s}:${now}` },
      }));
    }
    if (running) setImmediate(pump);
  };

  return {
    senderWs, receiverWs, ackLats, pushLats, pump,
    stop: () => { running = false; },
    errors: () => errors,
    pushes: () => pushes,
  };
}

// ---------------- 主流程 ----------------

async function main() {
  console.log(`pairs=${PAIRS} duration=${DURATION}s window=${WINDOW} → 最大在途消息数=${PAIRS * WINDOW}`);
  console.log("连接 + 认证 WS 中...");

  const pairPromises = [];
  for (let i = 0; i < PAIRS; i++) {
    pairPromises.push(runPair(
      i,
      tokens[i * 2].access_token,
      tokens[i * 2 + 1].access_token,
      tokens[i * 2 + 1].user_id,
    ));
  }
  const pairs = await Promise.all(pairPromises);
  console.log(`全部 ${PAIRS} 对 WS 已认证, 开始压测...`);
  const start = Date.now();
  for (const p of pairs) p.pump();

  // 每秒进度
  const progress = setInterval(() => {
    let ack = 0, push = 0;
    for (const p of pairs) { ack += p.ackLats.length; push += p.pushes(); }
    const sec = (Date.now() - start) / 1000;
    console.log(`t=${sec.toFixed(1)}s  ack=${ack} (${(ack / sec).toFixed(0)}/s)  push=${push}  errors=${pairs.reduce((a, p) => a + p.errors(), 0)}`);
  }, 1000);

  await new Promise((r) => setTimeout(r, DURATION * 1000));
  clearInterval(progress);

  // 停发, 排水 3s
  for (const p of pairs) p.stop();
  await new Promise((r) => setTimeout(r, 3000));

  const allAck = pairs.flatMap((p) => p.ackLats);
  const allPush = pairs.flatMap((p) => p.pushLats);
  allAck.sort((a, b) => a - b);
  allPush.sort((a, b) => a - b);
  const totalErrors = pairs.reduce((a, p) => a + p.errors(), 0);
  const elapsed = (Date.now() - start) / 1000;

  console.log("\n========== 结果 ==========");
  console.log(`压测时长          : ${elapsed.toFixed(1)}s`);
  console.log(`发送确认 (ack)    : ${allAck.length} 条, QPS = ${(allAck.length / elapsed).toFixed(0)}/s`);
  console.log(`对端接收 (push)   : ${allPush.length} 条`);
  console.log(`失败/错误         : ${totalErrors}`);
  console.log(`ack 延迟 (发送→rpc_result, 含 MySQL INSERT):`);
  console.log(`  P50 = ${percentile(allAck, 50).toFixed(1)}ms   P99 = ${percentile(allAck, 99).toFixed(1)}ms   max = ${allAck.length ? allAck[allAck.length - 1] : 0}ms`);
  console.log(`push 延迟 (发送→对端 update, 含反向推送):`);
  console.log(`  P50 = ${percentile(allPush, 50).toFixed(1)}ms   P99 = ${percentile(allPush, 99).toFixed(1)}ms   max = ${allPush.length ? allPush[allPush.length - 1] : 0}ms`);

  for (const p of pairs) { try { p.senderWs.close(); p.receiverWs.close(); } catch {} }
  process.exit(totalErrors > 0 && allAck.length === 0 ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
