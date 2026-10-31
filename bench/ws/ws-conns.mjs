// WS 连接数压测 + 内存观察
//
// 用法:
//   node ws-conns.mjs --conns 10000 --rate 500 --hold-sec 60
//   node ws-conns.mjs --conns 50000 --rate 2000 --workers 4 --hold-sec 60
//   node ws-conns.mjs --conns 10000 --auth-file tokens.jsonl --hold-sec 60
//
// 输出 (每 2s 一行):
//   已建连数 / 失败数 / 客户端进程总内存 / 网关容器内存 (docker stats 采样)
//
// 模式:
//   --auth-file 指定时: 每连接发 auth 帧并等 auth_ok (触发 connectionManager
//                      登记 + Redis 在线路由表写入, 上限 WS_MAX_CONNECTIONS=50000)
//                      要求 token 数 ≥ 连接数 (每连接一个独立用户, 复用 token
//                      会被网关"同用户重连踢旧连接"机制踢下线)
//   未指定: 裸连接 (只收 welcome 帧, 测原始 socket 容量与每连接内存)
//
// ⚠️ 客户端端口上限: Windows 默认 16384 个动态端口, 5 万连接需管理员执行
//   netsh int ipv4 set dynamicport tcp start=1025 num=64510
//   (Linux: sysctl net.ipv4.ip_local_port_range="1024 65535")
import { createRequire } from "node:module";
import { fork, execSync } from "node:child_process";
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

const CONNS = Number(arg("conns", 10000));
const RATE = Number(arg("rate", 500));        // 建连速率 (个/秒, 防 SYN 风暴)
const HOLD = Number(arg("hold-sec", 60));     // 到达目标后保持秒数
const WORKERS = Number(arg("workers", 1));    // 子进程数 (分摊事件循环)
const AUTH_FILE = arg("auth-file", "");
const BASE = arg("base", "http://localhost:3000");
const WS_URL = BASE.replace(/^http/, "ws") + "/ws";
const GATEWAY_CONTAINER = arg("gateway", "novachat-gateway");

