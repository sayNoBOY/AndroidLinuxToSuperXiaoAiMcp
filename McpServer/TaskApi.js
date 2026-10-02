/**
 * 随身互联 — 任务管理接口（依据《任务管理接口文档-v2.md》实现）
 *
 *   GET    /api/v1/tasks               任务列表（含 stats + 分页，需 Bearer）
 *   POST   /api/v1/uploads             参考物分步上传（multipart/form-data，需 Bearer）
 *           ≤5 个/次、≤50MB/个、≤100MB/总量；手写有界解析（express.raw 先卡 110mb）。
 *           文件暂存 taskRes/.staging/<batch_id>/（隐藏目录不入产物扫描），
 *           由 POST /tasks 或 /send 携 upload_batch 消费迁入任务目录。
 *   POST   /api/v1/tasks               创建任务 = 创建 MiMoCode 会话（需 Bearer，
 *                                       可携 upload_batch 关联参考物）
 *   GET    /api/v1/tasks/{task_id}     任务详情（需 Bearer）
 *   POST   /api/v1/tasks/{task_id}/send  发送新消息（202 受理；运行中自动排队，
 *                                        当前轮结束后按序续跑 —— 多轮会话，
 *                                        可携 upload_batch 关联参考物）
 *   GET    /api/v1/tasks/{task_id}/messages  消息历史（pending=1 为排队中）
 *   GET    /api/v1/tasks/{task_id}/usage     调用统计（每轮对话 token/费用/耗时，只读
 *                                            mimocode.db 的 message/part 表；列表与详情
 *                                            同时附 model/model_abbr —— 当前会话调用的
 *                                            大模型及其缩写，供任务卡图标展示）
 *   PUT    /api/v1/tasks/{task_id}/cancel    取消任务（终止会话并丢弃排队消息，需 Bearer）
 *   DELETE /api/v1/tasks/{task_id}     删除任务（需 Bearer）
 *   DELETE /api/v1/tasks/completed     清空已完成任务（需 Bearer）
 *   GET    /api/v1/tasks/{task_id}/artifacts  产物列表（扫描 taskRes/<id>/ 并同步表记录）
 *   GET    /api/v1/tasks/{task_id}/artifacts/{artifact_id}/download
 *           下载产物（附件下载；?inline=1 按内联预览；?token= 允许无 Authorization 头）
 *   WS     /ws/tasks?token=<access_token>&since=<seq>
 *           实时推送 + 断联中继：事件经 task_events 表落库并带全局自增 seq，
 *           重连时 since 补发断线期间的事件；缺失窗口已过期则推 task_resync
 *           要求客户端全量重拉。事件：task_created / task_message /
 *           task_state_changed / task_artifacts_changed 落库可重放；
 *           task_progress（心跳）仅实时广播不落库。
 *
 * 产物存储：taskRes/<task_id>/（McpServer 目录下，gitignore）。每个任务一个文件夹，
 * 任务创建时建目录；未指定 cwd 的任务默认在该目录执行，并向 MiMoCode 注入
 * "产物必须保存到该目录" 的系统约束（存储的用户消息保持原文，不注入）。
 * 产物表 task_artifacts 以文件系统为真相源：查看列表时扫描目录 diff 入库
 * （新增登记、变大更新 size、消失清除），下载按 artifact_id 查表取相对路径；
 * 扫描跳过 . 开头的隐藏条目（MiMoCode 在 cwd 下自建的 .mimocode/ 状态不算产物）。
 *
 * 架构：任务 = MiMoCode 会话。创建任务时同步 spawn `mimo run --format json`，
 * 首个事件返回 session_id 后即响应 201（state=running），进程在后台继续执行，
 * 结束时落库 completed/failed 并通过 WS 推送。多轮 = 顺序多次 `mimo run --session`：
 * send 立即入库返回 202，若上一轮还在跑则标记 pending 排队，finalize 后自动续跑
 * 下一条 —— 客户端断网不影响轮次执行，回复事后经消息历史/事件重放取回。
 * 无执行超时：任务跑到多久都行，只在用户 cancel 时杀进程组。
 *
 * 数据库：SQLite（复用 LoginApi 的 getDb() 连接，库文件 data/suishen.db），
 * 首次挂载自动建表 tasks / task_messages（文档 §7）。
 * 时间：字段按 datetime('now','localtime') 存储（本机 TZ=UTC），接口输出统一
 * 转成文档要求的 ISO 8601 +08:00（与登录接口口径一致）。
 *
 * 与文档的差异（均有原因）：
 * 1. tasks 表去掉 source/target 两条 devices 外键 —— devices 表尚不存在，
 *    SQLite 对缺失父表的外键引用会让所有 INSERT 失败（连值为 NULL 也不行）；
 *    设备信息改为读取时 LEFT 关联（devices 表存在才查）。
 * 2. tasks 补 cwd / model 两列 —— 文档 POST 请求体有这两个字段但表结构没有，
 *    存下来供多轮 send 续接时复用。
 * 3. WebSocket 服务端为手写最小 RFC6455 实现 —— 离线环境装不了 ws 包；Node 22
 *    内置的 undici WebSocket 只是客户端，不能作为服务端（attachTaskWs）。
 * 4. 创建会话失败（拿不到 session_id）时删除该 queued 记录并返回 500 —— 与文档
 *    失败响应（无 task_id）保持一致。
 * 5. 文档未涉及产物：新增 taskRes/<task_id>/ 目录与 task_artifacts 表、产物
 *    查看/下载接口；删除任务/清空已完成时同步清理目录与表记录。
 *
 * 挂载方式：import { mountTaskApi, attachTaskWs } from "./TaskApi.js";
 *           mountTaskApi(app); const server = app.listen(...); attachTaskWs(server);
 * 独立运行：node TaskApi.js  （会同时挂载登录接口 —— 任务接口依赖其认证）
 */
import path from "node:path";
import os from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { readdir, stat, mkdir, rm, rename, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import express from "express";
import cors from "cors";
import {
  getDb,
  requireAuth,
  verifyAccessToken,
  isPrivateOrigin,
  mountLoginApi,
} from "./LoginApi.js";
import { currentModelInfo } from "./MiMoCodeConfig.js";
import { mountOperationLog } from "./OpLog.js";
import { createNetworkWatcher } from "./NetworkWatch.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TASK_RES_DIR = path.join(__dirname, "taskRes"); // 每任务一个子目录存放产物
const UPLOAD_STAGING_DIR = path.join(TASK_RES_DIR, ".staging"); // 参考物分步上传暂存区
const UPLOAD_MAX_FILES = 5;
const UPLOAD_MAX_FILE_BYTES = 50 * 1024 * 1024; // 50MB/个
const UPLOAD_MAX_TOTAL_BYTES = 100 * 1024 * 1024; // 100MB/次
const UPLOAD_STAGING_TTL_MS = 24 * 3600_000; // 未被消费的批次 24h 后清理
const HEARTBEAT_MS = 5_000;
const EVENT_REPLAY_LIMIT = 500; // since 重放单次上限，超出即要求全量兜底
const EVENT_MAX_ROWS = 2_000; // task_events 全局保留行数上限（超出从最旧删起）
const EVENT_PRUNE_MS = 10 * 60_000;
const ACTIVE_STATES = new Set(["queued", "running"]);
const ALL_STATES = new Set(["queued", "running", "completed", "failed", "cancelled"]);

// 网络通断 → 断网挂起、恢复续跑（见文件头「断网恢复」小节）
// 恢复判据：网络回到 online 时，仍在 activeRuns 里、且静默超过 STALL_MS 的运行
// 视为"断网期间卡住"，杀掉后按 --session 续跑（不是执行超时：只在恢复瞬间对
// 静默运行生效，持续产出事件的运行永不被杀）。
const NET_RESUME_STALL_MS = 10_000; // 恢复时判定"卡住"的静默阈值
const NET_RESUME_SETTLE_MS = 8_000; // 恢复后先宽限自愈，再对仍静默的运行续跑

// ---------------------------------------------------------------------------
// 通用响应结构：{ code, message, data, timestamp } / 错误 { code, message, error }
// ---------------------------------------------------------------------------

const pad = (n) => String(n).padStart(2, "0");

// 存储的 naive 时间按 UTC 解释，输出为文档要求的 +08:00（北京）表示
function toISO(naiveUtc) {
  if (!naiveUtc) return null;
  const iso = String(naiveUtc).replace(" ", "T") + "Z";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(naiveUtc);
  const b = new Date(d.getTime() + 8 * 3600_000);
  return (
    `${b.getUTCFullYear()}-${pad(b.getUTCMonth() + 1)}-${pad(b.getUTCDate())}` +
    `T${pad(b.getUTCHours())}:${pad(b.getUTCMinutes())}:${pad(b.getUTCSeconds())}+08:00`
  );
}

function nowISO() {
  return toISO(new Date().toISOString().slice(0, 19).replace("T", " "));
}

// 毫秒时间戳差（naive UTC 字符串 → 秒）
function sinceSec(naiveUtc) {
  if (!naiveUtc) return 0;
  const t = Date.parse(String(naiveUtc).replace(" ", "T") + "Z");
  if (Number.isNaN(t)) return 0;
  return Math.max(0, Math.round((Date.now() - t) / 1000));
}

function ok(res, data = null, status = 200) {
  res.status(status).json({ code: status, message: "success", data, timestamp: nowISO() });
}

function fail(res, status, message, type, detail = message) {
  res.status(status).json({ code: status, message, error: { type, detail } });
}

function badRequest(res, message = "请求参数错误") {
  return fail(res, 400, message, "INVALID_REQUEST");
}

// ---------------------------------------------------------------------------
// 数据库：tasks / task_messages 建表（文档 §7）
// ---------------------------------------------------------------------------

let db = null;
let hasDevices = false; // devices 表由设备模块提供，存在时才做名称关联

function ensureColumns(table, columns) {
  const have = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((r) => r.name));
  for (const [name, ddl] of Object.entries(columns)) {
    if (!have.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${ddl}`);
  }
}

function ensureTaskTables() {
  db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      task_id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      icon TEXT,
      type TEXT DEFAULT 'mimocode',
      state TEXT DEFAULT 'queued',
      progress INTEGER DEFAULT 0,
      session_id TEXT,
      message TEXT,
      source_device_id INTEGER,
      target_device_id INTEGER,
      error_message TEXT,
      started_at TEXT,
      completed_at TEXT,
      duration_sec INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now', 'localtime')),
      FOREIGN KEY (user_id) REFERENCES users(user_id)
    );

    CREATE TABLE IF NOT EXISTS task_messages (
      msg_id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      mimocode_msg_id TEXT,
      created_at TEXT DEFAULT (datetime('now', 'localtime')),
      FOREIGN KEY (task_id) REFERENCES tasks(task_id)
    );

    CREATE TABLE IF NOT EXISTS task_artifacts (
      artifact_id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER NOT NULL,
      filename TEXT NOT NULL,
      rel_path TEXT NOT NULL,
      size INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now', 'localtime')),
      FOREIGN KEY (task_id) REFERENCES tasks(task_id)
    );

    CREATE TABLE IF NOT EXISTS task_events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      task_id INTEGER,
      event TEXT NOT NULL,
      data TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now', 'localtime'))
    );

    CREATE INDEX IF NOT EXISTS idx_tasks_user_state ON tasks(user_id, state);
    CREATE INDEX IF NOT EXISTS idx_tasks_session ON tasks(session_id);
    CREATE INDEX IF NOT EXISTS idx_tasks_created ON tasks(user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_taskmsg_task ON task_messages(task_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_taskart_task ON task_artifacts(task_id);
    CREATE UNIQUE INDEX IF NOT EXISTS uq_taskart_rel ON task_artifacts(task_id, rel_path);
    CREATE INDEX IF NOT EXISTS idx_tev_user_seq ON task_events(user_id, seq);
  `);
  // 文档 POST body 有 cwd/model 但表结构缺列（见文件头差异说明 2）；
  // pending = send 排队标记（1 = 已受理未派发给 mimo）；
  // attachments = 该条消息携带的参考物 JSON [{filename,size}]；
  // updated_at = 任务最近活动时间（send/派发/完成/取消时刷新，列表按它排序）
  ensureColumns("tasks", { cwd: "TEXT", model: "TEXT", updated_at: "TEXT" });
  ensureColumns("task_messages", { pending: "INTEGER DEFAULT 0", attachments: "TEXT" });
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_tasks_updated ON tasks(user_id, updated_at DESC)"
  );
  // 存量行回填：完成/开始/创建时间里取最近的语义近似
  db.exec(
    "UPDATE tasks SET updated_at = COALESCE(completed_at, started_at, created_at) " +
      "WHERE updated_at IS NULL"
  );
  mkdirSync(TASK_RES_DIR, { recursive: true });
  mkdirSync(UPLOAD_STAGING_DIR, { recursive: true });
  cleanupStaging().catch(() => {}); // 上次进程退出留下的未消费批次

  hasDevices = !!db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='devices'")
    .get();

  // 上次进程退出时残留的活跃任务 → 重启自恢复（重新入队 + --session 续跑），
  // 而非一律标失败 —— 见 recoverInterruptedTasks()
  recoverInterruptedTasks();
}

