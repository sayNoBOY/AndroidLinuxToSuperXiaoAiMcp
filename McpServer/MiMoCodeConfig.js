/**
 * MiMoCode 大模型配置读取 / 切换 —— 供 SysApi 的 /api/v1/server/llm* 接口使用
 *
 * 读取（依据 MiMoCode 官方配置约定）：
 *   配置文件：全局 $MIMOCODE_CONFIG_DIR / ~/.config/mimocode/{config.json,mimocode.json,mimocode.jsonc}
 *             → 项目 <repo>/.mimocode/{mimocode.json,mimocode.jsonc}（后者覆盖前者）
 *   运行态：  $MIMOCODE_HOME/state/model.json 或 ~/.local/state/mimocode/model.json（TUI 最近使用 / 收藏）
 *   凭据：    $MIMOCODE_HOME/auth.json     或 ~/.local/share/mimocode/auth.json（只读，密钥绝不外发）
 *   模型目录：`mimo models --verbose`（CLI 权威输出，带窗口/计费/能力元数据，60s 缓存）
 *
 * 切换：把顶层 `model` 定点写进**优先级最高且已存在**的配置文件（JSONC 注释原样保留），
 *       并按官方约定把目标模型插到 state/model.json 的 recent 首位（去重、上限 10）。
 *
 * 能力：新增大模型时由用户**手动标定** 6 项能力（推理/工具调用/附件/图像/音频/视频输入），
 *       显式写入 provider.<id>.models.<id>（reasoning / tool_call / attachment / modalities）。
 *       任务 95：已移除自动标定流水线（catalog/probe/preset/default 档、图像+音频探针、
 *       识图预设名单、能力再初始化接口）——能力真值以用户勾选为准，配置即运行态真值。
 *
 * xiaomi 系特殊处理（任务 93，实测依据 taskRes/93/evidence/runtime_auth_matrix_result.txt）：
 *   ① 能力：mimo/xiaomi 同源网关家族，目录按 modelID 跨 provider 查（mimo-v2.5 实挂 xiaomi 目录），
 *      避免「单加 mimo 模型被标纯文本」；② 连接：家族内未填 apiKey 且已有 `mimo auth login`
 *      登录凭据时走 auth 方式连接——providerID 归一为 xiaomi（运行时按 providerID 精确取
 *      auth.json 凭据）、options.baseURL 改写为登录网关 metadata.base_url（预设端点不认登录凭据）、
 *      不写明文 apiKey；probe 实测同用登录凭据打登录网关（凭据绝不发往第三方端点）。
 *
 * 安全：模型/凭据 DTO 全部走白名单字段，CLI 的 options/headers 与 auth.json 的 key 不落响应。
 *
 * 制作人：老实人留一手（抖音 / B站同名）
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

const CLI_TIMEOUT_MS = 20000;
const MODEL_CACHE_TTL_MS = 60000;
const JSONC_SCHEMA = "https://mimo.xiaomi.com/mimocode/config.json";
const BUILTIN_GROUPS = ["ultra", "standard", "lite"];

/** 用户输入/本地校验类错误 → 接口回 400；其余（CLI/IO）按 500 处理 */
export class UsageError extends Error {}

// ---------------------------------------------------------------------------
// 路径解析（MIMOCODE_HOME → <home>/{config,state,data}；否则 XDG）
// ---------------------------------------------------------------------------

function baseDirs() {
  const home = process.env.MIMOCODE_HOME;
  const absHome = home && path.isAbsolute(home) ? home : null;
  return {
    config: absHome
      ? path.join(absHome, "config")
      : process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"),
    state: absHome
      ? path.join(absHome, "state")
      : process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state"),
    data: absHome
      ? path.join(absHome, "data")
      : process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"),
  };
}

/** 配置文件清单，按「优先级由低到高」排列（靠后的覆盖靠前的） */
export function configCandidates() {
  const b = baseDirs();
  const files = [];
  const add = (scope, dir, name) => files.push({ scope, path: path.join(dir, name) });

  add("global", path.join(b.config, "mimocode"), "config.json");
  add("global", path.join(b.config, "mimocode"), "mimocode.json");
  add("global", path.join(b.config, "mimocode"), "mimocode.jsonc");
  if (process.env.MIMOCODE_CONFIG_DIR) {
    add("global", process.env.MIMOCODE_CONFIG_DIR, "config.json");
    add("global", process.env.MIMOCODE_CONFIG_DIR, "mimocode.json");
    add("global", process.env.MIMOCODE_CONFIG_DIR, "mimocode.jsonc");
  }
  add("project", path.join(REPO_ROOT, ".mimocode"), "mimocode.json");
  add("project", path.join(REPO_ROOT, ".mimocode"), "mimocode.jsonc");
  return files.map((f, i) => ({ ...f, precedence: i, exists: fs.existsSync(f.path) }));
}

export function stateModelPath() {
  return path.join(baseDirs().state, "mimocode", "model.json");
}

export function authJsonPath() {
  return path.join(baseDirs().data, "mimocode", "auth.json");
}

// ---------------------------------------------------------------------------
// JSONC：读取用的注释剥离（仅喂 JSON.parse）+ 写入用的顶层键定点替换
// ---------------------------------------------------------------------------

