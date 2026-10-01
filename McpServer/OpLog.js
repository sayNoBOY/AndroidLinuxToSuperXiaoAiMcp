/**
 * 随身互联 — 全局操作日志（operation_log）
 *
 * 覆盖本服务**所有业务接口**（登录认证 / 任务管理 / 参考物上传 / MCP / 系统操作），
 * 在应用层挂 res 'finish' 中间件统一留痕：动作（action）按「方法 + 路径」识别成
 * 中文功能名（见 ACTION_RULES），响应后异步写入 operation_log；读取端在 SysApi。
 * 例外：「我的」页 10s 轮询的 status/metrics 与大模型信息读取 llm 不记录（打开页面即刷屏）。
 *
 * 路由识别用 `METHOD + originalUrl(去query)` 对有序正则表匹配 —— 不依赖
 * req.route / req.baseUrl（路由分发结束后 baseUrl 可能已被回收，finish 时取值不稳）。
 *
 *   mountOperationLog(app)   建表 + 种子 + 7天清理 + 应用层中间件（幂等，可重复调）
 *   ensureOperationLog()     只建表/种子（SysApi 读取前确保表存在）
 *
 * 不记录：OPTIONS 预检、未匹配到业务规则的请求（404 兜底等）。
 * 敏感字段（pass/token/secret/auth 键名）写 params 前掩码为 ***。
 *
 * 挂载：http-server.js / 各独立入口在 express.json 之后、业务路由之前调用
 *       mountOperationLog(app) —— 必须先于路由注册，finish 监听才对所有请求生效。
 */
import { getDb } from "./LoginApi.js";

const SERVER_ID = 1; // 文档：单服务器（serverId=1）
const LOG_KEEP_DAYS = 7; // 数据库文档 §7.2：操作日志保留 7 天

let db = null;
let wired = false;
let ensured = false;
let pruneTimer = null;

// ---------------------------------------------------------------------------
// 中文动作映射：有序正则表（先匹配先生效，带参数的模式放精确规则之后）
// path = 写入 api_path 的路由模式（聚合友好），action = 中文功能名
// ---------------------------------------------------------------------------

const ACTION_RULES = [
  // —— 登录认证（LoginApi /api/v1/auth）——
  { re: /^POST \/api\/v1\/auth\/login$/, path: "/api/v1/auth/login", action: "登录" },
  { re: /^POST \/api\/v1\/auth\/refresh$/, path: "/api/v1/auth/refresh", action: "刷新访问令牌" },
  { re: /^POST \/api\/v1\/auth\/logout$/, path: "/api/v1/auth/logout", action: "退出登录" },
  { re: /^GET \/api\/v1\/auth\/me$/, path: "/api/v1/auth/me", action: "获取当前用户信息" },

  // —— 任务管理（TaskApi /api/v1/tasks）——
  { re: /^GET \/api\/v1\/tasks$/, path: "/api/v1/tasks", action: "查询任务列表" },
  { re: /^POST \/api\/v1\/tasks$/, path: "/api/v1/tasks", action: "创建任务" },
  // completed 必须在通配 :taskId 之前（DELETE /tasks/completed 两者都能匹配）
  { re: /^DELETE \/api\/v1\/tasks\/completed$/, path: "/api/v1/tasks/completed", action: "清空已完成任务" },
  { re: /^GET \/api\/v1\/tasks\/[^/]+$/, path: "/api/v1/tasks/:taskId", action: "查看任务详情" },
  { re: /^POST \/api\/v1\/tasks\/[^/]+\/send$/, path: "/api/v1/tasks/:taskId/send", action: "发送任务消息" },
  { re: /^GET \/api\/v1\/tasks\/[^/]+\/messages$/, path: "/api/v1/tasks/:taskId/messages", action: "查看消息记录" },
  { re: /^PUT \/api\/v1\/tasks\/[^/]+\/cancel$/, path: "/api/v1/tasks/:taskId/cancel", action: "取消任务" },
  { re: /^DELETE \/api\/v1\/tasks\/[^/]+$/, path: "/api/v1/tasks/:taskId", action: "删除任务" },
  { re: /^GET \/api\/v1\/tasks\/[^/]+\/artifacts$/, path: "/api/v1/tasks/:taskId/artifacts", action: "查看任务产物" },
  {
    re: /^GET \/api\/v1\/tasks\/[^/]+\/artifacts\/[^/]+\/download$/,
    path: "/api/v1/tasks/:taskId/artifacts/:artifactId/download",
    action: "下载任务产物",
  },

  // —— 参考物分步上传（TaskApi /api/v1/uploads）——
  { re: /^POST \/api\/v1\/uploads$/, path: "/api/v1/uploads", action: "上传参考物" },

  // —— 系统状态 / 我的 Tab（SysApi /api/v1/server）——
  // status/metrics 是「我的」页 10s 轮询，不记（否则打开页面即刷屏，
  // 用户明确要求剔除）；只留用户主动操作：查日志、重启服务器。
  { re: /^GET \/api\/v1\/server\/logs\/all$/, path: "/api/v1/server/logs/all", action: "查询全部日志" },
  { re: /^GET \/api\/v1\/server\/logs$/, path: "/api/v1/server/logs", action: "查询最近日志" },
  { re: /^POST \/api\/v1\/server\/reboot$/, path: "/api/v1/server/reboot", action: "重启服务器" },
  // /server/llm 是页面读取（模型目录 60s 缓存），与 status/metrics 同规则不记；
  // 只有用户主动「切换大模型」才留痕。
  { re: /^POST \/api\/v1\/server\/llm\/model$/, path: "/api/v1/server/llm/model", action: "切换大模型" },
  { re: /^POST \/api\/v1\/server\/llm\/provider$/, path: "/api/v1/server/llm/provider", action: "新增大模型" },
  { re: /^POST \/api\/v1\/server\/llm\/provider\/remove$/, path: "/api/v1/server/llm/provider/remove", action: "删除大模型" },

  // —— MCP（POST /mcp：动作按 JSON-RPC 方法/工具动态识别，见 mcpAction）——
  { re: /^POST \/mcp$/, path: "/mcp", action: null },
];