// ---------------------------------------------------------------------------
// 消息与任务的读写小工具
// ---------------------------------------------------------------------------

const formatMsgId = (id) => `msg_${String(id).padStart(3, "0")}`;

// 解析客户端传回的消息 ID：既接受 "msg_001" 也接受纯数字
function parseMsgRef(v) {
  const s = String(v);
  if (/^\d+$/.test(s)) return Number(s);
  const m = /^msg_0*(\d+)$/.exec(s);
  return m ? Number(m[1]) : null;
}

function insertMsg(taskId, role, content, mimocodeMsgId = null, pending = 0, attachments = null) {
  const r = db
    .prepare(
      "INSERT INTO task_messages (task_id, role, content, mimocode_msg_id, pending, attachments) " +
        "VALUES (?, ?, ?, ?, ?, ?)"
    )
    .run(
      taskId,
      role,
      content,
      mimocodeMsgId,
      pending ? 1 : 0,
      attachments?.length ? JSON.stringify(attachments) : null
    );
  return Number(r.lastInsertRowid);
}

function getOwnedTask(taskId, userId) {
  return db.prepare("SELECT * FROM tasks WHERE task_id = ? AND user_id = ?").get(taskId, userId);
}

// 读取 device_id → name 映射（devices 表不存在时返回空映射）
function deviceNames(userIds) {
  const map = new Map();
  const ids = [...new Set(userIds.filter((v) => v != null))];
  if (!hasDevices || ids.length === 0) return map;
  const rows = db
    .prepare(
      `SELECT device_id, name FROM devices WHERE user_id = ? AND device_id IN (${ids.map(() => "?").join(",")})`
    )
    .all(userId, ...ids);
  for (const r of rows) map.set(r.device_id, r.name);
  return map;
}

const deviceObj = (id, names) => (id == null ? null : { device_id: id, name: names.get(id) ?? null });

/** 刷新任务更新时间（send 受理 / 派发新轮次 / 取消时调用，驱动列表排序） */
function touchTask(taskId) {
  db.prepare(
    "UPDATE tasks SET updated_at = datetime('now', 'localtime') WHERE task_id = ?"
  ).run(taskId);
}

// 重启恢复：先在建表阶段收集，等 mountTaskApi 里 netWatch 就绪后统一派发
const recoveredTaskIds = [];

/**
 * 服务重启自恢复（替代"残留活跃任务一律标失败"）：
 *  - 有 session_id 且存在未完成轮次（没有任何 assistant 回复排在其后的 user 消息，
 *    含重启前已在跑的那条和原排队的）→ 全部重新置 pending、state 回 queued，
 *    由 dispatchNext 用 --session 重发原消息续跑（断网则 pending 保留，
 *    网络恢复后 resumeStalledRuns 补派 —— 与断网恢复同一条实测路径）；
 *  - 无 session_id（会话未建起来）→ 无法续接，维持旧策略标失败；
 *  - 活跃态但回复已全部入库（finalize 未及执行）→ 直接判完成。
 */
function recoverInterruptedTasks() {
  const rows = db
    .prepare("SELECT task_id, session_id FROM tasks WHERE state IN ('queued','running')")
    .all();
  for (const t of rows) {
    if (!t.session_id) {
      db.prepare(
        "UPDATE tasks SET state='failed', error_message='服务重启导致任务中断（无会话，无法续跑）', " +
          "completed_at=datetime('now','localtime') WHERE task_id=?"
      ).run(t.task_id);
      db.prepare("UPDATE task_messages SET pending=0 WHERE task_id=? AND pending=1").run(t.task_id);
      continue;
    }
    const openMsgs = db
      .prepare(
        "SELECT msg_id, pending FROM task_messages WHERE task_id = ? AND role = 'user' " +
          "AND NOT EXISTS (" +
          "  SELECT 1 FROM task_messages a " +
          "  WHERE a.task_id = task_messages.task_id AND a.role = 'assistant' AND a.msg_id > task_messages.msg_id" +
          ") ORDER BY msg_id"
      )
      .all(t.task_id);
    if (openMsgs.length === 0) {
      db.prepare(
        "UPDATE tasks SET state='completed', progress=100, error_message=NULL, " +
          "completed_at=datetime('now','localtime') WHERE task_id=?"
      ).run(t.task_id);
      continue;
    }
    for (const m of openMsgs) {
      if (!m.pending) db.prepare("UPDATE task_messages SET pending=1 WHERE msg_id=?").run(m.msg_id);
    }
    db.prepare(
      "UPDATE tasks SET state='queued', error_message=NULL, completed_at=NULL, " +
        "updated_at=datetime('now','localtime') WHERE task_id=?"
    ).run(t.task_id);
    recoveredTaskIds.push(t.task_id);
  }
  if (recoveredTaskIds.length > 0) {
    console.log(
      `[TaskApi] 重启恢复：${recoveredTaskIds.length} 个任务的中断轮次已重新排队，将用 --session 续跑`
    );
  }
}

function rowToApi(row, names, { detail = false } = {}) {
  const out = {
    task_id: row.task_id,
    name: row.name,
    icon: row.icon ?? null,
    type: row.type,
    state: row.state,
    progress: row.progress ?? 0,
    session_id: row.session_id ?? null,
    started_at: row.started_at ? toISO(row.started_at) : null,
    duration_sec:
      row.state === "running" || row.state === "queued"
        ? sinceSec(row.started_at || row.created_at)
        : row.duration_sec ?? 0,
    source_device: deviceObj(row.source_device_id, names),
    target_device: deviceObj(row.target_device_id, names),
    created_at: toISO(row.created_at),
    updated_at: toISO(row.updated_at ?? row.created_at),
  };
  if (detail) {
    out.message = row.message ?? null;
    out.error_message = row.error_message ?? null;
    out.completed_at = row.completed_at ? toISO(row.completed_at) : null;
  }
  return out;
}

// ---------------------------------------------------------------------------
// 大模型调用统计：只读 MiMoCode 的 mimocode.db（message/part 表）
//   - 会话当前模型：取该会话最近一条带 modelID 的助手消息（有索引，极快）
//   - 每轮统计：user 消息 = 一轮；助手消息按 parentID 归轮（parent 不在本会话
//     的按时间窗就近归入）；只计 tokens/cost 实际产生用量的消息（占位消息跳过）
//   - 库不可读时降级：图标回落任务 model / 配置当前模型，usage 返回 503
// ---------------------------------------------------------------------------

let mimocodeDb = null;
let mimocodeDbTried = false;

function getMimocodeDb() {
  if (mimocodeDb || mimocodeDbTried) return mimocodeDb;
  mimocodeDbTried = true;
  // 与 MiMoCodeConfig.baseDirs 同口径：MIMOCODE_HOME/data → XDG_DATA_HOME → ~/.local/share
  const dataDir =
    process.env.MIMOCODE_HOME && path.isAbsolute(process.env.MIMOCODE_HOME)
      ? path.join(process.env.MIMOCODE_HOME, "data")
      : process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share");
  try {
    mimocodeDb = new DatabaseSync(path.join(dataDir, "mimocode", "mimocode.db"), {
      readOnly: true,
    });
  } catch (e) {
    console.error(`[TaskApi] mimocode.db 不可读（${e.message}），调用统计降级`);
  }
  return mimocodeDb;
}

/** 大模型缩写：按 [-_] 分段取首字母，版本段去点保留（mimo-v2.6-flash → MV26F） */
function modelAbbrOf(modelId) {
  if (!modelId) return null;
  const parts = String(modelId).split(/[-_]+/).filter(Boolean);
  let out = "";
  for (const p of parts) {
    if (/^v?\d/i.test(p)) out += p.replace(/\./g, "").toUpperCase();
    else out += p[0].toUpperCase();
  }
  return out.slice(0, 6) || "LLM";
}

/** "provider/model" → {provider_id, model_id}；无斜杠则整体视为 model_id */
function splitModelStr(s) {
  if (!s || typeof s !== "string") return null;
  const i = s.indexOf("/");
  return i < 0 ? { provider_id: null, model_id: s } : { provider_id: s.slice(0, i), model_id: s.slice(i + 1) };
}

// 配置当前模型 10s 缓存（列表逐行兜底时避免重复读配置文件）
let cfgModelCache = null;
let cfgModelAt = 0;
function configModelInfo() {
  if (!cfgModelCache || Date.now() - cfgModelAt > 10_000) {
    try {
      cfgModelCache = splitModelStr(currentModelInfo().active);
    } catch {
      cfgModelCache = null;
    }
    cfgModelAt = Date.now();
  }
  return cfgModelCache;
}

