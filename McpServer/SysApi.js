/**
 * 随身互联 —「我的」Tab 系统状态与操作日志接口
 * （依据《接口文档_我的Tab.md》《数据库设计文档_我的Tab.md》实现）
 *
 *   GET  /api/v1/server/status      服务器概览状态（运行时采集，不落库，需 Bearer）
 *   GET  /api/v1/server/metrics     CPU/内存/磁盘使用率（运行时采样，需 Bearer）
 *   GET  /api/v1/server/network     网络上行/下行/延迟（运行时采样，需 Bearer）
 *   GET  /api/v1/server/logs        最近操作记录（读 operation_log，limit 默认 5，需 Bearer）
 *   GET  /api/v1/server/logs/all    全部操作记录分页（page/pageSize/result/keyword/时间范围，需 Bearer）
 *   POST /api/v1/server/reboot      重启服务器（页面底部唯一按钮；调用仓库根目录 restart.sh
 *                                   真实重启前后端——脚本第一步就 pkill 本进程，故响应发出后
 *                                   再 spawn 脚本；新进程启动即为 running，需 Bearer）
 *
 * 数据库：SQLite（复用 LoginApi 的 getDb() 连接，库文件 data/suishen.db），唯一表 operation_log
 * （数据库文档 v1.4：实时状态不落库、活动日志已移除，只保留操作日志）。建表/种子/7天清理与
 * **全局**操作留痕中间件在 OpLog.js（覆盖登录/任务/上传/MCP/系统全部接口），本模块只做读取。
 * 实时状态：状态机与启动时间存模块内存；CPU/内存/磁盘/网络从 os、df、/proc 实时读取，不进数据库。
 *
 * 与文档的差异（均有原因）：
 * 1. 通用响应信封沿用本服务 LoginApi/TaskApi 约定 —— 成功 { code, message, data, timestamp }
 *    （code=HTTP 200），失败 { code, message, error:{ type, detail } }（code=HTTP 状态码），
 *    而非文档的 code:0。文档业务错误码经 error.type 映射后写入 operation_log.result_code
 *    （0 成功 / 1001 / 1002 / 2001 / 2002 / 2003 / 5000，与文档口径一致）。
 *    HTTP 映射：1001→400 INVALID_REQUEST，1002→401 AUTH_*，2001→404 SERVER_NOT_FOUND，
 *    2002→409 SERVER_STATE_INVALID，2003→409 REBOOT_IN_PROGRESS，5000→500 INTERNAL_ERROR。
 * 2. 名称/IP/OS/CPU/运行时间取本机真实运行时值（可用 SYS_NAME / SYS_IP / SYS_OS 环境变量覆盖）；
 *    「重启服务器」= 调用仓库根目录 restart.sh 做真实重启（停止并重启 :3000 后端与 :5173 前端，
 *    不是系统级 reboot）；响应里的 restarting 仅存续到脚本杀掉本进程为止，脚本没杀掉本进程时
 *    （缺失/中途失败）由 error/exit 监听回滚为 running。
 * 3. 响应字段按文档使用 camelCase（serverId / resultCode / occurredAt …），与库列 snake_case
 *    在序列化时转换。
 * 4. status/metrics/network 为 10s 轮询，**不写**操作日志（OpLog 的规则表已剔除，
 *    否则打开「我的」页日志区全是"查看服务器状态"）；留痕只覆盖查日志/重启等主动操作。
 *
 * 挂载方式：import { mountSysApi } from "./SysApi.js"; mountSysApi(app);
 * 独立运行：node SysApi.js  （会同时挂载登录接口 —— 系统接口依赖其认证）
 */
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execSync, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import express from "express";
import cors from "cors";
import { getDb, requireAuth, isPrivateOrigin, mountLoginApi } from "./LoginApi.js";
import { ensureOperationLog, mountOperationLog } from "./OpLog.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SERVER_ID = 1; // 文档：单服务器（缺省 serverId=1）
const REBOOT_SECONDS = 10; // 文档 POST /reboot：estimatedSeconds（restart.sh 冷启动经验 6~10s）
const RESTART_SCRIPT = path.resolve(__dirname, "..", "restart.sh"); // 仓库根目录的重启脚本
const LATENCY_TTL_MS = 5_000; // 延迟探测缓存（ping 每 5s 最多一次）
const CPU_SAMPLE_MS = 200; // CPU 首次采样两次读取的间隔

