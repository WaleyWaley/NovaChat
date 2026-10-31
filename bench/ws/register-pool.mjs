// 批量注册压测用户 — 输出 JSONL 到文件供连接数/消息压测使用
//
// 用法:
//   node register-pool.mjs --count 1000 --out tokens.jsonl
//   node register-pool.mjs --count 200 --out tokens.jsonl --concurrency 50 --prefix bench
//
// 输出 (每行一个 JSON):
//   {"user_id":"...","username":"...","access_token":"..."}
//
// 注意: 每个用户一次真实注册 (雪花 ID + PBKDF2 + INSERT), 1000 个约 1-2 分钟;
//       压测用户会残留在数据库, 属预期 (与 wrk register 同理)
import { createWriteStream, mkdirSync } from "node:fs";
import path from "node:path";

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

const COUNT = Number(arg("count", 1000));
const OUT = arg("out", "tokens.jsonl");
const CONCURRENCY = Number(arg("concurrency", 50));
const PREFIX = arg("prefix", "bench");
const BASE = arg("base", "http://localhost:3000");

if (!Number.isInteger(COUNT) || COUNT <= 0) {
  console.error("用法: node register-pool.mjs --count <n> --out <file> [--concurrency 50] [--prefix bench] [--base http://localhost:3000]");
  process.exit(1);
}

mkdirSync(path.dirname(path.resolve(OUT)), { recursive: true });
const out = createWriteStream(OUT, { flags: "w" });

const started = Date.now();
let done = 0;
let failed = 0;

async function registerOne(i) {
  const username = `${PREFIX}_${Date.now()}_${i}`;
  try {
    const res = await fetch(`${BASE}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password: "bench123456", first_name: `bench${i % 100}` }),
    });
    const body = await res.json();
    if (body.error_code && body.error_code !== 0) throw new Error(JSON.stringify(body));
    out.write(JSON.stringify({ user_id: body.user.user_id, username, access_token: body.access_token }) + "\n");
    done++;
  } catch (err) {
    failed++;
    if (failed <= 5) console.error(`register #${i} failed: ${err.message}`);
  }
  if ((done + failed) % 100 === 0) {
    const rate = Math.round((done / (Date.now() - started)) * 1000);
    console.log(`progress: ${done + failed}/${COUNT} (ok=${done} fail=${failed} rate=${rate}/s)`);
  }
}

// 简单并发池
async function run() {
  let next = 0;
  const workers = Array.from({ length: Math.min(CONCURRENCY, COUNT) }, async () => {
    while (next < COUNT) {
      const i = next++;
      await registerOne(i);
    }
  });
  await Promise.all(workers);
  out.end();
  console.log(`done: ${done} ok, ${failed} failed, ${((Date.now() - started) / 1000).toFixed(1)}s → ${OUT}`);
  process.exit(failed === 0 ? 0 : 1);
}

run();