/** 会话最近一次真实调用的模型（无 session/库不可读/无记录 → null） */
function latestSessionModel(sessionId) {
  const mdb = getMimocodeDb();
  if (!mdb || !sessionId) return null;
  try {
    const r = mdb
      .prepare(
        "SELECT data FROM message WHERE session_id = ? AND json_extract(data, '$.role') = 'assistant' " +
          "AND json_extract(data, '$.modelID') IS NOT NULL ORDER BY time_created DESC LIMIT 1"
      )
      .get(sessionId);
    if (!r) return null;
    const d = JSON.parse(r.data);
    return { provider_id: d.providerID ?? null, model_id: d.modelID ?? null };
  } catch {
    return null;
  }
}

/** 任务当前会话调用的大模型：会话实况 → 任务 model 字段 → 全局配置当前模型 */
function resolveModelInfo(row) {
  const hit = latestSessionModel(row.session_id) || splitModelStr(row.model) || configModelInfo();
  if (!hit || (!hit.provider_id && !hit.model_id)) return null;
  return { ...hit, abbr: modelAbbrOf(hit.model_id) };
}

/** 把 model / model_abbr 挂到 API 输出对象上（列表与详情共用） */
function attachModelInfo(out, row) {
  out.model = resolveModelInfo(row);
  out.model_abbr = out.model?.abbr ?? null;
  return out;
}

const zeroTokens = () => ({ input: 0, output: 0, reasoning: 0, cache_read: 0, cache_write: 0, total: 0 });

function addTokens(dst, tk) {
  dst.input += tk.input;
  dst.output += tk.output;
  dst.reasoning += tk.reasoning;
  dst.cache_read += tk.cache_read;
  dst.cache_write += tk.cache_write;
  dst.total += tk.total;
  return dst;
}

// 毫秒时间戳 → 文档口径 ISO 8601 +08:00
function msToISO(ms) {
  if (!ms) return null;
  return toISO(new Date(ms).toISOString().slice(0, 19).replace("T", " "));
}

/** 轮次输入预览：取应用侧 task_messages 的原文（与消息记录页同源） */
function roundPreview(content) {
  return String(content || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}

/**
 * 任务会话的调用统计：{ model, totals, rounds }。
 * 轮次口径 = 应用侧 task_messages 的 user 消息（与消息记录页的"轮"一致）；
 * mimocode 同一条消息可能因断线恢复被重复派发成多条 user 行 —— 按派发时间
 * 归并回所属应用轮次，助手调用再按 parentID 归轮（parent 缺失按时间就近）。
 * 无 session 的任务返回全零骨架（图标仍可点开，显示"暂无对话记录"）。
 */
function buildSessionUsage(row) {
  const data = {
    task_id: row.task_id,
    session_id: row.session_id ?? null,
    task_state: row.state,
    model: resolveModelInfo(row),
    totals: {
      rounds: 0,
      calls: 0,
      tokens: zeroTokens(),
      cost: 0,
      duration_sec: 0,
      started_at: null,
      ended_at: null,
    },
    rounds: [],
  };
  if (!row.session_id) return data;
  const mdb = getMimocodeDb();
  if (!mdb) {
    const e = new Error("MiMoCode 用量库（mimocode.db）不可读");
    e.status = 503;
    throw e;
  }

  // 1) 应用侧轮次边界（user 消息，按 msg_id 升序）
  const appMsgs = db
    .prepare(
      "SELECT content, pending, created_at FROM task_messages " +
        "WHERE task_id = ? AND role = 'user' ORDER BY msg_id"
    )
    .all(row.task_id);
  const buckets = appMsgs.map((m) => ({
    t: Date.parse(String(m.created_at).replace(" ", "T") + "Z") || 0,
    preview: roundPreview(m.content),
    pending: !!m.pending,
    calls: [],
  }));
  if (!buckets.length) buckets.push({ t: 0, preview: "", pending: false, calls: [] });

  // 2) mimocode 侧：user 消息（重复派发按时间归并到应用轮次）+ 真实助手调用
  const users = []; // [{id, t, round}]
  const calls = []; // 真实模型调用（有 token/费用）
  for (const r of mdb
    .prepare("SELECT id, data, time_created FROM message WHERE session_id = ? ORDER BY time_created ASC")
    .all(row.session_id)) {
    let d;
    try {
      d = JSON.parse(r.data);
    } catch {
      continue;
    }
    if (d.role === "user") {
      let round = 0;
      for (let i = 0; i < buckets.length; i++) if (buckets[i].t <= r.time_created) round = i;
      users.push({ id: r.id, t: r.time_created, round });
      continue;
    }
    if (d.role !== "assistant") continue;
    const tk = d.tokens || {};
    const cacheRead = tk.cache?.read ?? 0;
    const cacheWrite = tk.cache?.write ?? 0;
    const total =
      tk.total || (tk.input || 0) + (tk.output || 0) + (tk.reasoning || 0) + cacheRead + cacheWrite;
    const cost = d.cost || 0;
    if (!(total > 0 || cost > 0 || (tk.output || 0) > 0)) continue; // 零用量占位消息
    calls.push({
      parentID: d.parentID || null,
      t: r.time_created,
      end: d.time?.completed || r.time_created,
      cost,
      providerID: d.providerID ?? null,
      modelID: d.modelID ?? null,
      tokens: {
        input: tk.input || 0,
        output: tk.output || 0,
        reasoning: tk.reasoning || 0,
        cache_read: cacheRead,
        cache_write: cacheWrite,
        total,
      },
    });
  }

  // 3) 助手调用归轮：parentID → 该 mimocode user 消息所属应用轮次；缺失则按时间就近
  const roundOfMsgId = new Map(users.map((u) => [u.id, u.round]));
  for (const c of calls) {
    let idx = c.parentID != null ? roundOfMsgId.get(c.parentID) : undefined;
    if (idx === undefined) {
      idx = 0;
      for (const u of users) if (u.t <= c.t) idx = u.round;
    }
    buckets[idx].calls.push(c);
  }

  let firstMs = null;
  let lastMs = null;
  for (let i = 0; i < buckets.length; i++) {
    const b = buckets[i];
    const tk = zeroTokens();
    let cost = 0;
    let start = null;
    let end = null;
    const models = [];
    for (const c of b.calls) {
      addTokens(tk, c.tokens);
      cost += c.cost;
      start = start == null ? c.t : Math.min(start, c.t);
      end = end == null ? c.end : Math.max(end, c.end);
      const name = c.modelID ? `${c.providerID ? c.providerID + "/" : ""}${c.modelID}` : null;
      if (name && !models.includes(name)) models.push(name);
    }
    cost = Math.round(cost * 1e6) / 1e6;
    const status = !b.calls.length
      ? "pending"
      : i === buckets.length - 1 && row.state === "running"
        ? "running"
        : "done";
    data.rounds.push({
      round: i + 1,
      preview: b.preview,
      status, // pending = 已发还没出回复 / running = 本轮执行中 / done
      calls: b.calls.length,
      tokens: tk,
      cost,
      models,
      started_at: msToISO(start),
      ended_at: msToISO(end),
      duration_sec: start != null && end != null ? Math.max(0, Math.round((end - start) / 1000)) : 0,
    });
    if (start != null) firstMs = firstMs == null ? start : Math.min(firstMs, start);
    if (end != null) lastMs = lastMs == null ? end : Math.max(lastMs, end);
    addTokens(data.totals.tokens, tk);
    data.totals.cost += cost;
    data.totals.calls += b.calls.length;
  }
  data.totals.cost = Math.round(data.totals.cost * 1e6) / 1e6;
  data.totals.rounds = data.rounds.length;
  data.totals.duration_sec = firstMs != null && lastMs != null ? Math.max(0, Math.round((lastMs - firstMs) / 1000)) : 0;
  data.totals.started_at = msToISO(firstMs);
  data.totals.ended_at = msToISO(lastMs);
  return data;
}

// ---------------------------------------------------------------------------
// 产物目录：taskRes/<task_id>/，文件系统为真相源，task_artifacts 为登记表
// ---------------------------------------------------------------------------

const artifactDir = (taskId) => path.join(TASK_RES_DIR, String(taskId));

// 相对路径 → 绝对路径，越出任务目录则拒绝（防目录穿越）
function safeArtifactPath(taskId, relPath) {
  const dir = artifactDir(taskId);
  const abs = path.resolve(dir, relPath);
  return abs === dir || abs.startsWith(dir + path.sep) ? abs : null;
}

/**
 * 扫描任务目录并与 task_artifacts 对账：新文件登记、size 变化更新、
 * 文件已消失的记录删除。返回按文件 mtime 倒序（最新在前）的完整产物记录列表。
 */
async function syncArtifacts(taskId) {
  const dir = artifactDir(taskId);
  let names = [];
  try {
    names = await readdir(dir, { recursive: true });
  } catch {
    names = []; // 目录还没建（或被手工删除）→ 按空处理，下面同时清掉残留记录
  }

  const records = db.prepare("SELECT * FROM task_artifacts WHERE task_id = ?").all(taskId);
  const byRel = new Map(records.map((r) => [r.rel_path, r]));
  const seen = new Set();
  const nowNaive = new Date().toISOString().slice(0, 19).replace("T", " ");
  const out = [];
  let changed = false;

  for (const rel of names) {
    // 跳过隐藏项：MiMoCode 自身状态（cwd 下的 .mimocode/ 等）不算产物
    if (rel.split(path.sep).some((seg) => seg.startsWith("."))) continue;
    const abs = path.join(dir, rel);
    let st;
    try {
      st = await stat(abs);
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    const norm = rel.split(path.sep).join("/");
    seen.add(norm);

    let rec = byRel.get(norm);
    if (!rec) {
      const r = db
        .prepare(
          "INSERT INTO task_artifacts (task_id, filename, rel_path, size, created_at) VALUES (?, ?, ?, ?, ?)"
        )
        .run(taskId, path.basename(norm), norm, st.size, nowNaive);
      rec = {
        artifact_id: Number(r.lastInsertRowid),
        task_id: taskId,
        filename: path.basename(norm),
        rel_path: norm,
        size: st.size,
        created_at: nowNaive,
      };
      changed = true;
    } else if (rec.size !== st.size) {
      db.prepare("UPDATE task_artifacts SET size = ? WHERE artifact_id = ?").run(st.size, rec.artifact_id);
      rec = { ...rec, size: st.size };
      changed = true;
    }
    // 一并挂上 mtimeMs，排序与 API 响应都用它（created_at 只记首次登记）
    out.push({ ...rec, mtimeMs: st.mtimeMs });
  }

  const gone = records.filter((r) => !seen.has(r.rel_path));
  if (gone.length > 0) {
    db
      .prepare(`DELETE FROM task_artifacts WHERE artifact_id IN (${gone.map(() => "?").join(",")})`)
      .run(...gone.map((r) => r.artifact_id));
    changed = true;
  }
  // 最新写入在上；mtime 相同再按路径稳定排序
  out.sort((a, b) => {
    const d = (b.mtimeMs ?? 0) - (a.mtimeMs ?? 0);
    return d !== 0 ? d : a.rel_path.localeCompare(b.rel_path);
  });
  if (changed) {
    // 产物有增删改：通知各端刷新详情里的产物列表（重连可重放）
    broadcast("task_artifacts_changed", { task_id: taskId, total: out.length });
  }
  return out;
}

// 删除任务时：表记录 + 目录一并清理
async function removeTaskArtifacts(taskId) {
  db.prepare("DELETE FROM task_artifacts WHERE task_id = ?").run(taskId);
  await rm(artifactDir(taskId), { recursive: true, force: true }).catch(() => {});
}

// 追加给 MiMoCode 的产物目录约束（只拼进 spawn 的指令，存储的用户消息保持原文）
function withArtifactDirective(message, dir) {
  return (
    `${message}\n\n[系统约束] 本次任务生成的所有产物文件（文档、图片、数据等）` +
    `必须保存到目录 ${dir}/ 下（可用子目录），不要保存到其他位置。`
  );
}

// ---------------------------------------------------------------------------
// 参考物上传：手写 multipart 解析 + .staging 批次（分步上传的前半段）
// 离线装不了 busboy/multer；请求体已先被 express.raw 限制在上限内，
// 这里只做有界的 Buffer 切分（按 --boundary 定位），不做流式。
// ---------------------------------------------------------------------------

/** 文件名清洗：取 basename、剥路径成分/控制符/前导点、限长；空则回退 "file" */
function sanitizeFilename(raw) {
  let base = path.basename(String(raw ?? "").replace(/\\/g, "/"));
  // eslint-disable-next-line no-control-regex
  base = base.replace(/[\x00-\x1f\x7f]/g, "").replace(/^\.+/, "").trim();
  if (!base) return "file";
  if (base.length > 120) {
    const ext = path.extname(base).slice(0, 16);
    base = base.slice(0, 120 - ext.length) + ext;
  }
  return base;
}

/**
 * 解析 multipart/form-data（手写有界实现）。
 * 结构：preamble --boundary CRLF headers CRLF CRLF body CRLF --boundary … --boundary--
 * body 内部出现分隔串由协议保证不可能（boundary 由客户端选出）。
 * 返回 [{ name, filename, body(Buffer) }]；文件字段 filename 为空的按普通字段。
 */
function parseMultipart(buf, contentType) {
  const bm = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || "");
  const boundary = (bm?.[1] ?? bm?.[2] ?? "").trim();
  if (!boundary) throw new Error("缺少 multipart boundary");
  const delim = Buffer.from(`--${boundary}`);
  const out = [];
  let pos = buf.indexOf(delim);
  if (pos < 0) throw new Error("未找到 multipart 分隔符");

  while (pos >= 0) {
    let start = pos + delim.length;
    if (buf[start] === 0x2d && buf[start + 1] === 0x2d) break; // "--" 结束标记
    if (buf[start] === 0x0d && buf[start + 1] === 0x0a) start += 2; // CRLF
    const next = buf.indexOf(delim, start);
    if (next < 0) break;
    let end = next;
    if (buf[end - 2] === 0x0d && buf[end - 1] === 0x0a) end -= 2; // part 尾 CRLF
    const part = buf.subarray(start, end);
    const headEnd = part.indexOf("\r\n\r\n");
    if (headEnd >= 0) {
      const head = part.subarray(0, headEnd).toString("utf8");
      const body = part.subarray(headEnd + 4);
      const cd = /content-disposition:[^\r\n]*/i.exec(head)?.[0] ?? "";
      const name = /;\s*name="([^"]*)"/i.exec(cd)?.[1] ?? null;
      let filename = /filename\*=(?:UTF-8'')?([^;\r\n]+)/i.exec(cd)?.[1];
      if (filename) {
        try {
          filename = decodeURIComponent(filename.trim());
        } catch {
          filename = filename.trim();
        }
      } else {
        filename = /filename="([^"]*)"/i.exec(cd)?.[1] ?? null;
      }
      out.push({ name, filename, body });
    }
    pos = next;
  }
  return out;
}