/** 去掉 // 、/* *\/ 注释与尾逗号（字符串内的内容原样保留），产出可 JSON.parse 的文本 */
function stripJsonc(text) {
  let out = "";
  let i = 0;
  let inStr = false;
  let esc = false;

  const skipComment = () => {
    if (text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      return true;
    }
    if (text[i + 1] === "*") {
      i += 2;
      while (i + 1 < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i += 2;
      return true;
    }
    return false;
  };

  /** 逗号之后跳过空白与注释，看下一个有效字符 */
  const afterComma = () => {
    let j = i + 1;
    for (;;) {
      while (j < text.length && /\s/.test(text[j])) j++;
      if (text[j] === "/" && (text[j + 1] === "/" || text[j + 1] === "*")) {
        if (text[j + 1] === "/") {
          while (j < text.length && text[j] !== "\n") j++;
        } else {
          j += 2;
          while (j + 1 < text.length && !(text[j] === "*" && text[j + 1] === "/")) j++;
          j += 2;
        }
        continue;
      }
      return text[j];
    }
  };

  while (i < text.length) {
    const c = text[i];
    if (inStr) {
      out += c;
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      i++;
      continue;
    }
    if (c === '"') {
      inStr = true;
      out += c;
      i++;
      continue;
    }
    if (c === "/" && skipComment()) continue;
    if (c === ",") {
      const next = afterComma();
      if (next === "}" || next === "]") {
        i++; // 尾逗号：只丢掉逗号本身
        continue;
      }
      out += c;
      i++;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

function skipWsComments(s, i) {
  for (;;) {
    while (i < s.length && /\s/.test(s[i])) i++;
    if (s[i] === "/" && s[i + 1] === "/") {
      while (i < s.length && s[i] !== "\n") i++;
      continue;
    }
    if (s[i] === "/" && s[i + 1] === "*") {
      i += 2;
      while (i + 1 < s.length && !(s[i] === "*" && s[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    return i;
  }
}

function scanString(s, i) {
  // i 指向起始的 '"'
  i++;
  while (i < s.length) {
    if (s[i] === "\\") {
      i += 2;
      continue;
    }
    if (s[i] === '"') return i + 1;
    i++;
  }
  throw new Error("字符串未闭合");
}

function scanValueEnd(s, i) {
  const c = s[i];
  if (c === '"') return scanString(s, i);
  if (c === "{" || c === "[") {
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let j = i; j < s.length; j++) {
      const ch = s[j];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === "\\") esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') {
        inStr = true;
        continue;
      }
      if (ch === "/" && (s[j + 1] === "/" || s[j + 1] === "*")) {
        if (s[j + 1] === "/") {
          while (j < s.length && s[j] !== "\n") j++;
        } else {
          j += 2;
          while (j + 1 < s.length && !(s[j] === "*" && s[j + 1] === "/")) j++;
          j++;
        }
        continue;
      }
      if (ch === "{" || ch === "[") depth++;
      else if (ch === "}" || ch === "]") {
        depth--;
        if (depth === 0) return j + 1;
      }
    }
    throw new Error("对象/数组未闭合");
  }
  let j = i;
  while (j < s.length && !",}]".includes(s[j]) && !/\s/.test(s[j])) j++;
  if (j === i) throw new Error("值为空");
  return j;
}

/** 在配置顶层找一个键（跳过注释、尊重字符串），命中返回位置，未命中 found:false */
function findTopLevelKey(raw, wanted) {
  const i0 = raw.indexOf("{");
  if (i0 < 0) throw new Error("配置文件不是 JSON 对象");
  let i = skipWsComments(raw, i0 + 1);
  while (i < raw.length && raw[i] !== "}") {
    if (raw[i] !== '"') throw new Error("配置文件结构异常（期望键名）");
    const keyEnd = scanString(raw, i);
    const key = JSON.parse(raw.slice(i, keyEnd));
    const p = skipWsComments(raw, keyEnd);
    if (raw[p] !== ":") throw new Error("配置文件结构异常（缺少冒号）");
    const valStart = skipWsComments(raw, p + 1);
    const valEnd = scanValueEnd(raw, valStart);
    if (key === wanted) return { found: true, i0, keyStart: i, valStart, valEnd };
    i = skipWsComments(raw, valEnd);
    if (raw[i] === ",") i = skipWsComments(raw, i + 1);
  }
  return { found: false, i0 };
}

/** 顶层没有该键时插到 { 之后（空对象不带尾逗号）；返回新文本 */
function insertTopLevel(raw, i0, key, jsonText) {
  const empty = raw[skipWsComments(raw, i0 + 1)] === "}";
  return raw.slice(0, i0 + 1) + `\n  ${JSON.stringify(key)}: ${jsonText}${empty ? "" : ","}` + raw.slice(i0 + 1);
}

/** 定点替换顶层键的值（JSONC 注释、其余键、格式原样保留）。返回新文本。 */
export function setTopLevelValue(raw, key, jsonText) {
  const hit = findTopLevelKey(raw, key);
  if (hit.found) return raw.slice(0, hit.valStart) + jsonText + raw.slice(hit.valEnd);
  return insertTopLevel(raw, hit.i0, key, jsonText);
}

/** 删除顶层键（连同它那一侧的逗号与它独占的那行）；键不存在时原样返回 */
export function removeTopLevelKey(raw, key) {
  const hit = findTopLevelKey(raw, key);
  if (!hit.found) return raw;
  let end = hit.valEnd;
  const after = skipWsComments(raw, end);
  if (raw[after] === ",") end = after + 1;
  let start = hit.keyStart;
  let j = start - 1;
  while (j > hit.i0 && /\s/.test(raw[j])) j--;
  if (raw[j] === ",") start = j; // 本键在末尾（无后随逗号）→ 吃掉前一个逗号
  // 本键独占一行时连行首缩进 + 换行一起删，避免留下空行
  let k = start - 1;
  while (k > hit.i0 && (raw[k] === " " || raw[k] === "\t")) k--;
  if (raw[k] === "\n") start = k;
  return raw.slice(0, start) + raw.slice(end);
}

/**
 * 定点替换配置里的顶层 `model`（JSONC 注释、其余键、格式原样保留）。
 * 没有该键时插到根对象开头。返回新文本。
 */
export function setTopLevelModel(raw, value) {
  return setTopLevelValue(raw, "model", JSON.stringify(String(value)));
}

// ---------------------------------------------------------------------------
// 读配置：按优先级逐层解析 + 合并（对象键深一层合并，其余后者胜出）
// ---------------------------------------------------------------------------

function isPlainObj(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

export function readMergedConfig() {
  const files = configCandidates();
  const effective = {};
  let modelSource = null;
  const parsedFiles = [];

  for (const f of files) {
    if (!f.exists) {
      parsedFiles.push({ ...fileInfo(f), parsed: false });
      continue;
    }
    let obj = null;
    let error = null;
    try {
      obj = JSON.parse(stripJsonc(fs.readFileSync(f.path, "utf8")));
      if (!isPlainObj(obj)) throw new Error("根节点不是对象");
    } catch (e) {
      error = e.message;
    }
    parsedFiles.push({ ...fileInfo(f), parsed: !error, error: error || undefined, model: obj?.model });
    if (!obj) continue;
    for (const [k, v] of Object.entries(obj)) {
      effective[k] = isPlainObj(v) && isPlainObj(effective[k]) ? { ...effective[k], ...v } : v;
      if (k === "model") modelSource = f.path;
    }
  }

  return { effective, modelSource, files: parsedFiles };
}

function fileInfo(f) {
  const st = f.exists ? fs.statSync(f.path) : null;
  return {
    path: f.path,
    scope: f.scope,
    precedence: f.precedence,
    exists: f.exists,
    size: st ? st.size : null,
    updatedAt: st ? new Date(st.mtimeMs).toISOString() : null,
  };
}

// ---------------------------------------------------------------------------
// 运行态 model.json（recent / favorite / variant）与凭据（只读、密钥不外发）
// ---------------------------------------------------------------------------

export function readModelState() {
  const p = stateModelPath();
  if (!fs.existsSync(p)) return { path: p, exists: false, recent: [], favorite: [], variant: {} };
  const raw = fs.readFileSync(p, "utf8");
  let obj;
  try {
    obj = JSON.parse(raw);
  } catch (e) {
    return { path: p, exists: true, error: `model.json 解析失败：${e.message}`, recent: [], favorite: [], variant: {} };
  }
  const key = (m) => `${m?.providerID ?? ""}/${m?.modelID ?? ""}`;
  return {
    path: p,
    exists: true,
    recent: (obj.recent || []).filter(isPlainObj).map(key),
    favorite: (obj.favorite || []).filter(isPlainObj).map(key),
    variant: isPlainObj(obj.variant) ? obj.variant : {},
  };
}

/** 把目标模型插到 recent 首位（去重、保留其它字段、上限 10）。文件损坏时抛错，不静默覆盖。 */
export function pushRecentModel(providerID, modelID) {
  const p = stateModelPath();
  const entry = { providerID, modelID };
  let obj = {};
  if (fs.existsSync(p)) {
    obj = JSON.parse(fs.readFileSync(p, "utf8")); // 解析失败直接抛 → 上层回 500，不覆盖
    if (!isPlainObj(obj)) throw new Error("model.json 根节点不是对象");
  }
  const prev = Array.isArray(obj.recent) ? obj.recent : [];
  const rest = prev.filter((m) => !(m?.providerID === providerID && m?.modelID === modelID));
  obj.recent = [entry, ...rest].slice(0, 10);
  if (!Array.isArray(obj.favorite)) obj.favorite = [];
  if (!isPlainObj(obj.variant)) obj.variant = {};
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + "\n");
  return obj.recent.map((m) => `${m.providerID}/${m.modelID}`);
}

/** 凭据清单：只暴露「哪家有密钥 + 网关地址」，key 永不出模块 */
export function readCredentials() {
  const p = authJsonPath();
  if (!fs.existsSync(p)) return [];
  try {
    const obj = JSON.parse(fs.readFileSync(p, "utf8"));
    if (!isPlainObj(obj)) return [];
    return Object.entries(obj).map(([provider, v]) => ({
      provider,
      type: v?.type ?? null,
      hasKey: Boolean(v?.key),
      baseUrl: v?.metadata?.base_url ?? null,
    }));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// 模型目录：`mimo models --verbose`（白名单字段，剥掉 options/headers）
// ---------------------------------------------------------------------------

let modelCache = { at: 0, models: null, error: null };
let inflight = null;

function mimoBin() {
  if (process.env.MIMO_BIN) return process.env.MIMO_BIN;
  for (const c of [
    path.join(os.homedir(), "nodejs", "bin", "mimo"),
    "/home/droid/nodejs/bin/mimo",
    "/usr/local/bin/mimo",
  ]) {
    if (fs.existsSync(c)) return c;
  }
  return "mimo";
}

function runMimo(args) {
  return new Promise((resolve, reject) => {
    execFile(
      mimoBin(),
      args,
      { cwd: REPO_ROOT, timeout: CLI_TIMEOUT_MS, encoding: "utf-8", maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) reject(new Error(String(stderr || err.message || err).trim().slice(0, 300)));
        else resolve(String(stdout || ""));
      }
    );
  });
}

/** 解析 `--verbose` 输出：一行摘要 + 一个 JSON 块/模型 */
function parseVerboseBlocks(out) {
  const blocks = [];
  let buf = null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (const line of out.split("\n")) {
    if (buf === null) {
      if (line.trim() !== "{") continue;
      buf = line + "\n";
      depth = 1;
      inStr = false;
      esc = false;
      continue;
    }
    buf += line + "\n";
    for (const ch of line) {
      if (esc) {
        esc = false;
        continue;
      }
      if (inStr && ch === "\\") {
        esc = true;
        continue;
      }
      if (ch === '"') {
        inStr = !inStr;
        continue;
      }
      if (inStr) continue;
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
    }
    if (depth === 0) {
      try {
        blocks.push(JSON.parse(buf));
      } catch {
        /* 块解析失败则跳过该模型 */
      }
      buf = null;
    }
  }
  return blocks;
}

function toModelDto(m) {
  const providerID = m.providerID || "";
  const modelID = m.id || "";
  return {
    key: `${providerID}/${modelID}`,
    providerID,
    modelID,
    name: m.name || modelID,
    family: m.family || "",
    status: m.status || "",
    api: { id: m.api?.id ?? null, npm: m.api?.npm ?? null, url: m.api?.url ?? null },
    context: m.limit?.context ?? null,
    output: m.limit?.output ?? null,
    cost: isPlainObj(m.cost)
      ? { input: m.cost.input ?? null, output: m.cost.output ?? null, cache: m.cost.cache ?? null }
      : null,
    capabilities: isPlainObj(m.capabilities) ? m.capabilities : null,
    variants: isPlainObj(m.variants) ? Object.keys(m.variants) : [],
    releaseDate: m.release_date || null,
  };
}

/** 模型目录（带 60s 缓存与并发去重）；CLI 失败不抛，返回 error 供接口降级 */
export async function listModels({ refresh = false } = {}) {
  const now = Date.now();
  if (!refresh && modelCache.models && now - modelCache.at < MODEL_CACHE_TTL_MS) {
    return { models: modelCache.models, error: modelCache.error, cached: true };
  }
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const out = await runMimo(["models", "--verbose"]);
      const models = parseVerboseBlocks(out).map(toModelDto).sort((a, b) => a.key.localeCompare(b.key));
      modelCache = { at: Date.now(), models, error: null };
      return { models, error: null, cached: false };
    } catch (e) {
      modelCache = { at: Date.now(), models: modelCache.models, error: e.message };
      return { models: modelCache.models || [], error: e.message, cached: false };
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/** 切换前的权威校验：`mimo models <provider>` 输出里必须出现该 provider/model */
export async function verifyModelRegistered(providerID, modelID) {
  const out = await runMimo(["models", providerID]);
  const target = `${providerID}/${modelID}`;
  return out.split("\n").some((line) => line.trim() === target || line.trim().startsWith(`${target} `));
}

// ---------------------------------------------------------------------------
// 模型能力手动标定（任务 95）：新增大模型时由用户勾选 6 项能力，显式写入配置。
//   reasoning / tool_call / attachment → 模型条目同名布尔键
//   image / audio / video             → modalities.input（text 恒有，output 恒 text）
//   自动标定流水线（catalog/probe/preset/default）与能力再初始化接口已移除。
// ---------------------------------------------------------------------------

const MODALITY_ENUM = ["text", "audio", "image", "video", "pdf"];

/**
 * modalities 写前校验（$schema 实测约束）：对象、input/output 均为非空数组、
 * 值限枚举、无额外键。不合法宁可不写（只保留 name）——写错会让整份配置校验失败。
 */
export function validateModalities(m) {
  if (!isPlainObj(m)) return false;
  if (!Object.keys(m).every((k) => k === "input" || k === "output")) return false;
  for (const k of ["input", "output"]) {
    const arr = m[k];
    if (!Array.isArray(arr) || arr.length === 0) return false;
    if (!arr.every((x) => typeof x === "string" && MODALITY_ENUM.includes(x))) return false;
  }
  return true;
}

/** 6 项能力手动标定入参：全部必填布尔，任一缺失/非布尔/未知键 → UsageError(400) */
export function parseRequestedCapabilities(input) {
  const caps = input.capabilities;
  if (!isPlainObj(caps)) {
    throw new UsageError("capabilities 需为对象，必须包含 6 项布尔标定：reasoning/tool_call/attachment/image/audio/video");
  }
  const KEYS = ["reasoning", "tool_call", "attachment", "image", "audio", "video"];
  const unknown = Object.keys(caps).filter((k) => !KEYS.includes(k));
  if (unknown.length) throw new UsageError(`capabilities 含未知字段：${unknown.join("、")}`);
  for (const k of KEYS) {
    if (typeof caps[k] !== "boolean") throw new UsageError(`capabilities.${k} 需为布尔值`);
  }
  return Object.fromEntries(KEYS.map((k) => [k, caps[k]]));
}

/**
 * 6 项标定 → 模型条目写入字段：
 *   reasoning/tool_call/attachment 平铺；image/audio/video 合成 modalities（text 恒有）。
 * 结构在构造时即合法（text 兜底 + 枚举白名单），仍过 validateModalities 自检。
 */
export function capabilityEntryFields(caps) {
  const input = ["text"];
  if (caps.image) input.push("image");
  if (caps.audio) input.push("audio");
  if (caps.video) input.push("video");
  const modalities = { input, output: ["text"] };
  if (!validateModalities(modalities)) {
    throw new UsageError("modalities 构造异常（内部错误），已中止写入");
  }
  return {
    reasoning: caps.reasoning,
    tool_call: caps.tool_call,
    attachment: caps.attachment,
    modalities,
  };
}

// ---------------------------------------------------------------------------
// xiaomi 系家族（mimo/xiaomi 同源网关）：auth 登录凭据与跨 provider 目录查找
//   实测依据（taskRes/93/evidence）：运行时凭据按 providerID 精确匹配（无 mimo→xiaomi 别名）；
//   配置块 options.baseURL 压过 auth loader 的 metadata.base_url；登录 key 只认登录网关。
// ---------------------------------------------------------------------------

/** MiMo 自家家族 provider（同源网关；登录凭据挂在 xiaomi 条目下） */
const XIAOMI_FAMILY_PROVIDERS = new Set(["mimo", "xiaomi"]);

export function isXiaomiFamilyProvider(providerId) {
  return XIAOMI_FAMILY_PROVIDERS.has(String(providerId || "").trim());
}

/** URL 等值比较用归一化（去首尾空白与尾部斜杠） */
function normUrl(u) {
  return String(u || "").trim().replace(/\/+$/, "");
}

/**
 * 读取 auth.json 中 xiaomi 系登录凭据（`mimo auth login` / `/connect` 登录写入）。
 * 仅家族内生效；按 providerID 精确匹配 + mimo↔xiaomi 别名回退（别名只用于「检测登录凭据
 * 以启用 auth 连接」——运行时本身无别名，连接目标 providerID 以返回的 authProviderId 为准）。
 * 返回 { key, baseURL, authProviderId }：key 仅限服务端 probe 使用，绝不进响应/日志。
 * baseURL = metadata.base_url（登录网关；预设端点 api.xiaomimimo.com 不认该凭据，实测 401）。
 */
export function readAuthCredential(providerId) {
  if (!isXiaomiFamilyProvider(providerId)) return null;
  const p = authJsonPath();
  if (!fs.existsSync(p)) return null;
  try {
    const obj = JSON.parse(fs.readFileSync(p, "utf8"));
    if (!isPlainObj(obj)) return null;
    const id = String(providerId).trim();
    const alias = id === "mimo" ? "xiaomi" : "mimo";
    const hit = (isPlainObj(obj[id]) && obj[id]) || (isPlainObj(obj[alias]) && obj[alias]) || null;
    if (!hit || typeof hit.key !== "string" || !hit.key) return null;
    const md = isPlainObj(hit.metadata) ? hit.metadata : null;
    const baseURL =
      md && typeof md.base_url === "string" && /^https?:\/\//i.test(md.base_url) ? md.base_url : null;
    return { key: hit.key, baseURL, authProviderId: isPlainObj(obj[id]) ? id : alias };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 切换大模型
// ---------------------------------------------------------------------------

/** 优先级最高且已存在的配置文件；一个都没有 → 全局 mimocode.jsonc（官方约定的新建位置） */
export function pickWriteTarget() {
  const files = configCandidates();
  for (let i = files.length - 1; i >= 0; i--) if (files[i].exists) return files[i];
  const globalDir = path.join(baseDirs().config, "mimocode");
  return {
    scope: "global",
    path: path.join(globalDir, "mimocode.jsonc"),
    precedence: 2,
    exists: false,
  };
}

/** 分组名 → 具体 provider/model（仅展开一层；内置分组未配置时返回 null） */
function resolveRef(ref, groups) {
  if (!ref || ref.includes("/")) return ref || null;
  const g = groups?.[ref];
  const def = typeof g === "string" ? g : g?.default;
  return def && def.includes("/") ? def : null;
}

/** 当前模型描述：顶层 model（配置）优先，其次运行态 recent[0] */
export function currentModelInfo() {
  const { effective, modelSource, files } = readMergedConfig();
  const state = readModelState();
  const groups = isPlainObj(effective.model_groups) ? effective.model_groups : {};
  const cfg = typeof effective.model === "string" && effective.model.trim() ? effective.model.trim() : null;
  const isGroup = Boolean(cfg) && !cfg.includes("/");
  const resolved = cfg ? resolveRef(cfg, groups) : null;
  const active = resolved || cfg || state.recent[0] || null;

  return {
    configModel: cfg,
    isGroup,
    resolved,
    active,
    source: cfg ? "config" : state.recent.length ? "state" : "default",
    sourceFile: cfg ? modelSource : state.exists ? state.path : null,
    recent: state.recent,
    favorite: state.favorite,
    variant: state.variant,
    stateFile: state.path,
    stateError: state.error,
    groupNames: [...new Set([...BUILTIN_GROUPS, ...Object.keys(groups)])],
    modelGroups: groups,
    files,
  };
}

/** 自定义 provider 摘要（baseURL 公开，apiKey 只报有无；models 带 modalities 供识图徽标/缺口提示） */
export function summarizeProviders(effective) {
  const p = effective.provider;
  if (!isPlainObj(p)) return [];
  return Object.entries(p).map(([id, v]) => {
    const models = isPlainObj(v?.models) ? v.models : null;
    return {
      id,
      name: v?.name || id,
      npm: v?.npm || null,
      baseURL: v?.options?.baseURL ?? null,
      hasApiKey: Boolean(v?.options?.apiKey),
      modelCount: models ? Object.keys(models).length : 0,
      onlyConfiguredModels: Boolean(v?.only_configured_models),
      models: models
        ? Object.entries(models).map(([modelId, mv]) => ({
            modelId,
            name: (isPlainObj(mv) && mv.name) || modelId,
            modalities: isPlainObj(mv) && validateModalities(mv.modalities) ? mv.modalities : null,
          }))
        : [],
    };
  });
}

/**
 * 切换到 `provider/model` 或模型分组名。
 * 返回 { model, configFile, scope, changed, recent, note }；校验不过抛 UsageError（message 直接回给前端）。
 */
export async function switchModel(modelStr) {
  const value = String(modelStr || "").trim();
  if (!value) throw new UsageError("model 不能为空");
  if (/[\s]/.test(value)) throw new UsageError("model 不能包含空白字符");

  const hasSlash = value.includes("/");
  let groupNames = [];
  const { effective, modelSource } = readMergedConfig();
  if (isPlainObj(effective.model_groups)) groupNames = Object.keys(effective.model_groups);

  let providerID = null;
  let modelID = null;
  if (hasSlash) {
    const idx = value.indexOf("/");
    providerID = value.slice(0, idx);
    modelID = value.slice(idx + 1);
    if (!providerID || !modelID) throw new UsageError("model 需形如 provider/model");
    const ok = await verifyModelRegistered(providerID, modelID).catch((e) => {
      throw new UsageError(`校验模型失败：${e.message}`);
    });
    if (!ok) throw new UsageError(`模型 ${value} 未在 MiMoCode 中注册`);
  } else {
    const known = new Set([...BUILTIN_GROUPS, ...groupNames]);
    if (!known.has(value)) {
      throw new UsageError(`未识别的模型分组 ${value}（可用：${[...known].join("、") || "无"}）`);
    }
  }

  const target = pickWriteTarget();
  const raw = target.exists ? fs.readFileSync(target.path, "utf8") : `{\n  "$schema": "${JSONC_SCHEMA}"\n}\n`;
  const next = setTopLevelModel(raw, value);
  if (next !== raw) {
    fs.mkdirSync(path.dirname(target.path), { recursive: true });
    fs.writeFileSync(target.path, next);
  }

  let recent = readModelState().recent;
  if (providerID) {
    try {
      recent = pushRecentModel(providerID, modelID);
    } catch (e) {
      // 配置已写成功，运行态更新失败不该让整个切换判失败
      console.warn("[MiMoCodeConfig] 更新 model.json recent 失败:", e.message);
    }
  }

  return {
    model: value,
    configFile: target.path,
    configScope: target.scope,
    created: !target.exists,
    changed: modelSource !== target.path || effective.model !== value,
    previousModel: effective.model ?? null,
    recent,
    note: "新配置对新会话生效；已运行的 MiMoCode TUI 需重新选择模型或重启后生效",
  };
}

// ---------------------------------------------------------------------------
// 新增 / 删除自定义 provider（主流大模型厂商预设）
// ---------------------------------------------------------------------------

/** MiMoCode 随包提供的适配器白名单 —— 只允许这两个，杜绝任意 npm 名写进配置 */
export const ADAPTERS = {
  "@ai-sdk/openai-compatible": { id: "openai-compatible", label: "OpenAI 兼容（Chat Completions）" },
  "@ai-sdk/anthropic": { id: "anthropic", label: "Anthropic Messages" },
};

/**
 * 主流大模型厂商预设：baseURL / modelId 为公开的常规取值，全部可在前端改；
 * modelId 是**可编辑示例**（不承诺仍然有效），apiKey 支持 {env:VAR} 环境变量引用。
 */
export const PROVIDER_PRESETS = [
  // MiMo：MiMoCode 自家平台（mimo/xiaomi 目录同源网关）；providerId 与内置目录同名时
  // addProvider 会省略 only_configured_models，避免把目录里既有的 mimo-auto 等模型顶掉
  { id: "mimo", label: "MiMo", vendor: "小米 MiMo（MiMoCode）", providerId: "mimo", npm: "@ai-sdk/openai-compatible",
    baseURL: "https://api.xiaomimimo.com/v1", modelId: "mimo-v2.5", modelName: "MiMo V2.5" },
  { id: "claude", label: "Claude", vendor: "Anthropic", providerId: "claude", npm: "@ai-sdk/anthropic",
    baseURL: "https://api.anthropic.com/v1", modelId: "claude-sonnet-4-5", modelName: "Claude Sonnet 4.5" },
  { id: "openai", label: "OpenAI", vendor: "OpenAI", providerId: "openai", npm: "@ai-sdk/openai-compatible",
    baseURL: "https://api.openai.com/v1", modelId: "gpt-4o", modelName: "GPT-4o" },
  { id: "deepseek", label: "DeepSeek", vendor: "深度求索", providerId: "deepseek", npm: "@ai-sdk/openai-compatible",
    baseURL: "https://api.deepseek.com/v1", modelId: "deepseek-chat", modelName: "DeepSeek Chat" },
  { id: "qwen", label: "通义千问", vendor: "阿里云百炼", providerId: "qwen", npm: "@ai-sdk/openai-compatible",
    baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1", modelId: "qwen-plus", modelName: "Qwen Plus" },
  { id: "glm", label: "智谱 GLM", vendor: "智谱 AI", providerId: "glm", npm: "@ai-sdk/openai-compatible",
    baseURL: "https://open.bigmodel.cn/api/paas/v4", modelId: "glm-4-plus", modelName: "GLM-4-Plus" },
  { id: "kimi", label: "Kimi", vendor: "月之暗面", providerId: "kimi", npm: "@ai-sdk/openai-compatible",
    baseURL: "https://api.moonshot.cn/v1", modelId: "moonshot-v1-8k", modelName: "Moonshot v1 8K" },
  { id: "xai", label: "Grok", vendor: "xAI", providerId: "xai", npm: "@ai-sdk/openai-compatible",
    baseURL: "https://api.x.ai/v1", modelId: "grok-3", modelName: "Grok-3" },
  { id: "gemini", label: "Gemini", vendor: "Google", providerId: "gemini", npm: "@ai-sdk/openai-compatible",
    baseURL: "https://generativelanguage.googleapis.com/v1beta/openai", modelId: "gemini-2.5-flash", modelName: "Gemini 2.5 Flash" },
  { id: "openrouter", label: "OpenRouter", vendor: "聚合网关", providerId: "openrouter", npm: "@ai-sdk/openai-compatible",
    baseURL: "https://openrouter.ai/api/v1", modelId: "openai/gpt-4o", modelName: "OpenAI GPT-4o (OR)" },
  { id: "custom", label: "自定义", vendor: "任意 OpenAI 兼容端点", providerId: "custom", npm: "@ai-sdk/openai-compatible",
    baseURL: "", modelId: "", modelName: "" },
];

const PROVIDER_ID_RE = /^[a-z][a-z0-9-]{1,31}$/;
const DEFAULT_CONFIG_RAW = `{\n  "$schema": "${JSONC_SCHEMA}"\n}\n`;

function readTargetConfig() {
  const target = pickWriteTarget();
  const raw = target.exists ? fs.readFileSync(target.path, "utf8") : DEFAULT_CONFIG_RAW;
  let own;
  try {
    own = JSON.parse(stripJsonc(raw));
    if (!isPlainObj(own)) throw new Error("根节点不是对象");
  } catch (e) {
    throw new UsageError(`配置文件解析失败（${target.path}）：${e.message}`);
  }
  return { target, raw, own };
}

function writeTarget(target, content) {
  fs.mkdirSync(path.dirname(target.path), { recursive: true });
  fs.writeFileSync(target.path, content);
}

/** 目录缓存失效：新增/删除 provider 后下次 GET /llm 重新拉 CLI */
export function invalidateModelCache() {
  modelCache = { at: 0, models: null, error: null };
}

/**
 * 新增自定义 provider + 一个模型（主流厂商预设或自定义端点）。
 * 返回 { providerId, model, configFile, verified, recent, note }；入参不合法抛 UsageError。
 */
export async function addProvider(input = {}) {
  const providerId = String(input.providerId || "").trim();
  if (!PROVIDER_ID_RE.test(providerId)) {
    throw new UsageError("providerId 需为小写字母开头，仅含小写字母/数字/中划线，长度 2~32");
  }
  const npm = String(input.npm || "@ai-sdk/openai-compatible").trim();
  if (!ADAPTERS[npm]) throw new UsageError(`npm 仅支持：${Object.keys(ADAPTERS).join(" / ")}`);
  const baseURL = String(input.baseURL || "").trim();
  if (!/^https?:\/\/[^\s]+$/i.test(baseURL)) throw new UsageError("baseURL 需为 http(s) 开头的地址");
  const modelId = String(input.modelId || "").trim();
  if (!modelId || /\s/.test(modelId)) throw new UsageError("modelId 不能为空且不能含空白字符");
  const modelName = String(input.modelName || "").trim() || modelId;
  let name = String(input.name || "").trim() || providerId;
  const apiKey = String(input.apiKey || "").trim();
  if (apiKey && /\s/.test(apiKey)) throw new UsageError("apiKey 不能含空白（可填 {env:MY_KEY} 引用环境变量）");
  const setAsCurrent = input.setAsCurrent === true;
  const caps = parseRequestedCapabilities(input); // 6 项手动标定，缺失/非法 → UsageError(400)

  const { effective } = readMergedConfig();
  const mergedProvider = isPlainObj(effective.provider) ? effective.provider : null;

  // —— xiaomi 系特殊处理：auth 方式登录连接（实测依据 taskRes/93/evidence/runtime_auth_matrix_result.txt）——
  // 运行时凭据按 providerID 精确取 auth.json（无 mimo→xiaomi 别名）；配置块 options.baseURL 压过
  // auth loader；登录 key 只认登录网关。故家族内未填 apiKey、已有登录凭据（含网关）、端点仍是
  // 预设值、家族内无已配 key 时：providerID 归一为凭据条目（mimo→xiaomi）、端点改写登录网关、
  // 不写 apiKey —— 连接即走 auth 登录凭据（「通过 auth 方式登录链接」）。
  const family = isXiaomiFamilyProvider(providerId);
  const authCred = family ? readAuthCredential(providerId) : null;
  const presetBaseURL = PROVIDER_PRESETS.find((p) => p.id === "mimo")?.baseURL || "";
  const sameAsPreset = Boolean(presetBaseURL) && normUrl(baseURL) === normUrl(presetBaseURL);
  const wantAuth = Boolean(family && !apiKey && authCred?.baseURL && sameAsPreset);
  // 目标块判定：auth 模式下先定候选 ID（mimo→xiaomi），只查**该块**是否已配手工 key——
  // 家族另一 ID 的 key 不影响本块走 auth（家族级门控会误挡「mimo 已配 key、再加 xiaomi 走 auth」）。
  const candidateId =
    wantAuth && authCred.authProviderId !== providerId ? authCred.authProviderId : providerId;
  const hasExistingKey = Boolean(mergedProvider?.[candidateId]?.options?.apiKey);
  const viaAuth = wantAuth && !hasExistingKey;
  const effectiveProviderId = viaAuth ? candidateId : providerId;
  const effectiveBaseURL = viaAuth ? authCred.baseURL : baseURL;
  if (viaAuth && name === providerId) name = effectiveProviderId; // 显式未传 name 时归一，避免 xiaomi 块显示 mimo

  const conflict = mergedProvider?.[effectiveProviderId];
  const conflictUrls = new Set([normUrl(baseURL), normUrl(effectiveBaseURL)]);
  if (
    conflict &&
    (conflict?.npm !== npm || !conflictUrls.has(normUrl(conflict?.options?.baseURL)))
  ) {
    throw new UsageError(
      `providerId「${effectiveProviderId}」已存在且配置不同（baseURL/适配器不一致），请改用其他 ID，如 ${effectiveProviderId}-2`,
    );
  }

  const { target, raw, own } = readTargetConfig();
  const ownProvider = isPlainObj(own.provider) ? own.provider : {};
  const existing = isPlainObj(ownProvider[effectiveProviderId]) ? ownProvider[effectiveProviderId] : null;

  // providerId 命中**内置目录**时：
  //  ① 不写 only_configured_models（该键只要出现就会收窄目录模型，官方示例只用于全新端点）；
  //  ② 实测 `mimo` 这类 provider 一旦出现配置块，其目录模型会被整体顶掉（mimo/mimo-auto 消失），
  //     所以把目录里该 provider 的既有模型**一并写进 models** 保全（xiaomi 系同理，写入无副作用）；
  //  ③ 目录模型自带 endpoint 且不受 options.baseURL 影响，但保全后的模型会共用新 baseURL → 给出提示。
  const catalog = await listModels();
  const catalogModels = (catalog.models || []).filter((m) => m.providerID === effectiveProviderId);
  const inCatalog = catalogModels.length > 0;

  const block = { ...(existing || {}), name, npm };
  if (inCatalog) delete block.only_configured_models;
  else block.only_configured_models = true;
  block.options = { ...(isPlainObj(existing?.options) ? existing.options : {}), baseURL: effectiveBaseURL };
  if (apiKey) block.options.apiKey = apiKey;

  // —— 能力手动标定（任务 95）：用户勾选的 6 项直接落盘，无自动探测/目录推断。
  // 保全的目录模型仅 name-only 合并（不覆盖已有条目字段、不代写能力——能力以用户标定为准）。
  const existingModels = isPlainObj(existing?.models) ? existing.models : {};
  const entryFields = capabilityEntryFields(caps);
  block.models = {
    ...existingModels,
    ...Object.fromEntries(
      catalogModels.map((m) => [m.modelID, { ...existingModels[m.modelID], name: m.name }]),
    ),
    [modelId]: { ...existingModels[modelId], name: modelName, ...entryFields },
  };

  const preserved = catalogModels.filter((m) => m.modelID !== modelId).map((m) => m.key);
  const endpointConflicts = catalogModels
    .filter((m) => m.api?.url && m.api.url !== effectiveBaseURL)
    .map((m) => ({ model: m.key, catalogUrl: m.api.url }));

  let next = setTopLevelValue(raw, "provider", JSON.stringify({ ...ownProvider, [effectiveProviderId]: block }));

  // 允许名单/拒绝名单与新 provider 保持一致（数组整键替换 → 以合并后取值为基础，不丢其它条目）
  if (Array.isArray(effective.enabled_providers) && !effective.enabled_providers.includes(effectiveProviderId)) {
    const merged = [
      ...new Set([...(own.enabled_providers ?? effective.enabled_providers), effectiveProviderId]),
    ];
    next = setTopLevelValue(next, "enabled_providers", JSON.stringify(merged));
  }
  if (Array.isArray(effective.disabled_providers) && effective.disabled_providers.includes(effectiveProviderId)) {
    const kept = (own.disabled_providers ?? effective.disabled_providers).filter(
      (x) => x !== effectiveProviderId,
    );
    next = kept.length
      ? setTopLevelValue(next, "disabled_providers", JSON.stringify(kept))
      : removeTopLevelKey(next, "disabled_providers");
  }

  writeTarget(target, next);
  invalidateModelCache();

  // 官方口径：先 mimo models <provider> 确认注册成功，再把它设为当前模型
  let verified = false;
  let verifyError = null;
  try {
    verified = await verifyModelRegistered(effectiveProviderId, modelId);
  } catch (e) {
    verifyError = e.message;
  }

  const applied = setAsCurrent && verified;
  let recent = readModelState().recent;
  if (applied) {
    const target2 = readTargetConfig();
    writeTarget(target2.target, setTopLevelModel(target2.raw, `${effectiveProviderId}/${modelId}`));
    try {
      recent = pushRecentModel(effectiveProviderId, modelId);
    } catch (e) {
      console.warn("[MiMoCodeConfig] 更新 model.json recent 失败:", e.message);
    }
  }

  const conflictWarn = endpointConflicts.length
    ? `；注意：目录原模型 ${endpointConflicts.map((c) => c.model).join("、")} 原端点 ${endpointConflicts[0].catalogUrl} 与新 baseURL 不同，将随该 provider 共用新端点`
    : "";
  const checkedTags = [
    caps.reasoning && "推理",
    caps.tool_call && "工具调用",
    caps.attachment && "附件",
    caps.image && "图像输入",
    caps.audio && "音频输入",
    caps.video && "视频输入",
  ].filter(Boolean);
  const capNote = `；能力已手动标定（${checkedTags.join("·") || "无勾选，仅文本"}）`;
  const blockHasKey = Boolean(block.options?.apiKey);
  const authNote = viaAuth
    ? `；未填 API Key，已按 MiMo 登录凭据走 auth 连接（端点切换为登录网关 ${effectiveBaseURL}${
        effectiveProviderId !== providerId
          ? `，Provider ID 归一为 ${effectiveProviderId}——运行时按 providerID 读取 auth.json 凭据`
          : ""
      }）`
    : family && !blockHasKey && sameAsPreset
      ? `；注意：未填 API Key 且未走 auth 连接（${
          authCred?.baseURL
            ? "目标 provider 已有手工 API Key 配置，auth 连接未启用"
            : "未检测到 MiMo 登录凭据（或凭据缺登录网关），可先执行 mimo auth login 或填写 API Key"
        }），连接可能失败`
      : "";
  const baseNote = (verified
    ? inCatalog
      ? `已写入配置；内置目录原模型 ${preserved.join("、") || "无"} 已一并并入，未被顶掉${conflictWarn}。新会话生效`
      : "已写入配置；新会话生效，已运行的 MiMoCode TUI 需重新选择或重启"
    : `已写入 provider，但 CLI 校验未通过${verifyError ? `：${verifyError}` : ""}，请检查 baseURL / 模型 ID 后刷新目录`) + capNote + authNote;

  return {
    providerId: effectiveProviderId,
    ...(effectiveProviderId !== providerId ? { requestedProviderId: providerId } : {}),
    viaAuth: viaAuth
      ? {
          used: true,
          providerId: effectiveProviderId,
          baseURL: effectiveBaseURL,
          normalizedFrom: effectiveProviderId !== providerId ? providerId : null,
        }
      : { used: false },
    model: applied ? `${effectiveProviderId}/${modelId}` : null,
    modelId,
    configFile: target.path,
    configScope: target.scope,
    created: !existing,
    providerInCatalog: inCatalog, // true = 命中内置目录（其既有模型已并入配置保留）
    preservedCatalogModels: preserved,
    endpointConflicts,
    setAsCurrent,
    verified,
    verifyError,
    recent,
    capabilities: { ...caps, modalities: entryFields.modalities }, // 6 项手动标定回显
    note: baseNote,
  };
}


/** 删除自定义 provider：连带清理指向它的顶层 model 与运行态 recent/variant */
export async function removeProvider(input = {}) {
  const providerId = String(input.providerId || "").trim();
  if (!PROVIDER_ID_RE.test(providerId)) throw new UsageError("providerId 格式不正确");

  const { effective, modelSource } = readMergedConfig();
  const mergedProvider = isPlainObj(effective.provider) ? effective.provider : null;
  if (!mergedProvider || !isPlainObj(mergedProvider[providerId])) {
    throw new UsageError(`未找到已配置的 provider：${providerId}`);
  }

  const { target, raw, own } = readTargetConfig();
  const ownProvider = isPlainObj(own.provider) ? own.provider : {};
  const rest = { ...ownProvider };
  delete rest[providerId];

  let next = Object.keys(rest).length
    ? setTopLevelValue(raw, "provider", JSON.stringify(rest))
    : removeTopLevelKey(raw, "provider");

  let modelRemoved = null;
  const cur = typeof effective.model === "string" ? effective.model : null;
  if (cur && cur.startsWith(`${providerId}/`)) {
    modelRemoved = cur;
    if (modelSource === target.path) next = removeTopLevelKey(next, "model");
    else if (modelSource) {
      const r = fs.readFileSync(modelSource, "utf8");
      fs.writeFileSync(modelSource, removeTopLevelKey(r, "model"));
    }
  }

  writeTarget(target, next);
  invalidateModelCache();
  const recent = removeRecentForProvider(providerId);

  return {
    providerId,
    configFile: target.path,
    modelRemoved,
    recent,
    note: "provider 已从配置移除；若仍设置为当前模型则该 model 键一并删除",
  };
}

/** 运行态 recent/variant 中剔除某个 provider（provider 被删后避免残留指向） */
function removeRecentForProvider(providerID) {
  const p = stateModelPath();
  if (!fs.existsSync(p)) return readModelState().recent;
  const obj = JSON.parse(fs.readFileSync(p, "utf8")); // 损坏则抛 → 上层 500，不静默覆盖
  if (!isPlainObj(obj)) return [];
  obj.recent = (Array.isArray(obj.recent) ? obj.recent : []).filter((m) => m?.providerID !== providerID);
  if (isPlainObj(obj.variant)) {
    for (const k of Object.keys(obj.variant)) if (k.startsWith(`${providerID}/`)) delete obj.variant[k];
  }
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + "\n");
  return obj.recent.map((m) => `${m.providerID}/${m.modelID}`);
}
