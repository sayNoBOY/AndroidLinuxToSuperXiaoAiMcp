/**
 * 随身互联 — 登录认证接口（依据《登录接口文档-v2.md》实现）
 *
 *   POST /api/v1/auth/login    用户登录，获取 access_token / refresh_token
 *   POST /api/v1/auth/refresh  刷新 access_token
 *   POST /api/v1/auth/logout   退出登录，使 Token 失效（需 Bearer）
 *   GET  /api/v1/auth/me       获取当前登录用户信息（需 Bearer）
 *
 * 数据库：SQLite（Node 内置 node:sqlite），库文件默认 data/suishen.db（可用 DB_PATH 覆盖）
 * 密码：scrypt 哈希（文档中的 bcrypt 示例哈希无法离线校验，首启自动重建为 scrypt）
 *
 * 挂载方式：import { mountLoginApi } from "./LoginApi.js"; mountLoginApi(app);
 * 独立运行：node LoginApi.js  （默认 0.0.0.0:3000，与文档 Base URL 一致）
 * 导出：getDb / requireAuth / verifyAccessToken / isPrivateOrigin（TaskApi.js 复用认证与 CORS 策略）
 */
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { randomBytes, scryptSync, timingSafeEqual, createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { SignJWT, jwtVerify } from "jose";
import express from "express";
import cors from "cors";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DB_PATH = process.env.DB_PATH || path.join(__dirname, "data", "suishen.db");
const SECRET_PATH = process.env.JWT_SECRET_FILE || path.join(__dirname, "data", ".jwt_secret");
const ACCESS_TTL_SEC = 7200; // 文档：access_token 2 小时
const REFRESH_TTL_SEC = 30 * 24 * 3600; // 文档：refresh_token 30 天
const MAX_LOGIN_FAILURES = 5; // 文档 3.5：连续 5 次密码错误
const LOCK_MINUTES = 15; // 锁定 15 分钟
const SINGLE_DEVICE_LOGIN = process.env.SINGLE_DEVICE_LOGIN === "1";

// ---------------------------------------------------------------------------
// 通用响应结构：{ code, message, data, timestamp } / 错误 { code, message, error }
// ---------------------------------------------------------------------------

const pad = (n) => String(n).padStart(2, "0");

function nowISO() {
  // 文档要求 ISO 8601 且带 +08:00 偏移
  const d = new Date();
  const t = new Date(d.getTime() + (8 * 60 + d.getTimezoneOffset()) * 60000);
  return (
    `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}` +
    `T${pad(t.getHours())}:${pad(t.getMinutes())}:${pad(t.getSeconds())}+08:00`
  );
}

function ok(res, data = null) {
  res.json({ code: 200, message: "success", data, timestamp: nowISO() });
}

function fail(res, status, message, type, detail = message) {
  res.status(status).json({
    code: status,
    message,
    error: { type, detail },
  });
}

function badRequest(res, message = "请求参数错误") {
  return fail(res, 400, message, "INVALID_REQUEST");
}

// ---------------------------------------------------------------------------
// 数据库连接与初始化
// ---------------------------------------------------------------------------

let db = null;

function ensureColumns(table, columns) {
  const have = new Set(
    db.prepare(`PRAGMA table_info(${table})`).all().map((r) => r.name)
  );
  for (const [name, ddl] of Object.entries(columns)) {
    if (!have.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${ddl}`);
  }
}

function hashPassword(plain) {
  const salt = randomBytes(16).toString("hex");
  return `scrypt$${salt}$${scryptSync(plain, salt, 64).toString("hex")}`;
}

function verifyPassword(plain, stored) {
  const parts = (stored || "").split("$");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false; // 非本实现格式（如文档示例的 bcrypt）无法校验
  const cand = scryptSync(plain, parts[1], 64);
  const expect = Buffer.from(parts[2], "hex");
  return cand.length === expect.length && timingSafeEqual(cand, expect);
}

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

function seedAdmin() {
  const exists = db.prepare("SELECT user_id FROM users WHERE username = ?").get("admin");
  if (exists) return;
  const password = process.env.ADMIN_PASSWORD || "admin123";
  db.prepare(
    "INSERT INTO users (username, password_hash, nickname, role) VALUES (?, ?, ?, 'admin')"
  ).run("admin", hashPassword(password), "管理员");
  console.log(`[LoginApi] 已创建默认管理员 admin（密码: ${password}），生产部署请立即修改`);
}

export function getDb() {
  if (db) return db;

  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  db = new DatabaseSync(DB_PATH);
  try {
    db.exec("PRAGMA journal_mode = WAL;");
  } catch {
    // WAL 不可用时退回默认日志模式
  }
  db.exec("PRAGMA foreign_keys = ON;");

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      user_id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      nickname TEXT,
      role TEXT DEFAULT 'user',
      is_active INTEGER DEFAULT 1,
      avatar TEXT,
      failed_attempts INTEGER DEFAULT 0,
      locked_until TEXT,
      last_login_at TEXT,
      created_at TEXT DEFAULT (datetime('now', 'localtime')),
      updated_at TEXT DEFAULT (datetime('now', 'localtime'))
    );

    CREATE TABLE IF NOT EXISTS refresh_tokens (
      token_id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      token_hash TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now', 'localtime')),
      FOREIGN KEY (user_id) REFERENCES users(user_id)
    );

    CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
    CREATE INDEX IF NOT EXISTS idx_refresh_user ON refresh_tokens(user_id);
  `);

  // 兼容旧库：补齐文档之外但接口需要的列
  ensureColumns("users", {
    avatar: "TEXT",
    failed_attempts: "INTEGER DEFAULT 0",
    locked_until: "TEXT",
    last_login_at: "TEXT",
  });

  seedAdmin();
  return db;
}

function getJwtSecret() {
  if (process.env.JWT_SECRET) return new TextEncoder().encode(process.env.JWT_SECRET);
  try {
    const existing = fs.readFileSync(SECRET_PATH, "utf-8").trim();
    if (existing) return new TextEncoder().encode(existing);
  } catch { /* 首次运行，下面生成 */ }
  const secret = randomBytes(32).toString("hex");
  fs.mkdirSync(path.dirname(SECRET_PATH), { recursive: true });
  fs.writeFileSync(SECRET_PATH, secret, { mode: 0o600 });
  return new TextEncoder().encode(secret);
}

// ---------------------------------------------------------------------------
// Token：签发、校验、吊销
// ---------------------------------------------------------------------------

// jti -> 过期时间(ms)。access_token 为无状态 JWT，退出登录时靠该集合立即失效。
const revoked = new Map();

function purgeRevoked() {
  const now = Date.now();
  for (const [jti, exp] of revoked) if (exp <= now) revoked.delete(jti);
}

function signToken(secret, payload, ttlSec, sub) {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(String(sub))
    .setIssuer("suishen")
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + ttlSec)
    .sign(secret);
}

async function createAccessToken(secret, user) {
  const jti = randomBytes(16).toString("hex");
  const token = await signToken(
    secret,
    { type: "access", jti, username: user.username, role: user.role },
    ACCESS_TTL_SEC,
    user.user_id
  );
  return { token, jti };
}

async function createRefreshToken(secret, user) {
  const jti = randomBytes(16).toString("hex");
  const token = await signToken(secret, { type: "refresh", jti }, REFRESH_TTL_SEC, user.user_id);
  db.prepare(
    "INSERT INTO refresh_tokens (token_id, user_id, token_hash, expires_at) VALUES (?, ?, ?, ?)"
  ).run(jti, user.user_id, sha256(token), new Date(Date.now() + REFRESH_TTL_SEC * 1000).toISOString());
  return { token, jti };
}

function publicUser(row) {
  return {
    user_id: row.user_id,
    username: row.username,
    nickname: row.nickname,
    avatar: row.avatar ?? null,
    role: row.role,
    created_at: row.created_at,
    last_login_at: row.last_login_at ?? null,
  };
}

/**
 * 校验 access_token：签名、类型、吊销、用户存在。
 * 成功返回 { payload, user }；失败抛出带 api = { status, message, type, detail } 的错误。
 * 供 requireAuth（HTTP）与 TaskApi 的 WebSocket 握手复用。
 */
export async function verifyAccessToken(token, secret = getJwtSecret()) {
  const apiError = (message, type, detail = message) => {
    const err = new Error(detail);
    err.api = { status: 401, message, type, detail };
    return err;
  };

  let payload;
  try {
    ({ payload } = await jwtVerify(token, secret));
  } catch (e) {
    if (e?.code === "ERR_JWT_EXPIRED") throw apiError("Token expired", "AUTH_EXPIRED", "访问令牌已过期");
    throw apiError("Token invalid", "AUTH_INVALID", "访问令牌无效");
  }

  purgeRevoked();
  if (payload.type !== "access" || revoked.has(payload.jti)) {
    throw apiError("Token invalid", "AUTH_INVALID", "访问令牌无效或已退出登录");
  }

  const user = getDb().prepare("SELECT * FROM users WHERE user_id = ?").get(Number(payload.sub));
  if (!user) throw apiError("Token invalid", "AUTH_INVALID", "用户不存在");

  return { payload, user };
}

export async function requireAuth(req, res, next) {
  try {
    const header = req.headers.authorization || "";
    const m = /^Bearer\s+(.+)$/i.exec(header);
    if (!m) return fail(res, 401, "缺少访问令牌", "MISSING_TOKEN");

    let result;
    try {
      result = await verifyAccessToken(m[1], req.app.locals.loginSecret);
    } catch (e) {
      if (e.api) return fail(res, e.api.status, e.api.message, e.api.type, e.api.detail);
      throw e;
    }

    req.auth = result.payload;
    req.user = result.user;
    next();
  } catch (e) {
    next(e);
  }
}

// ---------------------------------------------------------------------------
// 路由
// ---------------------------------------------------------------------------

export function isPrivateOrigin(origin, cb) {
  if (!origin) return cb(null, true); // 原生客户端不带 Origin
  let host;
  try {
    host = new URL(origin).hostname;
  } catch {
    return cb(null, false);
  }
  if (host === "localhost" || host === "127.0.0.1" || host === "::1") return cb(null, true);
  if (host.endsWith(".local")) return cb(null, true);
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const [a, b] = [+ipv4[1], +ipv4[2]];
    const okRange =
      a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
    return cb(null, okRange);
  }
  cb(null, false); // 文档 3.5：CORS 仅允许局域网内网段
}