/** 清理 24h 未被消费的暂存批次（启动时 + 周期跑） */
async function cleanupStaging() {
  let names = [];
  try {
    names = await readdir(UPLOAD_STAGING_DIR);
  } catch {
    return;
  }
  const cutoff = Date.now() - UPLOAD_STAGING_TTL_MS;
  for (const n of names) {
    const dir = path.join(UPLOAD_STAGING_DIR, n);
    try {
      const st = await stat(dir);
      if (st.mtimeMs < cutoff) await rm(dir, { recursive: true, force: true });
    } catch {
      /* 已消失 */
    }
  }
}

/**
 * 消费暂存批次：把 .staging/<batchId>/ 里的文件迁入任务目录（重名加序号），
 * 删除批次目录。返回 [{filename,size}]（迁移后的最终文件名）。
 * batchId 非空但批次不存在 → 返回 null（调用方 404）；不存在迁移冲突以外的错误上抛。
 */
async function consumeBatch(taskId, batchId) {
  if (!batchId) return [];
  const id = String(batchId);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    throw Object.assign(new Error("upload_batch 格式无效"), { status: 400 });
  }
  const src = path.join(UPLOAD_STAGING_DIR, id);
  const dst = artifactDir(taskId);
  let names;
  try {
    names = await readdir(src);
  } catch {
    throw Object.assign(new Error("上传批次不存在或已过期"), { status: 404 });
  }
  await mkdir(dst, { recursive: true });
  const moved = [];
  const used = new Set(
    (await readdir(dst).catch(() => [])).map((n) => n.toLowerCase())
  );
  for (const n of names) {
    const from = path.join(src, n);
    if ((await stat(from)).isDirectory()) continue;
    // 重名 → "name (1).ext" 式顺延，绝不覆盖已有文件
    let target = n;
    let stem = path.parse(n).name;
    const { ext } = path.parse(n);
    let k = 1;
    while (used.has(target.toLowerCase())) target = `${stem} (${k++})${ext}`;
    used.add(target.toLowerCase());
    // staging 与任务目录同在 taskRes/ 下（同盘），rename 即原子迁入
    await rename(from, path.join(dst, target));
    moved.push({ filename: target, size: (await stat(path.join(dst, target))).size });
  }
  await rm(src, { recursive: true, force: true });
  return moved;
}

// 给 mimo 的指令追加参考文件清单（只拼 spawn 的指令，存储的用户消息保持原文）
function withReferenceDirective(message, attachments) {
  if (!attachments?.length) return message;
  const names = attachments.map((a) => a.filename).join("、");
  return (
    `${message}\n\n[系统约束] 本轮参考文件已放在工作目录：${names}。` +
    `请先阅读其内容，再结合执行任务。`
  );
}

function parseAttachments(json) {
  if (!json) return null;
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// WebSocket 客户端集合与事件广播（attachTaskWs 建立连接，路由只管发）
//
// 断联中继：relay 事件先写 task_events 拿全局自增 seq，再以 {seq,event,data}
// 帧广播；客户端记住 lastSeq，重连时 ?since=lastSeq 补发漏掉的事件。
// 保留窗口只剪最旧（全局连续），重连端校验 since 是否已跌出窗口 ——
// 跌出则推 task_resync，客户端全量重拉兜底。task_progress 心跳高频且瞬态，
// relay:false 只实时广播不落库（seq 为 null，客户端不推进 lastSeq）。
// ---------------------------------------------------------------------------

const wsClients = new Set();

function wsFrame(opcode, payload) {
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x80 | opcode, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

function wsSend(socket, obj) {
  try {
    socket.write(wsFrame(0x1, Buffer.from(JSON.stringify(obj))));
  } catch {
    wsClients.delete(socket);
  }
}

function broadcast(event, data, { relay = true } = {}) {
  let seq = null;
  if (relay) {
    const taskId = data?.task_id ?? null;
    const owner =
      taskId != null ? db.prepare("SELECT user_id FROM tasks WHERE task_id = ?").get(taskId) : null;
    if (owner) {
      const r = db
        .prepare("INSERT INTO task_events (user_id, task_id, event, data) VALUES (?, ?, ?, ?)")
        .run(owner.user_id, taskId, event, JSON.stringify(data));
      seq = Number(r.lastInsertRowid);
    }
  }
  if (wsClients.size === 0) return;
  const buf = wsFrame(0x1, Buffer.from(JSON.stringify({ seq, event, data })));
  for (const s of wsClients) {
    if (s.destroyed || !s.writable) {
      wsClients.delete(s);
      continue;
    }
    try {
      s.write(buf);
    } catch {
      wsClients.delete(s);
    }
  }
}

/** 当前事件水位（快照一致性：列表/详情返回 server_seq，客户端 since 从这里接） */
function maxEventSeq() {
  const r = db.prepare("SELECT MAX(seq) AS m FROM task_events").get();
  return r?.m ?? 0;
}

/**
 * 重连补发：since 之后属于该用户的事件。返回 "replayed"（含 since 缺省的空操作）、
 * "resync"（since 已跌出保留窗口/事件过多，客户端须全量重拉）。
 */
function replayEvents(socket, userId, since) {
  if (since == null) return "replayed";
  const min = db.prepare("SELECT MIN(seq) AS m FROM task_events").get()?.m ?? null;
  // 缺口判定：表空但客户端自称见过事件 → 丢了；min 跳过了 since+1 → 中间被修剪。
  // since=0 且表空 = 客户端从未见过且服务端确实没有 → 一致，无需 resync。
  const gap = min == null ? since > 0 : min > since + 1;
  if (gap) {
    wsSend(socket, { seq: null, event: "task_resync", data: { reason: "gap" } });
    return "resync";
  }
  const rows = db
    .prepare(
      "SELECT seq, event, data FROM task_events WHERE user_id = ? AND seq > ? ORDER BY seq LIMIT ?"
    )
    .all(userId, since, EVENT_REPLAY_LIMIT + 1);
  if (rows.length > EVENT_REPLAY_LIMIT) {
    wsSend(socket, { seq: null, event: "task_resync", data: { reason: "window" } });
    return "resync";
  }
  for (const r of rows) {
    wsSend(socket, { seq: r.seq, event: r.event, data: JSON.parse(r.data) });
  }
  return "replayed";
}

/** 保留窗口修剪：只留最新 EVENT_MAX_ROWS 行（连续尾部，故 since 校验依然成立） */
function pruneEvents() {
  db.prepare(
    "DELETE FROM task_events WHERE seq <= COALESCE((SELECT seq FROM task_events ORDER BY seq DESC LIMIT 1 OFFSET ?), -1)"
  ).run(EVENT_MAX_ROWS);
}

// ---------------------------------------------------------------------------
// MiMoCode 运行器：spawn `mimo run --format json`，增量解析 NDJSON 事件流
// ---------------------------------------------------------------------------

// task_id → { child, hb, canceling }。cancel/删除时置 canceling 并杀进程，
// 终态处理器见此标志后不再写库/广播。
const activeRuns = new Map();

// ---------------------------------------------------------------------------
// 网络状态：离线挂起派发、恢复后续跑（由 NetworkWatch 驱动）
//   networkOnline   —— 当前网络是否可达（watcher 回调维护）
//   lastActivity    —— 每个运行最近一次产出 NDJSON 事件的时间戳，恢复时据此
//                      判定哪些运行在断网期间已静默"卡住"
// ---------------------------------------------------------------------------
let networkOnline = true;
const runLastActivity = new Map(); // task_id → ms 时间戳

function touchRun(taskId) {
  runLastActivity.set(taskId, Date.now());
}

/**
 * 杀掉一次运行的整个进程组。
 *
 * `mimo` 只是个启动器：它用 spawnSync({ stdio: "inherit" }) 拉起真正的 `.mimocode`，
 * 两者 pid 不同。只杀启动器会留下孤儿 agent 继续跑（占 CPU、可能还在写产物）。
 *
 * spawn 传了 detached:true，child.pid 即新进程组 id，`kill(-pid)` 可一并带走。
 * 仅供用户主动 cancel/删除/进程退出时使用 —— 任务本身没有执行超时。
 */
function killRunTree(child) {
  const pid = child?.pid;
  if (!pid) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch (e) {
    // ESRCH = 整个进程组已退出（多半已被取消/超时杀过），无需处理；
    // 此函数跑在 setTimeout 回调里，任何异常都不能抛出去
    if (e.code !== "ESRCH") console.error("[TaskApi] killRunTree", e.message);
  }
}

function runMimo({ taskId, message, session_id, model, cwd, onSessionId }) {
  // headless 运行无人应答权限弹窗，ask 会被自动拒绝导致工具调用直接失败；
  // 跳过在事件层自动放行，显式 deny 规则依然生效
  const args = ["run", "--dangerously-skip-permissions", message, "--format", "json"];
  if (session_id) args.push("--session", session_id);
  if (model) args.push("-m", model);
  const workdir = cwd ? path.resolve(cwd) : os.homedir();

  // detached: 子进程自成进程组，否则 kill(-pid) 会误伤服务器自己所在的组
  const child = spawn("mimo", args, {
    cwd: workdir,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });

  let sid = session_id ?? null;
  let resolveSid;
  const sidPromise = new Promise((r) => (resolveSid = r));
  const texts = [];
  let stderr = "";
  let buf = "";

  const parseLine = (line) => {
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      return;
    }
    if (taskId != null) touchRun(taskId);
    if (ev.sessionID && ev.sessionID !== sid) {
      sid = ev.sessionID;
      onSessionId?.(sid);
      resolveSid(sid); // 首个事件即放行 POST /tasks，进程继续后台执行
    }
    if (ev.type === "text" && ev.part?.text) texts.push(ev.part.text);
  };

  child.stdout.on("data", (d) => {
    if (taskId != null) touchRun(taskId);
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line) parseLine(line);
    }
  });
  child.stderr.on("data", (d) => (stderr += d));

  const done = new Promise((resolve) => {
    const settle = (error, code) => {
      if (buf.trim()) parseLine(buf.trim());
      resolveSid(sid); // 未拿到 session_id 时以 null 结束创建流程
      resolve({ sid, texts, stderr, code, error });
    };
    // 监听 exit 而非 close：close 还要求 stdio 管道全部关闭，而 mimo 拉起的
    // 孙进程（如截图用的 chromium、playwright 守护进程）会继承 stdout 拖住
    // close 数百秒 —— 进程退出即视为本轮结束，残余 buffer 此刻一并冲掉。
    child.on("exit", (code) => {
      settle(code === 0 ? null : new Error(`exit code ${code}`), code);
    });
    child.on("error", (err) => settle(err, null));
  });

  return { child, sidPromise, done, canceling: false, hb: null, get sid() { return sid; } };
}