// ---------------------------------------------------------------------------
// 通用响应结构：{ code, message, data, timestamp } / 错误 { code, message, error }
// （与 LoginApi.js / TaskApi.js 保持一致）
// ---------------------------------------------------------------------------

const pad = (n) => String(n).padStart(2, "0");

function nowISO() {
  const d = new Date();
  const t = new Date(d.getTime() + (8 * 60 + d.getTimezoneOffset()) * 60000);
  return (
    `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}` +
    `T${pad(t.getHours())}:${pad(t.getMinutes())}:${pad(t.getSeconds())}+08:00`
  );
}

// 文档时间格式：yyyy-MM-dd HH:mm:ss（本地时间）
function naiveOf(ms = Date.now()) {
  const d = new Date(ms);
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  );
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
// 服务器实时状态（运行时，不落库）：状态机 + 启动时间 + 本机信息
// ---------------------------------------------------------------------------

const STATE_TEXT = { running: "运行中", restarting: "重启中…", stopped: "已停止" };
const SERVER_NAME = process.env.SYS_NAME || "随身互联服务器";

let serverState = "running";
// 启动时间取系统 uptime（os.uptime），重启成功后重置为当前时刻
let bootTimeMs = Date.now() - (os.uptime?.() ?? 0) * 1000;

function uptimeSeconds() {
  return Math.max(0, Math.floor((Date.now() - bootTimeMs) / 1000));
}

function fmtUptime(sec) {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return `${d}天 ${pad(h)}:${pad(m)}:${pad(s)}`;
}

function lanIPv4() {
  if (process.env.SYS_IP) return process.env.SYS_IP;
  const ifs = os.networkInterfaces();
  for (const list of Object.values(ifs)) {
    for (const it of list || []) {
      if (!it.internal && it.family === "IPv4") return it.address;
    }
  }
  return "127.0.0.1";
}

function cpuBrand() {
  const model = os.cpus()[0]?.model?.trim();
  if (!model) return "CPU";
  const first = model.split(/\s+/)[0].replace(/[()]/g, "");
  return first || "CPU";
}

function osText() {
  if (process.env.SYS_OS) return process.env.SYS_OS;
  return `${os.type()} ${os.release()}`;
}

// --- 重启：调用仓库根目录 restart.sh（真实重启；脚本 stop_backend 第一步 pkill 本进程） ---
function launchRestartScript() {
  try {
    const child = spawn("bash", [RESTART_SCRIPT], {
      cwd: path.resolve(__dirname, ".."),
      detached: true, // 脚本会杀我们：必须脱离父子关系，成为孤儿后继续把新服务拉起来
      stdio: "ignore",
    });
    child.unref();
    // 本进程还活着就收到这些事件 = 脚本没能重启我们（缺失/中途失败）→ 回滚，别永远卡 restarting
    const rollback = (why) => {
      if (serverState === "restarting") {
        serverState = "running";
        bootTimeMs = Date.now();
        console.error(`[SysApi] 重启脚本未完成重启（${why}），状态回滚为 running`);
      }
    };
    child.on("error", (e) => rollback(`spawn error: ${e.message}`));
    child.on("exit", (code) => rollback(`exit code ${code}`));
  } catch (e) {
    if (serverState === "restarting") {
      serverState = "running";
      bootTimeMs = Date.now();
    }
    console.error("[SysApi] 重启脚本启动失败:", e.message);
  }
}

// --- CPU 使用率：两次 os.cpus() 快照差分（首次请求内先隔 CPU_SAMPLE_MS 采一次基线） ---
let prevCpu = null;

function cpuSnapshot() {
  let total = 0;
  let idle = 0;
  for (const c of os.cpus()) {
    const t = c.times;
    total += t.user + t.nice + t.sys + t.idle + t.irq;
    idle += t.idle;
  }
  return { total, idle };
}

function cpuDiff(a, b) {
  const dt = b.total - a.total;
  if (dt <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((1 - (b.idle - a.idle) / dt) * 100)));
}

async function readCpuPercent() {
  const first = cpuSnapshot();
  if (prevCpu) {
    const pct = cpuDiff(prevCpu, first);
    prevCpu = first;
    return pct;
  }
  await new Promise((r) => setTimeout(r, CPU_SAMPLE_MS));
  const second = cpuSnapshot();
  prevCpu = second;
  return cpuDiff(first, second);
}