// ---------------- 子进程模式: 只负责建连并汇报 ----------------
if (arg("child", "") === "1") {
  const share = Number(arg("child-share", CONNS));
  const offset = Number(arg("child-offset", 0));
  const childRate = Math.max(1, Math.round(RATE / WORKERS));
  let tokens = [];
  if (AUTH_FILE) {
    tokens = readFileSync(AUTH_FILE, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse)
      .slice(offset, offset + share);
  }
  const t0 = Date.now();
  let connected = 0;   // 当前在线的连接数 (仅报告用)
  let failed = 0;      // 累计失败 (错误帧/建连失败)
  let authed = 0;      // 累计 auth_ok
  let attempted = 0;   // 单调: 已尝试的连接数 (断开不补建, 防止建连风暴)
  let tokenCursor = 0;
  const sockets = [];

  function connectOne() {
    const ws = new WebSocket(WS_URL);
    ws.on("open", () => {
      connected++;
      sockets.push(ws);
      if (tokens.length > 0) {
        const t = tokens[tokenCursor++ % tokens.length];
        ws.send(JSON.stringify({ type: "auth", seq: 1, payload: { access_token: t.access_token, device_type: "bench", device_name: "ws-conns" } }));
        ws.on("message", (d) => {
          const m = JSON.parse(d.toString());
          if (m.type === "auth_ok") authed++;
          if (m.type === "error") failed++;
        });
      }
    });
    ws.on("error", () => { failed++; });
    ws.on("close", () => { connected = Math.max(0, connected - 1); });
  }

  // 按速率斜坡建连 (attempted 单调递增, 掉线不重建)
  const ramp = setInterval(() => {
    const target = Math.min(share, Math.floor(((Date.now() - t0) / 1000) * childRate));
    while (attempted < target) {
      attempted++;
      connectOne();
    }
    if (attempted >= share) clearInterval(ramp);
  }, 100);

  process.on("message", (m) => {
    if (m === "snapshot") {
      try {
        process.send({
          attempted, ok: connected, authed,
          rss: process.memoryUsage().rss, failed,
        });
      } catch { /* 父进程已退出 */ }
    }
    if (m === "stop") {
      clearInterval(ramp);
      for (const s of sockets) { try { s.close(); } catch {} }
      setTimeout(() => process.exit(0), 500);
    }
  });
} else {
  // ---------------- 主进程: 编排 worker + 采样打印 ----------------
  if (!Number.isInteger(CONNS) || CONNS <= 0 || WORKERS <= 0) {
    console.error("用法: node ws-conns.mjs --conns <n> [--rate 500] [--hold-sec 60] [--workers 1] [--auth-file tokens.jsonl]");
    process.exit(1);
  }
  if (AUTH_FILE) {
    const n = readFileSync(AUTH_FILE, "utf8").trim().split("\n").filter(Boolean).length;
    if (n < CONNS) {
      console.error(`认证模式需要 token 数 ≥ 连接数 (每连接一个独立用户), 当前 ${n} < ${CONNS}`);
      console.error(`先注册更多用户: node register-pool.mjs --count ${CONNS} --out ${AUTH_FILE}`);
      process.exit(1);
    }
  }

  const perWorker = Math.ceil(CONNS / WORKERS);
  const workers = [];
  for (let w = 0; w < WORKERS; w++) {
    workers.push(fork(new URL(import.meta.url), [
      "--conns", String(CONNS), "--rate", String(RATE), "--workers", String(WORKERS),
      "--auth-file", AUTH_FILE, "--base", BASE, "--child", "1",
      "--child-share", String(w === WORKERS - 1 ? CONNS - perWorker * (WORKERS - 1) : perWorker),
      "--child-offset", String(w * perWorker),
    ]));
  }

  const gatewayMem = () => {
    try {
      const s = execSync(
        `docker stats ${GATEWAY_CONTAINER} --no-stream --format "{{.MemUsage}}"`,
        { stdio: ["ignore", "pipe", "ignore"] }
      ).toString().trim();
      return s.split(" / ")[0];
    } catch { return "n/a"; }
  };

  console.log(`target=${CONNS} rate=${RATE}/s workers=${WORKERS} auth=${AUTH_FILE ? "yes" : "no(raw)"} hold=${HOLD}s`);
  console.log(`gateway mem before: ${gatewayMem()}`);
  console.log("time(s) | total | ok | authed | failed | clientRSS | gatewayMem");

  const start = Date.now();
  const results = new Map();
  let finished = false;

  const snapshot = () => {
    for (const w of workers) { try { w.send("snapshot"); } catch {} }
  };
  const timer = setInterval(snapshot, 2000);

  workers.forEach((w, i) => w.on("message", (m) => {
    results.set(i, m);
    const agg = (f) => [...results.values()].reduce((a, r) => a + f(r), 0);
    const t = ((Date.now() - start) / 1000).toFixed(0).padStart(6);
    console.log(`${t} | ${String(agg(r => r.attempted)).padStart(5)} | ${String(agg(r => r.ok)).padStart(5)} | ${String(agg(r => r.authed)).padStart(6)} | ${String(agg(r => r.failed)).padStart(6)} | ${(agg(r => r.rss) / 1024 / 1024).toFixed(0)}MB | ${gatewayMem()}`);
    if (!finished && agg(r => r.attempted) >= CONNS) {
      finished = true;
      clearInterval(timer);
      console.log(`== 全部 ${CONNS} 连接已建立, 保持 ${HOLD}s 观察内存... ==`);
      const hold = setInterval(() => {
        const rs = agg(r => r.rss);
        console.log(`${((Date.now() - start) / 1000).toFixed(0).padStart(6)} | (hold) clientRSS=${(rs / 1024 / 1024).toFixed(0)}MB gateway=${gatewayMem()}`);
      }, 5000);
      setTimeout(() => {
        clearInterval(hold);
        for (const w of workers) { try { w.send("stop"); } catch {} }
        console.log("== 压测结束, 连接关闭中 ==");
        setTimeout(() => process.exit(0), 3000);
      }, HOLD * 1000);
    }
  }));

  setTimeout(() => {
    if (!finished) {
      console.log("== 超时: 未能在预期时间内建满目标连接 (检查端口范围/网关状态) ==");
      for (const w of workers) { try { w.send("stop"); } catch {} }
      setTimeout(() => process.exit(1), 3000);
    }
  }, (CONNS / RATE + 120) * 1000);
}
