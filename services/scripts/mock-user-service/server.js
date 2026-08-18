/**
 * NovaChat — Mock C++ User Service (契约验证服务器)
 *
 * 模拟 bRPC HTTP+pb 端点的 C++ user-service，与 TS Gateway 进行端到端集成测试。
 *
 * 端点格式 (匹配 bRPC HTTP+pb): POST /nova.user.UserService/{Method}
 * 数据存储: 内存 (与 C++ user_dao 的 Phase 1 实现一致)
 *
 * 启动: node scripts/mock-user-service/server.js
 * 默认端口: 8001
 */

const http = require("http");
const jwt = require("jsonwebtoken");

const JWT_SECRET = process.env.JWT_SECRET || "novachat-dev-secret-change-in-production";

// ============================================================================
// In-Memory DAO (与 C++ user_dao.h 的 Phase 1 实现一致)
// ============================================================================

const usersById = new Map();       // user_id → UserRecord
const usersByUsername = new Map(); // username → user_id
const sessions = new Map();        // refresh_token → SessionRecord
let nextUserId = 1000;             // 简单自增 (Phase 2 由 Snowflake 替代)

// ============================================================================
// Helpers
// ============================================================================

const OK = { error_code: 0, error_message: "" };

function err(code, msg) {
  return { error_code: code, error_message: msg };
}

function makeToken(userId, username) {
  // 签发真实 JWT (与 gateway auth/jwt.ts 使用相同密钥)
  return jwt.sign({ user_id: userId, username: username }, JWT_SECRET, { expiresIn: "24h" });
}

function makeRefreshToken(userId) {
  return jwt.sign({ user_id: userId, type: "refresh" }, JWT_SECRET, { expiresIn: "30d" });
}

function userToProfile(record) {
  return {
    user_id: record.user_id,
    username: record.username,
    first_name: record.first_name,
    last_name: record.last_name || "",
    bio: record.bio || "",
    avatar_photo_id: "",
    status: 1,  // USER_STATUS_ONLINE
    last_seen_at: Date.now(),
    is_verified: false,
    phone: (record.phone || "").replace(/(\+\d{2})\d+(\d{3})/, "$1*****$2"),  // 脱敏
    created_at: record.created_at,
    updated_at: record.updated_at,
  };
}

function parseBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => {
      try { resolve(JSON.parse(data)); }
      catch { resolve({}); }
    });
  });
}

// ============================================================================
// RPC Handlers
// ============================================================================