// --- 磁盘：df -kP /（Linux/Android 可用；失败时返回 0 兜底） ---
function readDisk() {
  try {
    const out = execSync("df -kP /", { encoding: "utf-8", timeout: 2000 });
    const line = out.trim().split("\n")[1] || "";
    const parts = line.split(/\s+/);
    const totalKb = Number(parts[1]);
    const usedKb = Number(parts[2]);
    if (!Number.isFinite(totalKb) || totalKb <= 0) throw new Error("bad df output");
    return {
      percent: Math.min(100, Math.round((usedKb / totalKb) * 100)),
      usedGb: Math.round((usedKb / 1048576) * 10) / 10,
      totalGb: Math.round((totalKb / 1048576) * 10) / 10,
    };
  } catch {
    return { percent: 0, usedGb: 0, totalGb: 0 };
  }
}

// --- 网络速率：/proc/net/dev 两次采样差分（排除 lo） ---
let prevNet = null;

function netSnapshot() {
  try {
    const txt = readFileSync("/proc/net/dev", "utf-8");
    let rx = 0;
    let tx = 0;
    for (const line of txt.split("\n").slice(2)) {
      const idx = line.indexOf(":");
      if (idx < 0) continue;
      const iface = line.slice(0, idx).trim();
      if (iface === "lo") continue;
      const p = line.slice(idx + 1).trim().split(/\s+/);
      rx += Number(p[0]) || 0;
      tx += Number(p[8]) || 0;
    }
    return { rx, tx, at: Date.now() };
  } catch {
    return null;
  }
}

function formatBps(bps) {
  if (bps >= 1e6) return `${(bps / 1e6).toFixed(1)} MB/s`;
  if (bps >= 1e3) return `${(bps / 1e3).toFixed(1)} KB/s`;
  return `${Math.round(bps)} B/s`;
}

// --- 延迟：ping 默认网关（/proc/net/route 解析），结果缓存 5s；任何失败返回 0 ---
let latencyCache = { at: 0, ms: 0 };

function defaultGateway() {
  try {
    const txt = readFileSync("/proc/net/route", "utf-8");
    for (const line of txt.split("\n").slice(1)) {
      const p = line.trim().split(/\s+/);
      if (p[1] === "00000000" && p[2] && p[2] !== "00000000") {
        const bytes = (p[2].match(/../g) || []).map((h) => parseInt(h, 16)).reverse();
        const ip = bytes.join(".");
        if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return ip; // 校验后再进命令行，防注入
      }
    }
  } catch {
    /* /proc 不可读时放弃 */
  }
  return null;
}

function readLatencyMs() {
  if (Date.now() - latencyCache.at < LATENCY_TTL_MS) return latencyCache.ms;
  let ms = 0;
  const gw = defaultGateway();
  if (gw) {
    try {
      const out = execSync(`ping -c 1 -W 1 ${gw}`, { encoding: "utf-8", timeout: 2000 });
      const m = out.match(/time[=<]([\d.]+)\s*ms/);
      if (m) ms = Math.round(Number(m[1]));
    } catch {
      ms = 0;
    }
  }
  latencyCache = { at: Date.now(), ms };
  return ms;
}

// operation_log 的建表/种子/清理与全局留痕中间件在 OpLog.js，这里只保留读取连接
let db = null;

// ---------------------------------------------------------------------------
// 路由（前缀 /api/v1/server，全部走 requireAuth）
// ---------------------------------------------------------------------------

const asInt = (v) => {
  const n = Number(v);
  return Number.isInteger(n) ? n : null;
};

// 缺省为 1；显式传入其他值按文档 2001 处理。返回 null 表示已响应错误。
function resolveServerId(raw, res) {
  if (raw === undefined || raw === null || raw === "") return SERVER_ID;
  const n = asInt(raw);
  if (n === null) {
    badRequest(res, "serverId 必须为整数");
    return null;
  }
  if (n !== SERVER_ID) {
    fail(res, 404, "服务器不存在", "SERVER_NOT_FOUND");
    return null;
  }
  return n;
}