function startHeartbeat(taskId, run) {
  run.hb = setInterval(() => {
    const row = db.prepare("SELECT state, progress, started_at, created_at FROM tasks WHERE task_id = ?").get(taskId);
    if (!row || row.state !== "running") return;
    broadcast("task_progress", {
      task_id: taskId,
      progress: row.progress ?? 0,
      duration_sec: sinceSec(row.started_at || row.created_at),
    }, { relay: false }); // 心跳瞬态高频：只实时广播，不进 task_events
  }, HEARTBEAT_MS);
  run.hb.unref?.();
}

/**
 * 运行结束的统一收尾：清心跳与活动表 → 若是取消则由 cancel 路由负责（跳过）→
 * 落库终态（completed/failed）+ 存 assistant 消息 + 广播状态变更与回复 →
 * 最后调 dispatchNext 续跑队列里的下一条消息。
 * 创建流程在拿到 session_id 后挂接；send 流程由 dispatchNext 派发时挂接。
 */
function finalizeRun(taskId, run, result) {
  if (run.hb) clearInterval(run.hb);
  activeRuns.delete(taskId);
  if (run.canceling) return;

  // 断网恢复续跑：杀进程触发的收尾。不落终态，把在执行的那条消息重新入队，
  // 交回 dispatchNext 用 --session 重发续接（实测：空消息续接无输出，必须重发）。
  if (run.resuming) {
    runLastActivity.delete(taskId);
    if (run.msgId != null) {
      db
        .prepare("UPDATE task_messages SET pending = 1 WHERE msg_id = ? AND role = 'user'")
        .run(run.msgId);
    }
    const row = db.prepare("SELECT state FROM tasks WHERE task_id = ?").get(taskId);
    // 任务仍处活跃态才续跑；已被 cancel/删除则不再动
    if (row && ACTIVE_STATES.has(row.state)) dispatchNext(taskId);
    return;
  }

  const row = db.prepare("SELECT * FROM tasks WHERE task_id = ?").get(taskId);
  if (!row) return;

  const answer = result.texts.join("\n").trim();
  const detail = result.error
    ? `${result.error.message}${result.stderr ? "；" + result.stderr.slice(0, 300) : ""}`
    : "";
  const success = !(result.error && !answer);
  const content = success ? answer || "(无文本输出)" : `执行失败：${detail || "未知错误"}`;
  const msgId = insertMsg(taskId, "assistant", content);

  const nowNaive = new Date().toISOString().slice(0, 19).replace("T", " ");
  const duration = sinceSec(row.started_at || row.created_at);
  const newState = success ? "completed" : "failed";
  const progress = success ? 100 : row.progress ?? 0;

  db.prepare(
    "UPDATE tasks SET state=?, progress=?, error_message=?, completed_at=?, duration_sec=?, session_id=?, " +
      "updated_at=datetime('now', 'localtime') WHERE task_id=?"
  ).run(newState, progress, success ? null : detail, nowNaive, duration, result.sid || row.session_id, taskId);

  broadcast("task_state_changed", {
    task_id: taskId,
    old_state: row.state,
    new_state: newState,
    progress,
    completed_at: toISO(nowNaive),
  });
  broadcast("task_message", {
    task_id: taskId,
    msg_id: formatMsgId(msgId),
    role: "assistant",
    content,
    pending: false,
    created_at: toISO(nowNaive),
  });

  dispatchNext(taskId); // 队列非空则立刻开下一轮（state 回到 running）
}

/**
 * 派发该任务排队最早的 pending 用户消息。activeRuns 非空（上一轮还在跑）时
 * 什么都不做 —— 那一轮的 finalize 会再次调进来。同步执行，无 await 竞态。
 * notifyDispatch=false：调用方（send 立即派发）自己统一广播，避免重复事件。
 */
function dispatchNext(taskId, notifyDispatch = true) {
  if (activeRuns.has(taskId)) return false;
  // 离线闸门：断网期间不派发（mimo 出网必卡），消息保持 pending 排队，
  // 网络恢复后由 resumeStalledRuns 统一补派 —— 轮次不丢，事后续跑。
  if (!networkOnline) return false;
  const msg = db
    .prepare(
      "SELECT * FROM task_messages WHERE task_id = ? AND role = 'user' AND pending = 1 ORDER BY msg_id LIMIT 1"
    )
    .get(taskId);
  if (!msg) return false;
  db.prepare("UPDATE task_messages SET pending = 0 WHERE msg_id = ?").run(msg.msg_id);

  const row = db.prepare("SELECT * FROM tasks WHERE task_id = ?").get(taskId);
  if (!row || !row.session_id) return false; // 会话不存在：消息已消费但无法续跑

  if (row.state !== "running") {
    const nowNaive = new Date().toISOString().slice(0, 19).replace("T", " ");
    db.prepare(
      "UPDATE tasks SET state='running', progress=0, error_message=NULL, completed_at=NULL, started_at=?, " +
        "updated_at=datetime('now', 'localtime') WHERE task_id=?"
    ).run(nowNaive, taskId);
    broadcast("task_state_changed", {
      task_id: taskId,
      old_state: row.state,
      new_state: "running",
      progress: 0,
    });
  }
  touchTask(taskId); // 新一轮开始 = 任务更新，驱动列表按更新时间冒泡
  // 排队中标记翻转为已派发 —— 各端按 msg_id upsert
  if (notifyDispatch) {
    broadcast("task_message", {
      task_id: taskId,
      msg_id: formatMsgId(msg.msg_id),
      role: "user",
      content: msg.content,
      pending: false,
      attachments: parseAttachments(msg.attachments),
      created_at: toISO(msg.created_at),
    });
  }

  const run = runMimo({
    taskId,
    message: withReferenceDirective(
      withArtifactDirective(msg.content, artifactDir(taskId)),
      parseAttachments(msg.attachments)
    ),
    session_id: row.session_id,
    model: row.model,
    cwd: row.cwd || artifactDir(taskId),
    onSessionId(sid) {
      if (sid !== row.session_id)
        db.prepare("UPDATE tasks SET session_id=? WHERE task_id=?").run(sid, taskId);
    },
  });
  activeRuns.set(taskId, run);
  run.msgId = msg.msg_id; // 断网恢复续跑时，按此把在执行的消息重新入队
  startHeartbeat(taskId, run);
  run.done
    .then((result) => finalizeRun(taskId, run, result))
    .catch((e) => console.error("[TaskApi]", e));
  return true;
}

/**
 * 网络恢复后的续跑入口（由 NetworkWatch 的 onOnline 回调触发）。
 *
 * 断网期间 mimo 的模型请求会卡住：子进程还在（activeRuns 有记录）但不再产出
 * NDJSON 事件（runLastActivity 停滞），也永不 exit。网络恢复后给一个自愈宽限
 * 期，若某运行仍静默超过 NET_RESUME_STALL_MS，判定为"卡死"，标记 resuming 并
 * 杀进程组 —— finalizeRun 见 resuming 标志后不落终态，改为把在执行的消息重新
 * 入队，再由 dispatchNext 用 --session 重发续接（见 finalizeRun 注释）。
 *
 * 持续产出事件的运行（正常干活、没被断网影响）不会被杀 —— 只在恢复瞬间对静默
 * 运行生效，因此不是执行超时（不违反"任务不设超时"的既定约束）。
 */