const handlers = {
  async Register(body) {
    const { username, password, first_name, last_name, phone } = body;

    // 参数校验 (与 C++ user_service_impl.cc 一致)
    if (!username || !/^[a-zA-Z][a-zA-Z0-9_]{2,31}$/.test(username)) {
      return { ...err(1104, "Invalid username format"), user_id: 0, access_token: "", refresh_token: "", expires_at: 0, user: null };
    }
    if (!password || password.length < 8 || password.length > 128) {
      return { ...err(1006, "Password must be 8-128 characters"), user_id: 0, access_token: "", refresh_token: "", expires_at: 0, user: null };
    }
    if (!first_name) {
      return { ...err(1107, "First name is required"), user_id: 0, access_token: "", refresh_token: "", expires_at: 0, user: null };
    }

    // 检查 username 是否存在
    if (usersByUsername.has(username)) {
      return { ...err(1103, "Username already taken"), user_id: 0, access_token: "", refresh_token: "", expires_at: 0, user: null };
    }

    const userId = nextUserId++;
    const now = Date.now();
    const record = {
      user_id: userId,
      username,
      password_hash: "mock_hash_" + password,  // Phase 2: bcrypt
      first_name: first_name || "",
      last_name: last_name || "",
      bio: "",
      avatar_photo_id: "",
      phone: phone || "",
      created_at: now,
      updated_at: now,
      username_changed_at: 0,
      is_deleted: false,
    };

    usersById.set(userId, record);
    usersByUsername.set(username, userId);

    const access_token = makeToken(userId, username);
    const refresh_token = makeRefreshToken(userId);
    const expires_at = now + 24 * 3600 * 1000;

    sessions.set(refresh_token, {
      user_id: userId,
      refresh_token,
      device_type: "unknown",
      device_name: "",
      created_at: now,
      expires_at: now + 30 * 24 * 3600 * 1000,
    });

    return {
      error_code: 0,
      error_message: "",
      user_id: userId,
      access_token,
      refresh_token,
      expires_at,
      user: userToProfile(record),
    };
  },

  async Login(body) {
    const { username, password } = body;

    if (!username || !password) {
      return { ...err(1006, "Username and password required"), access_token: "", refresh_token: "", expires_at: 0, user: null };
    }

    const userId = usersByUsername.get(username);
    if (!userId) {
      return { ...err(1101, "User not found"), access_token: "", refresh_token: "", expires_at: 0, user: null };
    }

    const record = usersById.get(userId);
    if (record.is_deleted) {
      return { ...err(1106, "Account deactivated"), access_token: "", refresh_token: "", expires_at: 0, user: null };
    }

    // Phase 1: 明文比对 (Phase 2: bcrypt)
    if (record.password_hash !== "mock_hash_" + password) {
      return { ...err(1006, "Invalid password"), access_token: "", refresh_token: "", expires_at: 0, user: null };
    }

    const now = Date.now();
    const access_token = makeToken(userId, record.username);
    const refresh_token = makeRefreshToken(userId);
    const expires_at = now + 24 * 3600 * 1000;

    sessions.set(refresh_token, {
      user_id: userId,
      refresh_token,
      device_type: body.device_type || "unknown",
      device_name: body.device_name || "",
      created_at: now,
      expires_at: now + 30 * 24 * 3600 * 1000,
    });

    return {
      error_code: 0,
      error_message: "",
      access_token,
      refresh_token,
      expires_at,
      user: userToProfile(record),
    };
  },

  async RefreshToken(body) {
    const { refresh_token } = body;
    if (!refresh_token || !sessions.has(refresh_token)) {
      return { ...err(1004, "Invalid refresh token"), access_token: "", refresh_token: "", expires_at: 0 };
    }

    const session = sessions.get(refresh_token);
    const now = Date.now();
    if (now > session.expires_at) {
      sessions.delete(refresh_token);
      return { ...err(1002, "Token expired"), access_token: "", refresh_token: "", expires_at: 0 };
    }

    // Token 轮转: 旧 refresh_token 失效
    sessions.delete(refresh_token);
    const new_access = makeToken(session.user_id, "user");  // username not available from session
    const new_refresh = makeRefreshToken(session.user_id);
    const expires_at = now + 24 * 3600 * 1000;

    sessions.set(new_refresh, { ...session, refresh_token: new_refresh, created_at: now, expires_at: now + 30 * 24 * 3600 * 1000 });

    return { error_code: 0, error_message: "", access_token: new_access, refresh_token: new_refresh, expires_at };
  },

  async Logout(body) {
    // 删除所有 session (Phase 2: 精确匹配)
    for (const [token, s] of sessions) {
      if (s.user_id === body.user_id) sessions.delete(token);
    }
    return { error_code: 0, error_message: "" };
  },

  async GetUserProfile(body) {
    let record = null;
    if (body.user_id) {
      record = usersById.get(body.user_id);
    } else if (body.username) {
      const uid = usersByUsername.get(body.username);
      if (uid) record = usersById.get(uid);
    }

    if (!record || record.is_deleted) {
      return { ...err(1101, "User not found"), user: null };
    }

    return { error_code: 0, error_message: "", user: userToProfile(record) };
  },

  async GetUsers(body) {
    const ids = body.user_ids || [];
    if (ids.length > 100) {
      return { ...err(1101, "Max 100 users per request"), users: [] };
    }

    const users = ids.map((id) => {
      const r = usersById.get(id);
      return r && !r.is_deleted ? userToProfile(r) : null;
    }).filter(Boolean);

    return { error_code: 0, error_message: "", users };
  },

  async UpdateProfile(body) {
    const record = usersById.get(body.user_id);
    if (!record || record.is_deleted) {
      return { ...err(1101, "User not found"), user: null };
    }

    if (body.first_name !== undefined && body.first_name !== "") record.first_name = body.first_name;
    if (body.last_name !== undefined && body.last_name !== "") record.last_name = body.last_name;
    if (body.bio !== undefined) record.bio = body.bio;
    if (body.avatar_photo_id !== undefined) record.avatar_photo_id = body.avatar_photo_id;
    record.updated_at = Date.now();

    return { error_code: 0, error_message: "", user: userToProfile(record) };
  },

  async ChangeUsername(body) {
    const record = usersById.get(body.user_id);
    if (!record) return { ...err(1101, "User not found"), username: "" };

    const newUsername = body.new_username;
    if (!newUsername || !/^[a-zA-Z][a-zA-Z0-9_]{2,31}$/.test(newUsername)) {
      return { ...err(1104, "Invalid username format"), username: "" };
    }
    if (usersByUsername.has(newUsername)) {
      return { ...err(1103, "Username already taken"), username: "" };
    }

    usersByUsername.delete(record.username);
    record.username = newUsername;
    record.username_changed_at = Date.now();
    record.updated_at = Date.now();
    usersByUsername.set(newUsername, record.user_id);

    return { error_code: 0, error_message: "", username: newUsername };
  },

  async CheckUsername(body) {
    const isAvailable = !usersByUsername.has(body.username);
    return { error_code: 0, error_message: "", is_available: isAvailable };
  },

  async SearchUsers(body) {
    const query = (body.query || "").toLowerCase();
    const limit = Math.min(body.limit || 20, 50);
    const offsetId = body.offset_id || 0;

    const results = [];
    for (const [, record] of usersById) {
      if (record.is_deleted) continue;
      if (record.user_id >= offsetId) continue;  // offset_id 分页
      if (record.username.toLowerCase().startsWith(query) ||
          record.first_name.toLowerCase().startsWith(query)) {
        results.push(userToProfile(record));
      }
    }

    results.sort((a, b) => b.user_id - a.user_id);
    const paged = results.slice(0, limit);
    return {
      error_code: 0,
      error_message: "",
      users: paged,
      has_more: results.length > limit,
    };
  },

  async ChangePassword(body) {
    const record = usersById.get(body.user_id);
    if (!record) return { ...err(1101, "User not found") };

    if (record.password_hash !== "mock_hash_" + body.old_password) {
      return { ...err(1006, "Invalid old password") };
    }
    if (!body.new_password || body.new_password.length < 8 || body.new_password.length > 128) {
      return { ...err(1006, "New password must be 8-128 characters") };
    }

    record.password_hash = "mock_hash_" + body.new_password;
    record.updated_at = Date.now();

    // 清除所有 Session (安全措施)
    for (const [token, s] of sessions) {
      if (s.user_id === body.user_id) sessions.delete(token);
    }

    return { error_code: 0, error_message: "" };
  },

  async DeleteAccount(body) {
    const record = usersById.get(body.user_id);
    if (!record) return { ...err(1101, "User not found") };

    if (record.password_hash !== "mock_hash_" + body.password) {
      return { ...err(1006, "Invalid password") };
    }

    record.is_deleted = true;
    usersByUsername.delete(record.username);

    for (const [token, s] of sessions) {
      if (s.user_id === body.user_id) sessions.delete(token);
    }

    return { error_code: 0, error_message: "" };
  },
};

