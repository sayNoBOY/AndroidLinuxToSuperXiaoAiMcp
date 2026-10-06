/**
 * 随身互联 —「我的」Tab 系统状态与操作日志接口
 * （依据《接口文档_我的Tab.md》《数据库设计文档_我的Tab.md》实现）
 *
 *   GET  /api/v1/server/status      服务器概览状态（运行时采集，不落库，需 Bearer）
 *   GET  /api/v1/server/metrics     CPU/内存/磁盘使用率（运行时采样，需 Bearer）
 *   GET  /api/v1/server/logs        最近操作记录（读 operation_log，limit 默认 5，需 Bearer）
 *   GET  /api/v1/server/logs/all    全部操作记录分页（page/pageSize/result/keyword/时间范围，需 Bearer）
 *   GET  /api/v1/server/llm         MiMoCode 大模型调用信息（配置文件 / 当前模型 / 模型目录 / 厂商预设，需 Bearer）
 *   POST /api/v1/server/llm/model   切换大模型（写回 mimocode 配置顶层 model + 运行态 recent，需 Bearer）
 *   POST /api/v1/server/llm/provider        新增大模型 provider（Claude/OpenAI/DeepSeek/千问/GLM/Kimi… 预设或自定义；
 *                                           请求体 capabilities 六项布尔为手动能力标定（必填），写入 mimocode 配置，需 Bearer）
 *   POST /api/v1/server/llm/provider/remove 删除已配置的自定义 provider（连带清理其 model/recent，需 Bearer）
 *   POST /api/v1/server/reboot      重启服务器（页面底部唯一按钮；调用仓库根目录 restart.sh
 *                                   真实重启前后端——脚本第一步就 pkill 本进程，故响应发出后
 *                                   再 spawn 脚本；新进程启动即为 running，需 Bearer）
 *
 * 数据库：SQLite（复用 LoginApi 的 getDb() 连接，库文件 data/suishen.db），唯一表 operation_log
 * （数据库文档 v1.4：实时状态不落库、活动日志已移除，只保留操作日志）。建表/种子/7天清理与
 * **全局**操作留痕中间件在 OpLog.js（覆盖登录/任务/上传/MCP/系统全部接口），本模块只做读取。
 * 实时状态：状态机与启动时间存模块内存；CPU/内存/磁盘从 os、df 实时读取，均不进数据库。
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
 * 4. status/metrics 为 10s 轮询，**不写**操作日志（OpLog 的规则表已剔除，
 *    否则打开「我的」页日志区全是"查看服务器状态"）；留痕只覆盖查日志/重启等主动操作。
 * 5. Termux / Android 环境适配：普通 Linux 的取值方式在手机 Termux 里全是错的，逐项换源 ——
 *    操作系统 `Linux <内核>` → `Android <版本> (Termux)`（getprop / build.prop）；CPU 型号在
 *    os.cpus() 只给 "unknown"（arm64 无 model name）时改读 /proc/cpuinfo 的 Hardware/Processor
 *    与 getprop ro.soc.model / ro.board.platform；磁盘从 `/`（只读系统分区，手机上恒为系统盘水位）
 *    改为统计 Termux 的 $HOME（App 真正可写存储）；内存改用 /proc/meminfo 的 MemAvailable
 *    （os.freemem() 是 MemFree，忽略页缓存会把占用率虚高到 90%+）；IP 优先取默认路由网卡
 *    （Termux 里 rmnet/tun/dummy 等网卡常排在 wlan0 前面）；CPU 核数与使用率 —— SELinux 拒读
 *    /proc/stat 时 os.cpus() 返回 []（0 核、使用率恒 0），核数改走 /sys online → /proc/cpuinfo →
 *    availableParallelism 三路兜底，使用率改汇总本进程可见的 /proc/<pid>/stat 差分（口径见下）。
 *
 * 挂载方式：import { mountSysApi } from "./SysApi.js"; mountSysApi(app);
 * 独立运行：node SysApi.js  （会同时挂载登录接口 —— 系统接口依赖其认证）
 *
 * 制作人：老实人留一手（抖音 / B站同名）
 */
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { execFileSync, spawn } from "node:child_process";
import express from "express";
import cors from "cors";
import { getDb, requireAuth, isPrivateOrigin, mountLoginApi } from "./LoginApi.js";
import { ensureOperationLog, mountOperationLog } from "./OpLog.js";
import {
  UsageError,
  currentModelInfo,
  listModels,
  readCredentials,
  readMergedConfig,
  summarizeProviders,
  switchModel,
  addProvider,
  removeProvider,
  PROVIDER_PRESETS,
  ADAPTERS,
} from "./MiMoCodeConfig.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SERVER_ID = 1; // 文档：单服务器（缺省 serverId=1）
const REBOOT_SECONDS = 10; // 文档 POST /reboot：estimatedSeconds（restart.sh 冷启动经验 6~10s）
const RESTART_SCRIPT = path.resolve(__dirname, "..", "restart.sh"); // 仓库根目录的重启脚本
const CPU_SAMPLE_MS = 200; // CPU 首次采样两次读取的间隔