function resumeStalledRuns() {
  const now = Date.now();
  let resumed = 0;
  for (const [taskId, run] of activeRuns) {
    if (run.resuming || run.canceling) continue;
    const last = runLastActivity.get(taskId) ?? 0;
    if (now - last < NET_RESUME_STALL_MS) continue; // 仍在产出 → 未受断网影响
    run.resuming = true;
    if (run.hb) clearInterval(run.hb);
    killRunTree(run.child); // 触发 exit → finalizeRun 走 resuming 分支重新入队
    resumed++;
  }
  if (resumed > 0) {
    console.log(`[TaskApi] 网络恢复：续跑 ${resumed} 个断网卡住的运行`);
  }
  // 断网期间 send 排队但因无网络未派发的消息：现在统一补派
  const pending = db
    .prepare(
      "SELECT DISTINCT task_id FROM task_messages WHERE role='user' AND pending=1"
    )
    .all();
  for (const { task_id } of pending) {
    if (!activeRuns.has(task_id)) dispatchNext(task_id);
  }
}

// 网络状态改变时向所有 WS 客户端广播（relay:false —— 瞬态状态不进 task_events）
function broadcastNetwork(online) {
  if (wsClients.size === 0) return;
  const buf = wsFrame(0x1, Buffer.from(JSON.stringify({
    seq: null,
    event: "network_status",
    data: { online, checked_at: new Date().toISOString() },
  })));
  for (const s of wsClients) {
    if (s.destroyed || !s.writable) { wsClients.delete(s); continue; }
    try { s.write(buf); } catch { wsClients.delete(s); }
  }
}

// ---------------------------------------------------------------------------
// 路由（前缀 /api/v1，全部走 requireAuth）
// ---------------------------------------------------------------------------

const asInt = (v) => {
  const n = Number(v);
  return Number.isInteger(n) ? n : null;
};