/**
 * 把登录认证接口挂载到 app 上（前缀 /api/v1/auth）。
 * 返回 { db }，便于调用方复用同一个 SQLite 连接。
 */
export function mountLoginApi(app) {
  const database = getDb();
  const secret = getJwtSecret();
  app.locals.loginSecret = secret;

  const router = express.Router();
  router.use(express.json());
  router.use(
    cors({
      origin: isPrivateOrigin,
      methods: ["GET", "POST", "OPTIONS"],
      allowedHeaders: ["Authorization", "Content-Type"],
    })
  );

  // POST /api/v1/auth/login
  router.post("/login", async (req, res) => {
    const { username, password } = req.body ?? {};
    if (typeof username !== "string" || !username.trim() || typeof password !== "string" || !password) {
      return badRequest(res, "username 与 password 为必填字段");
    }

    const user = database.prepare("SELECT * FROM users WHERE username = ?").get(username.trim());

    if (user && user.locked_until && new Date(user.locked_until).getTime() > Date.now()) {
      return fail(
        res, 401,
        "账号已锁定", "ACCOUNT_LOCKED",
        `连续 ${MAX_LOGIN_FAILURES} 次密码错误，账号锁定至 ${user.locked_until}`
      );
    }

    if (!user || !verifyPassword(password, user.password_hash)) {
      if (user) {
        // 记录失败次数，达到阈值则锁定
        const attempts = (user.failed_attempts || 0) + 1;
        if (attempts >= MAX_LOGIN_FAILURES) {
          database
            .prepare("UPDATE users SET failed_attempts = 0, locked_until = ?, updated_at = datetime('now','localtime') WHERE user_id = ?")
            .run(new Date(Date.now() + LOCK_MINUTES * 60000).toISOString(), user.user_id);
        } else {
          database
            .prepare("UPDATE users SET failed_attempts = ?, updated_at = datetime('now','localtime') WHERE user_id = ?")
            .run(attempts, user.user_id);
        }
      }
      return fail(res, 401, "用户名或密码错误", "INVALID_CREDENTIALS");
    }

    if (user.is_active !== 1) {
      return fail(res, 403, "账号已禁用", "ACCOUNT_DISABLED");
    }

    database
      .prepare("UPDATE users SET failed_attempts = 0, locked_until = NULL, last_login_at = ?, updated_at = datetime('now','localtime') WHERE user_id = ?")
      .run(nowISO(), user.user_id);

    if (SINGLE_DEVICE_LOGIN) {
      database.prepare("DELETE FROM refresh_tokens WHERE user_id = ?").run(user.user_id);
    }

    const access = await createAccessToken(secret, user);
    const refresh = await createRefreshToken(secret, user);

    return ok(res, {
      access_token: access.token,
      refresh_token: refresh.token,
      token_type: "Bearer",
      expires_in: ACCESS_TTL_SEC,
      user: {
        user_id: user.user_id,
        username: user.username,
        nickname: user.nickname,
        avatar: user.avatar ?? null,
      },
    });
  });

  // POST /api/v1/auth/refresh
  router.post("/refresh", async (req, res) => {
    const { refresh_token } = req.body ?? {};
    if (typeof refresh_token !== "string" || !refresh_token) {
      return badRequest(res, "refresh_token 为必填字段");
    }

    let payload;
    try {
      ({ payload } = await jwtVerify(refresh_token, secret));
    } catch {
      return fail(res, 401, "Refresh token invalid or expired", "INVALID_REFRESH_TOKEN", "刷新令牌无效或已过期");
    }
    if (payload.type !== "refresh") {
      return fail(res, 401, "Refresh token invalid or expired", "INVALID_REFRESH_TOKEN", "刷新令牌无效或已过期");
    }

    const row = database.prepare("SELECT * FROM refresh_tokens WHERE token_id = ?").get(payload.jti);
    if (!row || row.token_hash !== sha256(refresh_token)) {
      return fail(res, 401, "Refresh token invalid or expired", "INVALID_REFRESH_TOKEN", "刷新令牌无效或已过期");
    }
    if (new Date(row.expires_at).getTime() <= Date.now()) {
      database.prepare("DELETE FROM refresh_tokens WHERE token_id = ?").run(payload.jti);
      return fail(res, 401, "Refresh token invalid or expired", "INVALID_REFRESH_TOKEN", "刷新令牌无效或已过期");
    }

    const user = database.prepare("SELECT * FROM users WHERE user_id = ?").get(row.user_id);
    if (!user) {
      return fail(res, 401, "Refresh token invalid or expired", "INVALID_REFRESH_TOKEN", "刷新令牌无效或已过期");
    }
    if (user.is_active !== 1) {
      return fail(res, 403, "账号已禁用", "ACCOUNT_DISABLED");
    }

    const access = await createAccessToken(secret, user);
    return ok(res, { access_token: access.token, expires_in: ACCESS_TTL_SEC });
  });

  // POST /api/v1/auth/logout
  router.post("/logout", requireAuth, async (req, res) => {
    // access_token 立即失效（记入吊销集合）
    purgeRevoked();
    revoked.set(req.auth.jti, (req.auth.exp ?? Math.floor(Date.now() / 1000) + ACCESS_TTL_SEC) * 1000);

    const { refresh_token } = req.body ?? {};
    if (typeof refresh_token === "string" && refresh_token) {
      // 指定了 refresh_token：仅作废该条（校验归属）
      try {
        const r = await jwtVerify(refresh_token, secret);
        if (r.payload.type === "refresh") {
          database
            .prepare("DELETE FROM refresh_tokens WHERE token_id = ? AND user_id = ?")
            .run(r.payload.jti, req.user.user_id);
        }
      } catch { /* 无效的 refresh_token 忽略，access_token 照常失效 */ }
    } else {
      database.prepare("DELETE FROM refresh_tokens WHERE user_id = ?").run(req.user.user_id);
    }

    return ok(res, null);
  });

  // GET /api/v1/auth/me
  router.get("/me", requireAuth, (req, res) => {
    return ok(res, publicUser(req.user));
  });

  router.use((err, req, res, _next) => {
    console.error("[LoginApi]", err);
    if (!res.headersSent) fail(res, 500, "服务器内部错误", "INTERNAL_ERROR");
  });

  app.use("/api/v1/auth", router);
  return { db: database };
}

// 独立运行：node LoginApi.js → http://0.0.0.0:3000/api/v1/auth
const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const app = express();
  mountLoginApi(app);
  const PORT = Number(process.env.PORT) || 3000;
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Login API running at http://0.0.0.0:${PORT}/api/v1/auth`);
  });
}