export function mountSysApi(app) {
  ensureOperationLog(); // 建表/种子在 OpLog；本模块随后只读
  db = getDb();

  const router = express.Router();
  router.use(express.json());
  router.use(
    cors({
      origin: isPrivateOrigin,
      methods: ["GET", "POST", "OPTIONS"],
      allowedHeaders: ["Authorization", "Content-Type", "X-Device-Id", "X-Request-Id"],
    })
  );

  // GET /api/v1/server/status —— 概览状态（运行时，不落库）
  router.get("/status", requireAuth, (req, res) => {
    const serverId = resolveServerId(req.query.serverId, res);
    if (serverId === null) return;

    const cores = os.cpus().length;
    const up = uptimeSeconds();
    return ok(res, {
      serverId,
      name: SERVER_NAME,
      state: serverState,
      stateText: STATE_TEXT[serverState],
      uptime: fmtUptime(up),
      uptimeSeconds: up,
      ip: lanIPv4(),
      os: osText(),
      cpuCores: cores,
      cpuModel: cpuBrand(),
      bootTime: naiveOf(bootTimeMs),
    });
  });

  // GET /api/v1/server/metrics —— CPU/内存/磁盘（运行时采样，不落库）
  router.get("/metrics", requireAuth, async (req, res, next) => {
    try {
      const serverId = resolveServerId(req.query.serverId, res);
      if (serverId === null) return;

      const cpuPercent = await readCpuPercent();
      const cores = os.cpus().length;
      const totalMem = os.totalmem();
      const freeMem = os.freemem();
      const memPercent = totalMem > 0 ? Math.round(((totalMem - freeMem) / totalMem) * 100) : 0;
      const disk = readDisk();

      return ok(res, {
        serverId,
        sampledAt: naiveOf(),
        cpu: { percent: cpuPercent, cores, model: `${cores}核心 ${cpuBrand()}` },
        memory: {
          percent: memPercent,
          usedGb: Math.round(((totalMem - freeMem) / 1073741824) * 10) / 10,
          totalGb: Math.round((totalMem / 1073741824) * 10) / 10,
        },
        disk: { percent: disk.percent, usedGb: disk.usedGb, totalGb: disk.totalGb },
      });
    } catch (e) {
      next(e);
    }
  });

  // GET /api/v1/server/network —— 上行/下行/延迟（运行时采样，不落库）
  router.get("/network", requireAuth, (req, res) => {
    const serverId = resolveServerId(req.query.serverId, res);
    if (serverId === null) return;

    const snap = netSnapshot();
    let uploadBps = 0;
    let downloadBps = 0;
    if (snap && prevNet) {
      const dt = (snap.at - prevNet.at) / 1000;
      if (dt > 0) {
        uploadBps = Math.max(0, Math.round((snap.tx - prevNet.tx) / dt));
        downloadBps = Math.max(0, Math.round((snap.rx - prevNet.rx) / dt));
      }
    }
    if (snap) prevNet = snap;

    const latencyMs = readLatencyMs();
    return ok(res, {
      serverId,
      sampledAt: naiveOf(),
      upload: formatBps(uploadBps),
      uploadBps,
      download: formatBps(downloadBps),
      downloadBps,
      latencyMs,
      latencyText: `${latencyMs}ms`,
    });
  });

  // GET /api/v1/server/logs —— 最近操作记录（页面日志区，limit 默认 5）
  router.get("/logs", requireAuth, (req, res) => {
    const serverId = resolveServerId(req.query.serverId, res);
    if (serverId === null) return;

    const limitRaw = req.query.limit;
    let limit = 5;
    if (limitRaw !== undefined && limitRaw !== "") {
      const n = asInt(limitRaw);
      if (n === null) return badRequest(res, "limit 必须为整数");
      limit = Math.min(50, Math.max(1, n));
    }
    const result = parseResultFilter(req, res);
    if (result === null) return;

    const where = ["server_id = ?"];
    const args = [serverId];
    if (result === "success") where.push("result_code = 0");
    if (result === "fail") where.push("result_code <> 0");

    const total = db
      .prepare(`SELECT COUNT(*) AS n FROM operation_log WHERE ${where.join(" AND ")}`)
      .get(...args).n;
    const rows = db
      .prepare(
        `SELECT op_id, occurred_at, action, content, result_code
         FROM operation_log WHERE ${where.join(" AND ")}
         ORDER BY occurred_at DESC, op_id DESC LIMIT ?`
      )
      .all(...args, limit);

    return ok(res, { total, list: rows.map(toLogItem) });
  });

  // GET /api/v1/server/logs/all —— 全部操作记录分页
  router.get("/logs/all", requireAuth, (req, res) => {
    const serverId = resolveServerId(req.query.serverId, res);
    if (serverId === null) return;

    let page = 1;
    let pageSize = 20;
    if (req.query.page !== undefined && req.query.page !== "") {
      const n = asInt(req.query.page);
      if (n === null || n < 1) return badRequest(res, "page 必须为 ≥1 的整数");
      page = n;
    }
    if (req.query.pageSize !== undefined && req.query.pageSize !== "") {
      const n = asInt(req.query.pageSize);
      if (n === null || n < 1) return badRequest(res, "pageSize 必须为 ≥1 的整数");
      pageSize = Math.min(100, n);
    }
    const result = parseResultFilter(req, res);
    if (result === null) return;

    const where = ["server_id = ?"];
    const args = [serverId];
    if (result === "success") where.push("result_code = 0");
    if (result === "fail") where.push("result_code <> 0");
    if (req.query.keyword) {
      where.push("(action LIKE ? OR content LIKE ?)");
      const kw = `%${String(req.query.keyword)}%`;
      args.push(kw, kw);
    }
    if (req.query.startTime) {
      where.push("occurred_at >= ?");
      args.push(String(req.query.startTime));
    }
    if (req.query.endTime) {
      where.push("occurred_at <= ?");
      args.push(String(req.query.endTime));
    }

    const total = db
      .prepare(`SELECT COUNT(*) AS n FROM operation_log WHERE ${where.join(" AND ")}`)
      .get(...args).n;
    const rows = db
      .prepare(
        `SELECT op_id, occurred_at, action, content, result_code
         FROM operation_log WHERE ${where.join(" AND ")}
         ORDER BY occurred_at DESC, op_id DESC LIMIT ? OFFSET ?`
      )
      .all(...args, pageSize, (page - 1) * pageSize);

    return ok(res, {
      page,
      pageSize,
      total,
      hasMore: page * pageSize < total,
      list: rows.map(toLogItem),
    });
  });

  // POST /api/v1/server/reboot —— 重启服务器（底部唯一按钮；调用 restart.sh 真实重启）
  router.post("/reboot", requireAuth, (req, res) => {
    const body = req.body ?? {};
    const serverId = resolveServerId(body.serverId, res);
    if (serverId === null) return;

    if (body.confirm !== true) {
      return badRequest(res, "confirm 必须为 true");
    }
    if (serverState === "stopped") {
      return fail(res, 409, "服务器状态不允许该操作", "SERVER_STATE_INVALID", "服务器已停止");
    }
    if (serverState === "restarting") {
      return fail(res, 409, "重启任务已存在，重复触发", "REBOOT_IN_PROGRESS");
    }

    serverState = "restarting";
    // 响应先落盘再生脚本：restart.sh 第一步就 pkill 本进程，
    // 必须等 res 'finish'（数据交给内核）+ 100ms 缓冲，否则客户端只拿到 connection reset。
    res.on("finish", () => {
      const t = setTimeout(() => launchRestartScript(), 100);
      t.unref?.();
    });

    return ok(res, {
      state: serverState,
      stateText: STATE_TEXT[serverState],
      estimatedSeconds: REBOOT_SECONDS,
    });
  });

  router.use((err, req, res, _next) => {
    console.error("[SysApi]", err);
    if (!res.headersSent) fail(res, 500, "服务器内部错误", "INTERNAL_ERROR");
  });

  app.use("/api/v1/server", router);
  return { db };
}

// result 筛选：success / fail（缺省不过滤；非法值 1001）。null 表示已响应错误。
function parseResultFilter(req, res) {
  const v = req.query.result;
  if (v === undefined || v === "") return undefined;
  if (v === "success" || v === "fail") return v;
  badRequest(res, "result 只能为 success 或 fail");
  return null;
}

// 库行 → 文档响应字段（camelCase，level 由 result_code 推导）
function toLogItem(row) {
  return {
    id: row.op_id,
    time: String(row.occurred_at).slice(11, 16),
    action: row.action,
    content: row.content,
    level: row.result_code === 0 ? "success" : "error",
    resultCode: row.result_code,
    occurredAt: row.occurred_at,
  };
}

// 独立运行：node SysApi.js → 同时挂载登录 + 系统接口（系统接口依赖认证）
const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const app = express();
  app.use(express.json());
  mountOperationLog(app); // 全局操作日志（必须先于业务路由）
  mountLoginApi(app);
  mountSysApi(app);
  const PORT = Number(process.env.PORT) || 3000;
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Sys API running at http://0.0.0.0:${PORT}/api/v1/server`);
  });
}