export function mountTaskApi(app) {
  ensureTaskTables();

  const pruneTimer = setInterval(pruneEvents, EVENT_PRUNE_MS);
  pruneTimer.unref?.();
  const stagingTimer = setInterval(() => cleanupStaging().catch(() => {}), 3600_000);
  stagingTimer.unref?.();

  // 网络状态守护：离线挂起派发、恢复后对卡住的运行续跑（见 resumeStalledRuns）
  let resumeTimer = null;
  const netWatch = createNetworkWatcher({
    onOffline() {
      networkOnline = false;
      console.log("[TaskApi] 网络离线：新消息暂缓派发，执行中的任务可能短暂无输出");
      broadcastNetwork(false);
    },
    onOnline() {
      networkOnline = true;
      console.log("[TaskApi] 网络恢复：准备续跑断网期间卡住的任务");
      broadcastNetwork(true);
      // 先给在跑的进程一个自愈宽限期，再对仍静默的运行判定卡死并续跑
      if (resumeTimer) clearTimeout(resumeTimer);
      resumeTimer = setTimeout(() => {
        resumeTimer = null;
        try {
          resumeStalledRuns();
        } catch (e) {
          console.error("[TaskApi] resumeStalledRuns", e);
        }
      }, NET_RESUME_SETTLE_MS);
      resumeTimer.unref?.();
    },
  });
  netWatch.start();
  networkOnline = netWatch.isOnline();

  // 重启恢复的任务：网络状态就绪后统一派发（离线则 pending 保留，网络恢复补派）
  for (const id of recoveredTaskIds.splice(0)) dispatchNext(id);

  const router = express.Router();
  router.use(express.json());
  router.use(
    cors({
      origin: isPrivateOrigin,
      methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
      allowedHeaders: ["Authorization", "Content-Type", "X-Device-Id", "X-Request-Id"],
    })
  );

  // 产物下载/预览常被 <a href> / <img src> 直连（带不了 Authorization 头），
  // 该路由允许 ?token=<access_token> 兜底；其余路由仍只认 Bearer 头
  const requireAuthOrToken = (req, res, next) => {
    if (!req.headers.authorization && req.query.token) {
      verifyAccessToken(String(req.query.token), req.app.locals.loginSecret)
        .then((r) => {
          req.auth = r.payload;
          req.user = r.user;
          next();
        })
        .catch((e) => {
          if (e.api) fail(res, e.api.status, e.api.message, e.api.type, e.api.detail);
          else next(e);
        });
      return;
    }
    return requireAuth(req, res, next);
  };

  // POST /api/v1/uploads —— 参考物分步上传（前半段：只入 .staging 拿 batch_id）
  // multipart 手写解析：先 express.raw 把请求体卡在 110mb（>100MB 数据+边框开销），
  // 再按 boundary 切 Buffer —— 离线环境无 busboy/multer，且量级可控（局域网）。
  router.post(
    "/uploads",
    requireAuth,
    express.raw({ type: "multipart/form-data", limit: "110mb" }),
    async (req, res) => {
      const ct = req.headers["content-type"] || "";
      if (!/^multipart\/form-data/i.test(ct)) {
        return badRequest(res, "请以 multipart/form-data 上传");
      }
      if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
        return badRequest(res, "请求体为空");
      }
      let parts;
      try {
        parts = parseMultipart(req.body, ct);
      } catch (e) {
        return fail(res, 400, "multipart 解析失败", "MULTIPART_INVALID", e.message);
      }
      const files = parts.filter((p) => p.filename && p.body?.length);
      if (!files.length) return badRequest(res, "未包含文件字段");
      if (files.length > UPLOAD_MAX_FILES) {
        return fail(res, 400, `单次最多上传 ${UPLOAD_MAX_FILES} 个文件`, "LIMIT_FILE_COUNT");
      }
      let total = 0;
      for (const f of files) {
        if (f.body.length > UPLOAD_MAX_FILE_BYTES) {
          return fail(
            res,
            413,
            `文件 ${sanitizeFilename(f.filename)} 超过 ${UPLOAD_MAX_FILE_BYTES / 1024 / 1024}MB 限制`,
            "LIMIT_FILE_SIZE"
          );
        }
        total += f.body.length;
      }
      if (total > UPLOAD_MAX_TOTAL_BYTES) {
        return fail(res, 413, "本次上传总量超过 100MB", "LIMIT_TOTAL_SIZE");
      }

      const batchId = randomUUID();
      const dir = path.join(UPLOAD_STAGING_DIR, batchId);
      await mkdir(dir, { recursive: true });
      const used = new Set();
      try {
        const saved = [];
        for (const f of files) {
          let name = sanitizeFilename(f.filename);
          const { ext } = path.parse(name);
          const stem = path.parse(name).name;
          let k = 1;
          while (used.has(name.toLowerCase())) name = `${stem} (${k++})${ext}`;
          used.add(name.toLowerCase());
          await writeFile(path.join(dir, name), f.body);
          saved.push({ filename: name, size: f.body.length });
        }
        return ok(res, { batch_id: batchId, files: saved }, 201);
      } catch (e) {
        await rm(dir, { recursive: true, force: true }).catch(() => {});
        throw e;
      }
    }
  );

  // GET /api/v1/tasks —— 列表（stats + 状态筛选 + 分页）
  router.get("/tasks", requireAuth, (req, res) => {
    const userId = req.user.user_id;
    const state = req.query.state != null ? String(req.query.state) : null;
    if (state && !ALL_STATES.has(state)) {
      return badRequest(res, "state 取值无效：running/queued/completed/failed/cancelled");
    }
    const page = Math.max(1, Math.floor(Number(req.query.page) || 1));
    const limit = Math.min(100, Math.max(1, Math.floor(Number(req.query.limit) || 20)));
    const offset = (page - 1) * limit;

    const statRows = db
      .prepare("SELECT state, COUNT(*) AS c FROM tasks WHERE user_id = ? GROUP BY state")
      .all(userId);
    const byState = Object.fromEntries(statRows.map((r) => [r.state, r.c]));
    const stats = {
      running: byState.running ?? 0,
      queued: byState.queued ?? 0,
      completed: byState.completed ?? 0,
      failed: byState.failed ?? 0,
    };

    const where = state ? "WHERE user_id = ? AND state = ?" : "WHERE user_id = ?";
    const args = state ? [userId, state] : [userId];
    const total = db.prepare(`SELECT COUNT(*) AS c FROM tasks ${where}`).get(...args).c;
    const rows = db
      .prepare(`SELECT * FROM tasks ${where} ORDER BY COALESCE(updated_at, created_at) DESC, task_id DESC LIMIT ? OFFSET ?`)
      .all(...args, limit, offset);

    const names = deviceNames(rows.flatMap((r) => [r.source_device_id, r.target_device_id]));

    // 卡片左下角要显示"当前轮对话"：批量取每个任务最新一条消息（running 时即本轮输入）
    const latest = new Map();
    if (rows.length) {
      const ids = rows.map((r) => r.task_id);
      const ph = ids.map(() => "?").join(",");
      const msgRows = db
        .prepare(
          "SELECT task_id, msg_id, role, content, pending FROM task_messages " +
            `WHERE msg_id IN (SELECT MAX(msg_id) FROM task_messages WHERE task_id IN (${ph}) GROUP BY task_id)`
        )
        .all(...ids);
      for (const m of msgRows) latest.set(m.task_id, m);
    }

    return ok(res, {
      stats,
      tasks: rows.map((r) => {
        const m = latest.get(r.task_id);
        // 列表只作预览，超长内容截断，避免整页响应被长回答撑大
        const content = m && m.content.length > 200 ? m.content.slice(0, 200) + "…" : m?.content;
        return attachModelInfo(
          {
            ...rowToApi(r, names),
            current_round: m
              ? {
                  msg_id: formatMsgId(m.msg_id),
                  role: m.role,
                  content,
                  pending: !!m.pending,
                }
              : null,
          },
          r
        );
      }),
      pagination: { total, page, limit, has_more: offset + rows.length < total },
      // 快照水位：客户端加载完列表后以此为 since 连 WS，重放恰好覆盖加载后的事件
      server_seq: maxEventSeq(),
    });
  });

  // POST /api/v1/tasks —— 创建任务（创建 MiMoCode 会话），拿到 session_id 后响应 201
  router.post("/tasks", requireAuth, async (req, res) => {
    const b = req.body ?? {};
    if (typeof b.name !== "string" || !b.name.trim()) return badRequest(res, "name 为必填字段");
    if (typeof b.message !== "string" || !b.message.trim()) {
      return badRequest(res, "message 为必填字段");
    }
    const srcId = b.source_device_id == null ? null : asInt(b.source_device_id);
    const tgtId = b.target_device_id == null ? null : asInt(b.target_device_id);
    if (b.source_device_id != null && srcId == null) return badRequest(res, "source_device_id 须为整数");
    if (b.target_device_id != null && tgtId == null) return badRequest(res, "target_device_id 须为整数");

    const name = b.name.trim();
    const icon = typeof b.icon === "string" && b.icon ? b.icon : null;
    const message = b.message;
    const cwd = typeof b.cwd === "string" && b.cwd ? b.cwd : null;
    const model = typeof b.model === "string" && b.model ? b.model : null;
    const uploadBatch =
      typeof b.upload_batch === "string" && b.upload_batch ? b.upload_batch : null;

    const taskId = Number(
      db
        .prepare(
          "INSERT INTO tasks (user_id, name, icon, type, state, progress, message, source_device_id, target_device_id, cwd, model, updated_at) " +
            "VALUES (?, ?, ?, 'mimocode', 'queued', 0, ?, ?, ?, ?, ?, datetime('now', 'localtime'))"
        )
        .run(req.user.user_id, name, icon, message, srcId, tgtId, cwd, model).lastInsertRowid
    );

    // 每任务一个产物目录；未指定 cwd 时默认在此执行（目录必存在）
    const resDir = artifactDir(taskId);
    await mkdir(resDir, { recursive: true });

    // 参考物批次迁入任务目录（必须先落盘，spawn 后 mimo 才能读到）
    let attachments;
    try {
      attachments = await consumeBatch(taskId, uploadBatch);
    } catch (e) {
      db.prepare("DELETE FROM tasks WHERE task_id = ? AND state = 'queued'").run(taskId);
      await removeTaskArtifacts(taskId);
      return fail(
        res,
        e.status ?? 500,
        e.status ? e.message : "参考物落盘失败",
        e.status ? "UPLOAD_BATCH_INVALID" : "UPLOAD_FAILED",
        e.message
      );
    }
    const createMsgId = insertMsg(taskId, "user", message, null, 0, attachments);

    const workdir = cwd || resDir;

    // 同步 spawn，之后立刻进入等待——cancel 路由依赖 activeRuns 里的 child 句柄
    const run = runMimo({
      taskId,
      message: withReferenceDirective(withArtifactDirective(message, resDir), attachments),
      model,
      cwd: workdir,
      onSessionId(sid) {
        db.prepare(
          "UPDATE tasks SET session_id=?, state='running', started_at=datetime('now','localtime') WHERE task_id=? AND state='queued'"
        ).run(sid, taskId);
        startHeartbeat(taskId, run);
        broadcast("task_created", { task_id: taskId, name, icon, state: "running", session_id: sid });
      },
    });
    activeRuns.set(taskId, run);
    run.msgId = createMsgId; // 断网恢复续跑时，按此把在执行的消息重新入队

    const sid = await Promise.race([run.sidPromise, run.done.then(() => run.sid)]);

    if (!sid) {
      // 创建失败：删除 queued 记录（若已被取消则保留 cancelled 行），返回文档格式的 500；
      // 连带清掉消息与任务目录（含刚迁入的参考物），不留孤儿
      const result = await run.done;
      if (run.hb) clearInterval(run.hb);
      activeRuns.delete(taskId);
      db.prepare("DELETE FROM tasks WHERE task_id = ? AND state = 'queued'").run(taskId);
      db.prepare("DELETE FROM task_messages WHERE task_id = ?").run(taskId);
      await removeTaskArtifacts(taskId);
      const detail =
        result.error
          ? `${result.error.message}${result.stderr ? "；" + result.stderr.slice(0, 300) : ""}`
          : "MiMoCode 未返回 session_id";
      return fail(res, 500, "MiMoCode 会话创建失败", "SESSION_CREATE_FAILED", detail);
    }

    // 会话已建立：进程继续在后台跑，结束后由 finalizeRun 落库终态
    run.done.then((result) => finalizeRun(taskId, run, result)).catch((e) => console.error("[TaskApi]", e));

    const row = db.prepare("SELECT * FROM tasks WHERE task_id = ?").get(taskId);
    return ok(
      res,
      {
        task_id: taskId,
        name: row.name,
        icon: row.icon ?? null,
        type: row.type,
        state: row.state,
        session_id: row.session_id,
        progress: row.progress ?? 0,
        created_at: toISO(row.created_at),
      },
      201
    );
  });

  // DELETE /api/v1/tasks/completed —— 清空已完成（须注册在 /:taskId 之前，含产物清理）
  router.delete("/tasks/completed", requireAuth, async (req, res) => {
    const ids = db
      .prepare("SELECT task_id FROM tasks WHERE user_id = ? AND state = 'completed'")
      .all(req.user.user_id)
      .map((r) => r.task_id);
    if (ids.length > 0) {
      const ph = ids.map(() => "?").join(",");
      db.prepare(`DELETE FROM task_messages WHERE task_id IN (${ph})`).run(...ids);
      await Promise.all(ids.map((id) => removeTaskArtifacts(id)));
      const r = db.prepare(`DELETE FROM tasks WHERE task_id IN (${ph})`).run(...ids);
      return ok(res, { deleted_count: r.changes });
    }
    return ok(res, { deleted_count: 0 });
  });

  // GET /api/v1/tasks/{task_id} —— 详情
  router.get("/tasks/:taskId", requireAuth, (req, res) => {
    const taskId = asInt(req.params.taskId);
    if (taskId == null) return badRequest(res, "task_id 无效");
    const row = getOwnedTask(taskId, req.user.user_id);
    if (!row) return fail(res, 404, "任务不存在", "TASK_NOT_FOUND");
    const names = deviceNames([row.source_device_id, row.target_device_id]);
    return ok(
      res,
      attachModelInfo({ ...rowToApi(row, names, { detail: true }), server_seq: maxEventSeq() }, row)
    );
  });

  // POST /api/v1/tasks/{task_id}/send —— 多轮续接（202 受理，不等本轮跑完）
  // 上一轮仍在执行 → 消息置 pending 排队，finalize 后按序自动续跑；
  // 空闲 → 立即派发。两种情况都 202 返回，客户端断网也不丢轮次，
  // 回复经 GET messages / WS task_message（重连可重放）取回。
  router.post("/tasks/:taskId/send", requireAuth, async (req, res) => {
    const taskId = asInt(req.params.taskId);
    if (taskId == null) return badRequest(res, "task_id 无效");
    const content = req.body?.content;
    if (typeof content !== "string" || !content.trim()) return badRequest(res, "content 为必填字段");
    const uploadBatch =
      typeof req.body?.upload_batch === "string" && req.body.upload_batch
        ? req.body.upload_batch
        : null;

    const row = getOwnedTask(taskId, req.user.user_id);
    if (!row) return fail(res, 404, "任务不存在", "TASK_NOT_FOUND");
    if (!row.session_id) return fail(res, 409, "任务尚未创建会话", "TASK_NO_SESSION");

    // 参考物先迁入任务目录再入库排队（派发时 mimo 在 cwd 即可读到）
    let attachments = null;
    if (uploadBatch) {
      try {
        attachments = await consumeBatch(taskId, uploadBatch);
      } catch (e) {
        return fail(
          res,
          e.status ?? 500,
          e.status ? e.message : "参考物落盘失败",
          e.status ? "UPLOAD_BATCH_INVALID" : "UPLOAD_FAILED",
          e.message
        );
      }
    }

    const wasBusy = activeRuns.has(taskId);
    const userMsgId = insertMsg(taskId, "user", content, null, 1, attachments); // 先排队
    touchTask(taskId); // 继续会话即刷新更新时间（列表随之冒泡）
    if (!wasBusy) dispatchNext(taskId, false); // 空闲则立即派发（下面统一广播最终状态）
    const pending = !!(db.prepare("SELECT pending FROM task_messages WHERE msg_id = ?").get(userMsgId)?.pending);
    const createdAt = toISO(new Date().toISOString().slice(0, 19).replace("T", " "));
    broadcast("task_message", {
      task_id: taskId,
      msg_id: formatMsgId(userMsgId),
      role: "user",
      content,
      pending,
      attachments,
      created_at: createdAt,
    });

    const after = db.prepare("SELECT * FROM tasks WHERE task_id = ?").get(taskId);
    return ok(
      res,
      {
        task_id: taskId,
        msg_id: formatMsgId(userMsgId),
        role: "user",
        content,
        pending,
        session_id: after?.session_id ?? row.session_id,
        state: after?.state ?? "running",
        attachments,
        created_at: createdAt,
      },
      202
    );
  });

  // GET /api/v1/tasks/{task_id}/messages —— 消息历史（before 向前翻页）
  router.get("/tasks/:taskId/messages", requireAuth, (req, res) => {
    const taskId = asInt(req.params.taskId);
    if (taskId == null) return badRequest(res, "task_id 无效");
    const row = getOwnedTask(taskId, req.user.user_id);
    if (!row) return fail(res, 404, "任务不存在", "TASK_NOT_FOUND");

    const limit = Math.min(200, Math.max(1, Math.floor(Number(req.query.limit) || 50)));
    let beforeId = null;
    if (req.query.before != null && req.query.before !== "") {
      beforeId = parseMsgRef(req.query.before);
      if (beforeId == null) return badRequest(res, "before 须为消息 ID（msg_001 或数字）");
    }

    const rows = db
      .prepare(
        `SELECT * FROM task_messages WHERE task_id = ?${beforeId != null ? " AND msg_id < ?" : ""} ORDER BY msg_id DESC LIMIT ?`
      )
      .all(...(beforeId != null ? [taskId, beforeId, limit] : [taskId, limit]));

    let hasMore = false;
    if (rows.length === limit) {
      const minId = rows.at(-1).msg_id;
      hasMore = !!db
        .prepare("SELECT 1 FROM task_messages WHERE task_id = ? AND msg_id < ? LIMIT 1")
        .get(taskId, minId);
    }

    return ok(res, {
      task_id: taskId,
      session_id: row.session_id,
      messages: rows
        .slice()
        .reverse() // 文档示例为升序
        .map((m) => ({
          msg_id: formatMsgId(m.msg_id),
          role: m.role,
          content: m.content,
          pending: !!m.pending, // 1 = 已受理、还没派发给 mimo 的排队消息
          attachments: parseAttachments(m.attachments), // [{filename,size}] 参考物
          created_at: toISO(m.created_at),
        })),
      has_more: hasMore,
    });
  });

  // GET /api/v1/tasks/{task_id}/usage —— 调用统计（任务卡图标点开的信息框数据源）：
  // 当前会话调用的大模型 + 汇总 + 每轮对话的 token/费用/耗时（读 mimocode.db，只读不落库）
  router.get("/tasks/:taskId/usage", requireAuth, (req, res) => {
    const taskId = asInt(req.params.taskId);
    if (taskId == null) return badRequest(res, "task_id 无效");
    const row = getOwnedTask(taskId, req.user.user_id);
    if (!row) return fail(res, 404, "任务不存在", "TASK_NOT_FOUND");
    try {
      const data = buildSessionUsage(row);
      data.generated_at = nowISO();
      return ok(res, data);
    } catch (e) {
      return fail(
        res,
        e.status ?? 500,
        "调用统计读取失败",
        e.status === 503 ? "USAGE_DB_UNAVAILABLE" : "USAGE_READ_FAILED",
        e.message
      );
    }
  });

  // GET /api/v1/tasks/{task_id}/artifacts —— 产物列表（实时扫描目录并同步表记录）
  router.get("/tasks/:taskId/artifacts", requireAuth, async (req, res) => {
    const taskId = asInt(req.params.taskId);
    if (taskId == null) return badRequest(res, "task_id 无效");
    const row = getOwnedTask(taskId, req.user.user_id);
    if (!row) return fail(res, 404, "任务不存在", "TASK_NOT_FOUND");

    const artifacts = await syncArtifacts(taskId);
    return ok(res, {
      task_id: taskId,
      dir: `taskRes/${taskId}`,
      total: artifacts.length,
      // 已按文件 mtime 倒序（最新在前）；mtime 为文件最后写入时间
      artifacts: artifacts.map((a) => ({
        artifact_id: a.artifact_id,
        filename: a.filename,
        rel_path: a.rel_path,
        size: a.size,
        created_at: toISO(a.created_at),
        mtime: a.mtimeMs != null ? toISO(new Date(a.mtimeMs).toISOString().slice(0, 19).replace("T", " ")) : null,
      })),
    });
  });

  // GET /api/v1/tasks/{task_id}/artifacts/{artifact_id}/download —— 下载（?inline=1 预览，?token= 兜底认证）
  router.get("/tasks/:taskId/artifacts/:artifactId/download", requireAuthOrToken, async (req, res) => {
    const taskId = asInt(req.params.taskId);
    const artifactId = asInt(req.params.artifactId);
    if (taskId == null || artifactId == null) return badRequest(res, "id 无效");
    const task = getOwnedTask(taskId, req.user.user_id);
    if (!task) return fail(res, 404, "任务不存在", "TASK_NOT_FOUND");

    const rec = db
      .prepare("SELECT * FROM task_artifacts WHERE artifact_id = ? AND task_id = ?")
      .get(artifactId, taskId);
    if (!rec) return fail(res, 404, "产物不存在", "ARTIFACT_NOT_FOUND");

    const abs = safeArtifactPath(taskId, rec.rel_path);
    const st = abs ? await stat(abs).catch(() => null) : null;
    if (!st || !st.isFile()) {
      // 文件被外部删除：清掉残留记录
      db.prepare("DELETE FROM task_artifacts WHERE artifact_id = ?").run(artifactId);
      return fail(res, 404, "产物文件已不存在", "ARTIFACT_NOT_FOUND");
    }

    if (req.query.inline != null) {
      return res.sendFile(abs); // 内联预览：不带 attachment 头，浏览器按 MIME 渲染
    }
    res.download(abs, rec.filename, (err) => {
      if (err && !res.headersSent) fail(res, 500, "下载失败", "DOWNLOAD_FAILED", err.message);
    });
  });

  // PUT /api/v1/tasks/{task_id}/cancel —— 取消（杀掉 mimo 子进程）
  router.put("/tasks/:taskId/cancel", requireAuth, (req, res) => {
    const taskId = asInt(req.params.taskId);
    if (taskId == null) return badRequest(res, "task_id 无效");
    const row = getOwnedTask(taskId, req.user.user_id);
    if (!row) return fail(res, 404, "任务不存在", "TASK_NOT_FOUND");
    if (!ACTIVE_STATES.has(row.state)) {
      return fail(res, 409, `任务已${row.state === "cancelled" ? "取消" : "结束"}，无法取消`, "INVALID_STATE");
    }

    const entry = activeRuns.get(taskId);
    if (entry) {
      entry.canceling = true; // finalizeRun 见此标志后跳过写库/广播
      if (entry.hb) clearInterval(entry.hb);
      killRunTree(entry.child);
    }
    // 排队消息永远不会跑：删除，避免任务已取消却残留 pending
    db.prepare("DELETE FROM task_messages WHERE task_id = ? AND pending = 1").run(taskId);
    const nowNaive = new Date().toISOString().slice(0, 19).replace("T", " ");
    const duration = sinceSec(row.started_at || row.created_at);
    db.prepare(
      "UPDATE tasks SET state='cancelled', completed_at=?, duration_sec=?, error_message=NULL, " +
        "updated_at=datetime('now', 'localtime') WHERE task_id=?"
    ).run(nowNaive, duration, taskId);
    broadcast("task_state_changed", {
      task_id: taskId,
      old_state: row.state,
      new_state: "cancelled",
      progress: row.progress ?? 0,
      completed_at: toISO(nowNaive),
    });

    return ok(res, { task_id: taskId, state: "cancelled", session_id: row.session_id ?? null });
  });

  // DELETE /api/v1/tasks/{task_id} —— 删除任务（先杀运行中的会话，产物目录一并清理）
  router.delete("/tasks/:taskId", requireAuth, async (req, res) => {
    const taskId = asInt(req.params.taskId);
    if (taskId == null) return badRequest(res, "task_id 无效");
    const row = getOwnedTask(taskId, req.user.user_id);
    if (!row) return fail(res, 404, "任务不存在", "TASK_NOT_FOUND");

    const entry = activeRuns.get(taskId);
    if (entry) {
      entry.canceling = true;
      if (entry.hb) clearInterval(entry.hb);
      killRunTree(entry.child);
      activeRuns.delete(taskId);
    }
    db.prepare("DELETE FROM task_messages WHERE task_id = ?").run(taskId);
    await removeTaskArtifacts(taskId);
    db.prepare("DELETE FROM tasks WHERE task_id = ? AND user_id = ?").run(taskId, req.user.user_id);
    return ok(res, null);
  });

  router.use((err, req, res, _next) => {
    console.error("[TaskApi]", err);
    if (res.headersSent) return;
    if (
      err?.status === 413 ||
      err?.type === "request.too.large" ||
      err?.type === "entity.too.large"
    ) {
      return fail(res, 413, "请求体超过限制", "PAYLOAD_TOO_LARGE");
    }
    fail(res, 500, "服务器内部错误", "INTERNAL_ERROR");
  });

  app.use("/api/v1", router);

  // detached 让子进程自成进程组（否则 kill(-pid) 会连服务器一起杀），
  // 代价是 Ctrl-C 不再顺带带走它们——退出前自行收尾，别留孤儿 agent
  for (const sig of ["SIGINT", "SIGTERM"]) {
    process.once(sig, () => {
      for (const run of activeRuns.values()) {
        if (run.hb) clearInterval(run.hb);
        killRunTree(run.child);
      }
      process.exit(sig === "SIGINT" ? 130 : 143);
    });
  }

  return { db };
}