// MCP 工具名 → 中文（tools/call 时识别）
const MCP_TOOL_CN = {
  run_command: "执行命令",
  get_find_file: "查找文件",
  ask_mimocode: "咨询MiMoCode",
  video_upload: "上传视频",
};

function mcpAction(req) {
  const b = req.body;
  const msg = Array.isArray(b) ? b[0] : b;
  const method = typeof msg?.method === "string" ? msg.method : "";
  const tool = msg?.params?.name;
  if (method === "tools/call") {
    const cn = MCP_TOOL_CN[tool];
    return cn ? `调用工具：${cn}` : `调用工具：${tool ?? "未知"}`;
  }
  if (method === "tools/list") return "查询可用工具";
  if (method === "initialize") return "初始化MCP会话";
  if (method === "ping") return "MCP心跳";
  if (method) return `MCP请求（${method}）`;
  return "MCP请求";
}

/** 识别本次请求的中文动作与路由模式；未匹配返回 null（不记录） */
function identify(req) {
  const rawPath = (req.originalUrl || req.url || "").split("?")[0];
  const key = `${req.method} ${rawPath}`;
  for (const rule of ACTION_RULES) {
    if (!rule.re.test(key)) continue;
    const action = rule.action ?? mcpAction(req);
    return { action, routePath: rule.path };
  }
  return null;
}

// ---------------------------------------------------------------------------
// 文档业务错误码映射 + 参数掩码（写入前）
// ---------------------------------------------------------------------------

const DOC_CODE_BY_TYPE = {
  INVALID_REQUEST: 1001,
  MISSING_TOKEN: 1002,
  AUTH_EXPIRED: 1002,
  AUTH_INVALID: 1002,
  SERVER_NOT_FOUND: 2001,
  SERVER_STATE_INVALID: 2002,
  REBOOT_IN_PROGRESS: 2003,
  INTERNAL_ERROR: 5000,
};

function docResultCode(payload, statusCode) {
  if (statusCode >= 200 && statusCode < 300) return 0;
  const type = payload?.error?.type;
  if (type && DOC_CODE_BY_TYPE[type] != null) return DOC_CODE_BY_TYPE[type];
  return payload?.code ?? statusCode;
}

function sanitizeParams(req) {
  // multipart（express.raw）请求体是 Buffer：绝不能 Object.entries —— 50MB 会逐字节展开
  const bodyIsBinary =
    typeof Buffer !== "undefined" && Buffer.isBuffer(req.body);
  const src = {};
  if (req.query && typeof req.query === "object") Object.assign(src, req.query);
  if (req.body && typeof req.body === "object" && !bodyIsBinary) {
    Object.assign(src, req.body);
  } else if (bodyIsBinary) {
    src.body = "<binary>";
  }
  const out = {};
  for (const [k, v] of Object.entries(src)) {
    if (/pass|token|secret|auth/i.test(k)) {
      out[k] = "***";
    } else if (typeof v === "string") {
      out[k] = v.length > 500 ? `${v.slice(0, 500)}…` : v;
    } else if (typeof v === "number" || typeof v === "boolean" || v == null) {
      out[k] = v;
    } else if (Array.isArray(v)) {
      out[k] = `<array:${v.length}>`;
    } else {
      out[k] = "<object>"; // 大对象（含 base64 请求体）只留占位，避免日志膨胀
    }
  }
  return JSON.stringify(out).slice(0, 2000);
}

// ---------------------------------------------------------------------------
// 建表 / 种子 / 清理（幂等）
// ---------------------------------------------------------------------------