// ============================================================================
// HTTP Server (模拟 bRPC HTTP+pb 端点)
// ============================================================================

const PORT = parseInt(process.env.PORT || "8001", 10);
const SERVICE_PATH = "/nova.user.UserService/";

const server = http.createServer(async (req, res) => {
  res.setHeader("Content-Type", "application/json");

  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  // Health check
  if (req.method === "GET" && req.url === "/status") {
    res.writeHead(200);
    res.end(JSON.stringify({ status: "ok", service: "mock-user-service", online_count: usersById.size }));
    return;
  }

  // RPC dispatch
  if (req.method === "POST" && req.url.startsWith(SERVICE_PATH)) {
    const method = req.url.slice(SERVICE_PATH.length);
    const handler = handlers[method];

    if (!handler) {
      res.writeHead(404);
      res.end(JSON.stringify(err(1201, `Unknown method: ${method}`)));
      return;
    }

    try {
      const body = await parseBody(req);
      console.log(`[${new Date().toISOString()}] ${method}`, JSON.stringify(body).slice(0, 200));
      const result = await handler(body);
      res.writeHead(200);
      res.end(JSON.stringify(result));
    } catch (e) {
      console.error(`[ERROR] ${method}:`, e.message);
      res.writeHead(500);
      res.end(JSON.stringify(err(5001, e.message)));
    }
    return;
  }

  // 404
  res.writeHead(404);
  res.end(JSON.stringify(err(1201, "Not found")));
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Mock User Service running on port ${PORT}`);
  console.log(`   Health:  http://localhost:${PORT}/status`);
  console.log(`   RPC:     POST http://localhost:${PORT}/nova.user.UserService/{Method}`);
  console.log(`   Methods: ${Object.keys(handlers).join(", ")}`);
});