// ---------------------------------------------------------------------------
// WebSocket：/ws/tasks?token=<access_token>
// 手写最小 RFC6455 服务端（文档 §4；离线装不了 ws 包，Node 内置的是客户端）。
// 只做服务端推送 + 客户端 ping/close 处理，不解析客户端发来的文本帧。
// ---------------------------------------------------------------------------

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

function rejectUpgrade(socket, status, text) {
  const body = text || "";
  socket.write(
    `HTTP/1.1 ${status} ${status === 401 ? "Unauthorized" : status === 404 ? "Not Found" : "Bad Request"}` +
      `\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`
  );
  socket.destroy();
}

function wsWrite(socket, opcode, payload) {
  try {
    socket.write(wsFrame(opcode, payload));
  } catch {
    wsClients.delete(socket);
  }
}

function handleClientData(socket, state, chunk) {
  state.buf = Buffer.concat([state.buf, chunk]);
  for (;;) {
    const buf = state.buf;
    if (buf.length < 2) return;
    const opcode = buf[0] & 0x0f;
    const masked = (buf[1] & 0x80) !== 0;
    let len = buf[1] & 0x7f;
    let off = 2;
    if (len === 126) {
      if (buf.length < 4) return;
      len = buf.readUInt16BE(2);
      off = 4;
    } else if (len === 127) {
      if (buf.length < 10) return;
      const big = buf.readBigUInt64BE(2);
      if (big > 10_000_000n) {
        socket.destroy(); // 异常大帧，直接断开
        return;
      }
      len = Number(big);
      off = 10;
    }
    const maskOff = off;
    const dataOff = off + (masked ? 4 : 0);
    if (buf.length < dataOff + len) return;

    let payload = buf.subarray(dataOff, dataOff + len);
    if (masked) {
      const mask = buf.subarray(maskOff, maskOff + 4);
      payload = Buffer.from(payload);
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
    }
    state.buf = buf.subarray(dataOff + len);

    if (opcode === 0x8) {
      // close：回一个 close 帧后断开
      wsWrite(socket, 0x8, payload.subarray(0, 2));
      wsClients.delete(socket);
      socket.end();
      return;
    }
    if (opcode === 0x9) wsWrite(socket, 0xa, payload); // ping → pong
    // 0xa pong 忽略；0x1/0x2 客户端文本/二进制按协议忽略（本接口只做推送）
  }
}

let wsWired = false;

export function attachTaskWs(server) {
  if (wsWired) return;
  wsWired = true;

  server.on("upgrade", (req, socket, head) => {
    let url;
    try {
      url = new URL(req.url, "http://localhost");
    } catch {
      return rejectUpgrade(socket, 400);
    }
    if (url.pathname !== "/ws/tasks") return rejectUpgrade(socket, 404);

    const token = url.searchParams.get("token");
    if (!token) return rejectUpgrade(socket, 401, "missing token");
    // 断联中继：客户端带上自己已收到的最大 seq，握手后补发其错过的事件；
    // since 缺省（首次连接）不重放 —— 客户端在加载快照时已拿到 server_seq
    const sinceRaw = url.searchParams.get("since");
    const since = sinceRaw != null && /^\d+$/.test(sinceRaw) ? Number(sinceRaw) : null;

    // 认证与 HTTP 路由同一套校验（签名/类型/吊销/用户存在）
    verifyAccessToken(token)
      .then(({ user }) => {
        const key = req.headers["sec-websocket-key"];
        if (!key) return rejectUpgrade(socket, 400);
        const accept = createHash("sha1").update(key + WS_GUID).digest("base64");
        socket.write(
          "HTTP/1.1 101 Switching Protocols\r\n" +
            "Upgrade: websocket\r\n" +
            "Connection: Upgrade\r\n" +
            `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
        );
        socket.setNoDelay(true);

        const state = { buf: Buffer.alloc(0) };
        if (head?.length) handleClientData(socket, state, head);
        socket.on("data", (chunk) => handleClientData(socket, state, chunk));
        const drop = () => wsClients.delete(socket);
        socket.on("close", drop);
        socket.on("error", drop);
        // 先入列再重放（同 tick 内无交错）：重放期间广播的新事件会带着更大的
        // seq 直达本连接，客户端按 lastSeq 去重即可
        wsClients.add(socket);
        replayEvents(socket, user.user_id, since);
      })
      .catch(() => rejectUpgrade(socket, 401, "invalid token"));
  });

  // 保活 + 探测死连接（服务端 ping，客户端自动回 pong）
  const ping = setInterval(() => {
    for (const s of wsClients) {
      if (s.destroyed || !s.writable) wsClients.delete(s);
      else wsWrite(s, 0x9, Buffer.alloc(0));
    }
  }, 30_000);
  ping.unref?.();
}

// 独立运行：node TaskApi.js → 同时挂载登录 + 任务接口（任务依赖认证）
const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const app = express();
  app.use(express.json({ limit: "512mb" }));
  mountOperationLog(app); // 全局操作日志（必须先于业务路由）
  mountLoginApi(app);
  mountTaskApi(app);
  const PORT = Number(process.env.PORT) || 3000;
  const server = app.listen(PORT, "0.0.0.0", () => {
    console.log(`Task API running at http://0.0.0.0:${PORT}/api/v1/tasks`);
    console.log(`Task WS running at ws://0.0.0.0:${PORT}/ws/tasks`);
  });
  attachTaskWs(server);
}