// ---------------------------------------------------------------------------
// 通用响应结构：{ code, message, data, timestamp } / 错误 { code, message, error }
// （与 LoginApi.js / TaskApi.js 保持一致）
// ---------------------------------------------------------------------------

const pad = (n) => String(n).padStart(2, "0");

// 本机墙上时钟 + 本机真实偏移（东八区即 +08:00）：与 TaskApi.toISO / LoginApi 同口径，
// 切片出的墙上时钟恒等于本机 date；硬编码 +08:00 会在 TZ≠+8 的主机上快一个时区差
function isoLocal(d) {
  const off = -d.getTimezoneOffset(); // 分钟，东为正（UTC+8 → 480，UTC → 0）
  const sign = off < 0 ? "-" : "+";
  const a = Math.abs(off);
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `${sign}${pad(Math.floor(a / 60))}:${pad(a % 60)}`
  );
}

function nowISO() {
  return isoLocal(new Date());
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

// ---------------------------------------------------------------------------
// Termux / Android 环境适配：同一台"服务器"在 PC Linux 与手机 Termux 里的取值来源不同
// ---------------------------------------------------------------------------

function readText(file) {
  try {
    return fs.readFileSync(file, "utf-8");
  } catch {
    return "";
  }
}

// Android 系统属性：getprop（Termux 的 PATH 含 /system/bin）→ /system/build.prop，取不到返回 ""
function getProp(key) {
  for (const bin of ["getprop", "/system/bin/getprop"]) {
    try {
      const out = execFileSync(bin, [key], {
        encoding: "utf-8",
        timeout: 1500,
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      if (out) return out;
    } catch {
      // 命令不存在 / 无权限：换下一个来源
    }
  }
  const line = readText("/system/build.prop")
    .split("\n")
    .find((l) => l.startsWith(`${key}=`));
  return line ? line.slice(key.length + 1).trim() : "";
}

// 运行环境探测：TERMUX_VERSION / PREFIX 含 com.termux 判 Termux；能取到 Android 版本判 Android
function detectRuntimeEnv() {
  const termux = Boolean(process.env.TERMUX_VERSION) || (process.env.PREFIX || "").includes("com.termux");
  const release = getProp("ro.build.version.release");
  return { termux, android: termux || Boolean(release), release };
}
const RUNTIME = detectRuntimeEnv(); // 有进程调用，启动探一次即可

// /proc/net/route：目的地址 00000000 且 UP 的默认路由，取 metric 最小那条的网卡；读不到返回 ""
function defaultRouteIface(routeText = readText("/proc/net/route")) {
  let best = null;
  for (const line of routeText.split("\n").slice(1)) {
    const p = line.trim().split(/\s+/);
    if (p.length < 7 || p[1] !== "00000000") continue;
    if (!(parseInt(p[3], 16) & 0x1)) continue; // RTF_UP
    const metric = Number(p[6]) || 0;
    if (!best || metric < best.metric) best = { iface: p[0], metric };
  }
  return best?.iface || "";
}

function lanIPv4() {
  if (process.env.SYS_IP) return process.env.SYS_IP;
  const ifs = os.networkInterfaces();
  const names = Object.keys(ifs);
  // 默认路由网卡优先：Termux 里 rmnet/tun/dummy 等非业务网卡常排在 wlan0 前面被误取
  const prefer = defaultRouteIface();
  const order = prefer && names.includes(prefer) ? [prefer, ...names.filter((n) => n !== prefer)] : names;
  for (const name of order) {
    for (const it of ifs[name] || []) {
      if (!it.internal && (it.family === "IPv4" || it.family === 4)) return it.address;
    }
  }
  return "127.0.0.1";
}

// /proc/cpuinfo 字段：x86 有 model name；arm64 只有 Hardware / CPU part，32 位 ARM 另有 Processor
function cpuinfoField(text, key) {
  const m = new RegExp(`^${key}\\s*:\\s*(.+)$`, "m").exec(text || "");
  return m ? m[1].trim() : "";
}

// 型号串 → 展示用短名：ARM 无型号串取首词（"ARMv8 Processor rev 1" → "ARMv8"，与旧口径一致）；
// 带厂商逗号的 SoC 串取末词（"Qualcomm Technologies, Inc SM8250" → "SM8250"）
const CPU_UNKNOWN = new Set(["", "unknown", "not spec", "n/a", "none", "-", "common"]);

function brandOf(raw) {
  const t = String(raw || "").replace(/\s+/g, " ").trim();
  if (!t || CPU_UNKNOWN.has(t.toLowerCase())) return "";
  const tail = t.includes(",") ? t.split(",").pop().trim() : t;
  const word = t.includes(",") ? tail.split(/\s+/).pop() : tail.split(/\s+/)[0];
  return (word || "").replace(/[()]/g, "");
}

// SoC 型号兜底（arm64 常无 model name）：ro.soc.model（Android 12+）→ ro.board.platform，缓存一次
let socBrandCache;
function socBrand() {
  if (socBrandCache === undefined) {
    socBrandCache = brandOf(getProp("ro.soc.model")) || brandOf(getProp("ro.board.platform")) || "";
  }
  return socBrandCache;
}

function cpuBrand(cpuinfo = readText("/proc/cpuinfo")) {
  if (process.env.SYS_CPU) return process.env.SYS_CPU;
  const found =
    brandOf(os.cpus()[0]?.model) ||
    brandOf(cpuinfoField(cpuinfo, "model name")) ||
    brandOf(cpuinfoField(cpuinfo, "Hardware")) ||
    brandOf(cpuinfoField(cpuinfo, "Processor")) ||
    brandOf(cpuinfoField(cpuinfo, "Model")) ||
    (RUNTIME.android ? socBrand() : "");
  return found || "未知型号";
}

function osText() {
  if (process.env.SYS_OS) return process.env.SYS_OS;
  if (RUNTIME.android) {
    const ver = RUNTIME.release ? `Android ${RUNTIME.release}` : "Android";
    return RUNTIME.termux ? `${ver} (Termux)` : ver;
  }
  return `${os.type()} ${os.release()}`;
}

// "0-7" / "0-3,5" 这类 CPU 亲和集字符串 → 核数；解析不了返回 0
function parseCpuSet(text) {
  let n = 0;
  for (const seg of String(text || "").split(",")) {
    const m = /^(\d+)(?:-(\d+))?$/.exec(seg.trim());
    if (!m) continue;
    const a = Number(m[1]);
    const b = m[2] === undefined ? a : Number(m[2]);
    if (b >= a) n += b - a + 1;
  }
  return n;
}

// CPU 核数：os.cpus() 内部依赖 /proc/stat，Android 非 root 应用被 SELinux 拒读时返回 []（0 核）。
// 此时改读实测可读的源；常规 Linux 第一行就短路返回，行为不变。
function cpuCoreCount() {
  const fromCpus = os.cpus().length;
  if (fromCpus > 0) return fromCpus;

  const online = parseCpuSet(readText("/sys/devices/system/cpu/online")); // 例 "0-7" → 8
  if (online > 0) return online;

  const listed = (readText("/proc/cpuinfo").match(/^processor/gm) || []).length;
  if (listed > 0) return listed;

  return os.availableParallelism?.() || 1;
}

// Termux 下 `/` 是只读系统分区（df / 显示的是手机系统盘水位、无意义），统计 App 真正可写的 $HOME
function diskTarget() {
  return RUNTIME.termux ? process.env.HOME || process.env.PREFIX || "/" : "/";
}

// 取值函数对外导出：验证脚本注入伪造的 /proc 文本与环境做断言（不新增任何路由/页面字段）
export {
  detectRuntimeEnv,
  osText,
  cpuBrand,
  readDisk,
  readMemory,
  lanIPv4,
  diskTarget,
  defaultRouteIface,
  cpuCoreCount,
  parseCpuSet,
  cpuSnapshot,
  cpuDiff,
  readCpuPercent,
};

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

// --- CPU 使用率：两次快照差分（首次请求内先隔 CPU_SAMPLE_MS 采一次基线） ---
// 快照带 mode，两条口径：
//   "cpus" —— os.cpus() 非空的常规 Linux，times 求和差分（与原实现一致）；
//   "proc" —— /proc/stat 被 SELinux 拒读（os.cpus() 为 []）时，汇总本 UID 可见进程
//             /proc/<pid>/stat 的 utime+stime，按 Δticks / (Δ秒 × USER_HZ × 核数) 折算。
//             口径 = 本服务器（Termux 自身）的 CPU 占用，不是整机全局占用。
const USER_HZ = 100; // 实测标定：满载子进程 196 ticks / 2.004s ≈ 97.8 → 100 Hz
let prevCpu = null;

// 遍历 /proc/<pid>/stat 累加 utime+stime（单位 tick）。pid 在采样间隙退出/无权限则跳过。
function procCpuJiffies() {
  let names;
  try {
    names = fs.readdirSync("/proc");
  } catch {
    return 0;
  }
  let sum = 0;
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const text = fs.readFileSync(`/proc/${name}/stat`, "utf-8");
      const close = text.lastIndexOf(")"); // comm 可含空格/括号，以最后一个 ")" 为界
      if (close < 0) continue;
      const f = text.slice(close + 2).split(" ");
      // f[0]=state(字段3)，故 utime=14 → f[11]，stime=15 → f[12]
      const utime = Number(f[11]);
      const stime = Number(f[12]);
      if (Number.isFinite(utime) && Number.isFinite(stime)) sum += utime + stime;
    } catch {
      // 进程退出 / 无权限：跳过，不影响其余进程求和
    }
  }
  return sum;
}

function cpuSnapshot() {
  const cpus = os.cpus();
  if (cpus.length > 0) {
    let total = 0;
    let idle = 0;
    for (const c of cpus) {
      const t = c.times;
      total += t.user + t.nice + t.sys + t.idle + t.irq;
      idle += t.idle;
    }
    return { mode: "cpus", total, idle, at: Date.now() };
  }
  return { mode: "proc", total: procCpuJiffies(), cores: cpuCoreCount(), at: Date.now() };
}

function cpuDiff(a, b) {
  if (a.mode !== b.mode) return 0; // 两种口径的数字不能相减
  if (a.mode === "proc") {
    const dt = b.total - a.total;
    const sec = (b.at - a.at) / 1000;
    const cores = b.cores || a.cores || 1;
    if (dt <= 0 || sec <= 0) return 0;
    return Math.max(0, Math.min(100, Math.round((dt / (sec * USER_HZ * cores)) * 100)));
  }
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

// --- 磁盘：df -kP <磁盘根>（Linux/Termux 可用；失败时返回 0 兜底） ---
function readDisk() {
  try {
    const out = execFileSync("df", ["-kP", diskTarget()], { encoding: "utf-8", timeout: 2000 });
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

// --- 内存：/proc/meminfo 的 MemAvailable（真正可回收的可用内存）；读不到时退回 os.freemem() ---
// os.freemem() 取的是 MemFree，忽略页缓存，Linux/Android 上会把占用率虚高到 90%+
function readMemory(meminfo = readText("/proc/meminfo")) {
  const kbOf = (key) => {
    const m = new RegExp(`^${key}:\\s+(\\d+) kB$`, "m").exec(meminfo);
    return m ? Number(m[1]) : 0;
  };
  const totalKb = kbOf("MemTotal");
  const availKb = kbOf("MemAvailable");
  if (totalKb > 0 && availKb > 0) {
    const usedKb = Math.max(0, totalKb - availKb);
    return {
      percent: Math.min(100, Math.round((usedKb / totalKb) * 100)),
      usedGb: Math.round((usedKb / 1048576) * 10) / 10,
      totalGb: Math.round((totalKb / 1048576) * 10) / 10,
    };
  }
  const total = os.totalmem();
  const free = os.freemem();
  return {
    percent: total > 0 ? Math.round(((total - free) / total) * 100) : 0,
    usedGb: Math.round(((total - free) / 1073741824) * 10) / 10,
    totalGb: Math.round((total / 1073741824) * 10) / 10,
  };
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

    const cores = cpuCoreCount();
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
      const cores = cpuCoreCount();
      const memory = readMemory();
      const disk = readDisk();

      return ok(res, {
        serverId,
        sampledAt: naiveOf(),
        cpu: { percent: cpuPercent, cores, model: `${cores}核心 ${cpuBrand()}` },
        memory,
        disk: { percent: disk.percent, usedGb: disk.usedGb, totalGb: disk.totalGb },
      });
    } catch (e) {
      next(e);
    }
  });

  // GET /api/v1/server/llm —— MiMoCode 大模型调用信息（读配置与运行态，模型目录 60s 缓存，不落库）
  //   不进 OpLog：与 status/metrics 同类，属页面读取，用户明确要求轮询类读取不刷日志。
  router.get("/llm", requireAuth, async (req, res, next) => {
    try {
      const serverId = resolveServerId(req.query.serverId, res);
      if (serverId === null) return;

      const refresh = req.query.refresh === "1" || req.query.refresh === "true";
      const list = await listModels({ refresh });
      const merged = readMergedConfig();
      const cur = currentModelInfo();
      const credentials = readCredentials();
      const models = (list.models || []).map((m) => ({
        ...m,
        isCurrent: Boolean(cur.active) && m.key === cur.active,
        isRecent: cur.recent.includes(m.key),
        isFavorite: cur.favorite.includes(m.key),
      }));
      const customProviders = summarizeProviders(merged.effective);

      return ok(res, {
        serverId,
        current: {
          model: cur.configModel,
          active: cur.active,
          isGroup: cur.isGroup,
          resolved: cur.resolved,
          source: cur.source,
          sourceFile: cur.sourceFile,
          recent: cur.recent,
          favorite: cur.favorite,
          stateFile: cur.stateFile,
        },
        config: {
          files: cur.files,
          modelGroups: cur.modelGroups,
          groupNames: cur.groupNames,
          customProviders,
        },
        credentials,
        providers: [...new Set(models.map((m) => m.providerID))],
        presets: PROVIDER_PRESETS,
        adapters: Object.entries(ADAPTERS).map(([npm, v]) => ({ npm, ...v })),
        models,
        listError: list.error || null,
        refreshedAt: naiveOf(),
      });
    } catch (e) {
      next(e);
    }
  });

  // POST /api/v1/server/llm/model —— 切换大模型（写回配置顶层 model，校验失败回 400）
  router.post("/llm/model", requireAuth, async (req, res, next) => {
    try {
      const body = req.body ?? {};
      const serverId = resolveServerId(body.serverId, res);
      if (serverId === null) return;

      const r = await switchModel(body.model);
      return ok(res, { serverId, appliedAt: naiveOf(), ...r });
    } catch (e) {
      if (e instanceof UsageError) return badRequest(res, e.message);
      next(e);
    }
  });

  // POST /api/v1/server/llm/provider —— 新增大模型（厂商预设 / 自定义端点，写 provider + 可选设为当前）
  router.post("/llm/provider", requireAuth, async (req, res, next) => {
    try {
      const body = req.body ?? {};
      const serverId = resolveServerId(body.serverId, res);
      if (serverId === null) return;

      const r = await addProvider(body);
      return ok(res, { serverId, appliedAt: naiveOf(), ...r });
    } catch (e) {
      if (e instanceof UsageError) return badRequest(res, e.message);
      next(e);
    }
  });

  // POST /api/v1/server/llm/provider/remove —— 删除已配置的自定义 provider
  router.post("/llm/provider/remove", requireAuth, async (req, res, next) => {
    try {
      const body = req.body ?? {};
      const serverId = resolveServerId(body.serverId, res);
      if (serverId === null) return;

      const r = await removeProvider(body);
      return ok(res, { serverId, appliedAt: naiveOf(), ...r });
    } catch (e) {
      if (e instanceof UsageError) return badRequest(res, e.message);
      next(e);
    }
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
        `SELECT op_id, occurred_at, action, content, result_code, action_key, result_msg
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
        `SELECT op_id, occurred_at, action, content, result_code, action_key, result_msg
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
    // 纯增量字段：action_key 供前端 i18n（oplog.<key>），老数据为 null 时前端回退 action 原文
    action_key: row.action_key,
    result_msg: row.result_msg,
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