export function ensureOperationLog() {
  if (ensured) return;
  db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS operation_log (
      op_id         INTEGER PRIMARY KEY AUTOINCREMENT,
      request_id    TEXT,
      server_id     INTEGER NOT NULL DEFAULT 1,
      api_path      TEXT NOT NULL,
      http_method   TEXT NOT NULL,
      action        TEXT NOT NULL,
      content       TEXT NOT NULL,
      params        TEXT,
      result_code   INTEGER NOT NULL,
      result_msg    TEXT,
      duration_ms   INTEGER NOT NULL DEFAULT 0,
      operator      TEXT,
      device_id     TEXT,
      client_ip     TEXT,
      occurred_at   TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      created_at    TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );
    CREATE INDEX IF NOT EXISTS idx_op_time        ON operation_log (occurred_at DESC);
    CREATE INDEX IF NOT EXISTS idx_op_server_time ON operation_log (server_id, occurred_at DESC);
    CREATE INDEX IF NOT EXISTS idx_op_api_time    ON operation_log (api_path, occurred_at DESC);
    CREATE INDEX IF NOT EXISTS idx_op_result      ON operation_log (result_code, occurred_at DESC);
  `);

  // 首次初始化：写入数据库文档 §5 的种子数据（页面日志区有初始内容）
  const count = db.prepare("SELECT COUNT(*) AS n FROM operation_log").get().n;
  if (count === 0) {
    const rows = [
      ["req-seed-01", "/api/v1/server/status", "GET", "查看服务器状态", "查看服务器状态成功", "{}", 0, "success", 12, "dev-seed", "192.168.1.56", "2026-09-28 09:41:22"],
      ["req-seed-02", "/api/v1/server/metrics", "GET", "查看资源使用率", "查看资源使用率成功", "{}", 0, "success", 9, "dev-seed", "192.168.1.56", "2026-09-28 09:41:22"],
      ["req-seed-03", "/api/v1/server/logs", "GET", "查询最近日志", "查询最近日志成功", '{"limit":5}', 0, "success", 6, "dev-seed", "192.168.1.56", "2026-09-28 09:41:23"],
      ["req-seed-04", "/api/v1/server/reboot", "POST", "重启服务器", "重启服务器成功", '{"serverId":1,"confirm":true}', 0, "success", 86, "dev-seed", "192.168.1.56", "2026-09-28 09:42:01"],
      ["req-seed-05", "/api/v1/server/reboot", "POST", "重启服务器", "重启服务器：重启任务已存在，重复触发", '{"serverId":1,"confirm":true}', 2003, "重启任务已存在，重复触发", 4, "dev-seed", "192.168.1.56", "2026-09-28 09:42:05"],
    ];
    const stmt = db.prepare(`
      INSERT INTO operation_log
        (request_id, server_id, api_path, http_method, action, content, params,
         result_code, result_msg, duration_ms, device_id, client_ip, occurred_at)
      VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const r of rows) stmt.run(...r);
  }
  ensured = true;
}

// ---------------------------------------------------------------------------
// 留痕写入：res finish 后异步落库（写失败只告警，不影响接口）
// ---------------------------------------------------------------------------

function recordOperation(req, res, payload, durationMs) {
  setImmediate(() => {
    try {
      const ided = identify(req);
      if (!ided) return; // 未匹配业务路由的请求不记（如 404 兜底）

      const success = res.statusCode >= 200 && res.statusCode < 300;
      const message = payload?.message || payload?.error?.detail || "";
      const content = success ? `${ided.action}成功` : `${ided.action}：${message || "失败"}`;

      db.prepare(`
        INSERT INTO operation_log
          (request_id, server_id, api_path, http_method, action, content, params,
           result_code, result_msg, duration_ms, operator, device_id, client_ip)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        req.headers["x-request-id"] || null,
        SERVER_ID,
        ided.routePath,
        req.method,
        ided.action,
        content,
        sanitizeParams(req),
        docResultCode(payload, res.statusCode),
        message || null,
        durationMs,
        req.user?.username ?? null,
        req.headers["x-device-id"] || null,
        req.ip || null
      );
    } catch (e) {
      console.error("[OpLog] operation_log 写入失败:", e.message);
    }
  });
}

/**
 * 挂载全局操作日志（幂等）。必须在 express.json 之后、业务路由之前调用，
 * 否则 finish 监听挂不上已完成的响应。
 */
export function mountOperationLog(app) {
  ensureOperationLog();

  if (!pruneTimer) {
    const prune = () => {
      try {
        db.prepare("DELETE FROM operation_log WHERE occurred_at < datetime('now', ?)").run(
          `-${LOG_KEEP_DAYS} days`
        );
      } catch (e) {
        console.error("[OpLog] operation_log 清理失败:", e.message);
      }
    };
    prune();
    pruneTimer = setInterval(prune, 6 * 3600_000);
    pruneTimer.unref?.();
  }

  if (wired) return;
  wired = true;

  app.use((req, res, next) => {
    if (req.method === "OPTIONS") return next();
    const start = Date.now();
    const origJson = res.json.bind(res);
    let payload = null;
    res.json = (body) => {
      payload = body;
      return origJson(body);
    };
    res.on("finish", () => recordOperation(req, res, payload, Date.now() - start));
    next();
  });
}
