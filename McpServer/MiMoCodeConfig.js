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
 * 能力：添加模型/能力再初始化时按 user > existing > catalog(仅内置) > probe > preset > default
 *       流水线解析并写入 modalities（识图等）——修复「初次添加大模型不识别识图能力」。
 *
 * 安全：模型/凭据 DTO 全部走白名单字段，CLI 的 options/headers 与 auth.json 的 key 不落响应。
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
// 模型能力初始化（modalities）——修复：初次添加大模型未识别识图能力
//   流水线：user > catalog > probe > existing > preset > default
// ---------------------------------------------------------------------------

const MODALITY_ENUM = ["text", "audio", "image", "video", "pdf"];
const PROBE_TIMEOUT_MS = 8000;
const PROBE_CACHE_TTL_MS = 10 * 60 * 1000;
const probeCache = new Map();

/** 来源 → 中文（note 展示） */
const CAP_SOURCE_CN = {
  user: "用户指定",
  catalog: "模型目录",
  probe: "实测",
  existing: "沿用已有配置",
  preset: "预设名单",
  default: "默认纯文本",
};

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

/** capabilities 里的 {text:true,image:false,…} 映射 → 数组；无 true 项返回 null */
function modalityList(map) {
  if (!isPlainObj(map)) return null;
  const list = MODALITY_ENUM.filter((k) => map[k] === true);
  return list.length ? list : null;
}

/** `mimo models --verbose` 的 capabilities → modalities；形状不符返回 null（不猜） */
export function modalitiesFromCatalogCapabilities(caps) {
  if (!isPlainObj(caps)) return null;
  const m = { input: modalityList(caps.input), output: modalityList(caps.output) };
  if (!m.input || !m.output) return null;
  return validateModalities(m) ? m : null;
}

/** 识图预设正向名单——宁缺勿滥：只收确定支持图片输入的模型 */
const VISION_MODEL_RE =
  /^(gpt-4o|gpt-4\.1|gpt-5|claude-[a-z0-9.-]*?(?:sonnet|opus|haiku)|gemini-|qwen-vl|qwen\d+-vl|glm-4v|mimo-v2\.6|grok-2-vision|.*-vision)/i;

/** 请求体显式能力入参：modalities 全量 或 vision 布尔简写；非法入参抛 UsageError(400) */
function parseRequestedModalities(input) {
  if (input.modalities !== undefined && input.modalities !== null) {
    if (!validateModalities(input.modalities)) {
      throw new UsageError("modalities 需为对象，input/output 均为非空数组，取值限 text/audio/image/video/pdf");
    }
    return input.modalities;
  }
  if (input.vision !== undefined && input.vision !== null) {
    if (typeof input.vision !== "boolean") throw new UsageError("vision 需为布尔值");
    return { input: input.vision ? ["text", "image"] : ["text"], output: ["text"] };
  }
  return null;
}

/** {env:VAR} 展开；环境变量缺失返回 null（区别于「未配置 key」） */
function resolveApiKey(rawKey) {
  if (!rawKey || typeof rawKey !== "string") return null;
  const m = /^\{env:([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(rawKey.trim());
  if (m) return process.env[m[1]] || null;
  return rawKey;
}

/**
 * 1×1 PNG 最小多模态探针（仅 OpenAI 兼容端点）：
 *   2xx → 支持 image；400/422 且错误指向图片/内容类型 → 不支持；其余 → 未知(null) 降级下一档。
 * 结果缓存 10 分钟；key 只在服务端→上游，绝不进响应。
 */
async function probeVision({ baseURL, apiKey, modelId }) {
  const cacheKey = `${baseURL}|${modelId}`;
  const hit = probeCache.get(cacheKey);
  if (hit && Date.now() - hit.at < PROBE_CACHE_TTL_MS) return hit.result;

  const url = /\/chat\/completions\/?$/.test(baseURL)
    ? baseURL
    : `${baseURL.replace(/\/+$/, "")}/chat/completions`;
  const t0 = Date.now();
  const result = { vision: null, httpStatus: null, latencyMs: 0, error: null };
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: modelId,
        max_tokens: 1,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "ping" },
              {
                type: "image_url",
                image_url: {
                  url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
                },
              },
            ],
          },
        ],
      }),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    result.httpStatus = res.status;
    const bodyText = await res.text().catch(() => "");
    if (res.ok) result.vision = true;
    else if (
      (res.status === 400 || res.status === 422) &&
      /image|media|multimodal|content[-_ ]?type|invalid content/i.test(bodyText)
    ) {
      result.vision = false;
    } else {
      result.error = `HTTP ${res.status}${bodyText ? `: ${bodyText.slice(0, 160)}` : ""}`;
    }
  } catch (e) {
    result.error = String(e?.message || e).slice(0, 200);
  }
  result.latencyMs = Date.now() - t0;
  probeCache.set(cacheKey, { at: Date.now(), result });
  return result;
}

/**
 * 能力解析流水线。返回 { modalities, source, confirmed, probe }，modalities 恒为合法结构：
 *   user      —— 本次请求显式指定（vision / modalities 入参）
 *   existing  —— 配置中已有合法 modalities（配置即运行态真值，优先于目录/实测，不 churn 人工设定）
 *   catalog   —— 内置目录元数据（**仅 api.url 非空的内置模型可信**：配置自声明模型的 capabilities
 *                是配置回声，name-only 缺陷态下恒为全 false，采信会把识图缺失固化 → 让其落入后续档恢复）
 *   probe     —— 1×1 PNG 实测（仅裁决 image；audio/video/pdf 等未测模态沿用 existing/目录证据，
 *                实测不丢已有声明。OpenAI 兼容端点；配置了 key 但 {env} 缺失则跳过）
 *   preset    —— 识图模型预设名单
 *   default   —— 兜底纯文本（confirmed:false，note 提示可实测）
 * forceProbe=true（能力再初始化的 probe 模式）：跳过 user/existing/catalog 前置档强制实测，
 * 实测无定论时仍回退 existing → preset → default。
 */
async function resolveCapabilities({
  requested = null,
  catalogModel = null,
  existingEntry = null,
  npm = "",
  baseURL = "",
  apiKey = null,
  modelId,
  forceProbe = false,
}) {
  const wrap = (modalities, source, probe = null) => ({
    modalities,
    source,
    confirmed: source !== "default",
    probe,
  });

  if (requested && !forceProbe) return wrap(requested, "user");

  const existing = validateModalities(existingEntry?.modalities) ? existingEntry.modalities : null;
  const trustedCatalog = catalogModel?.api?.url
    ? modalitiesFromCatalogCapabilities(catalogModel.capabilities)
    : null;

  if (!forceProbe) {
    if (existing) return wrap(existing, "existing");
    if (trustedCatalog) return wrap(trustedCatalog, "catalog");
  }

  let probeInfo = null;
  if (npm === "@ai-sdk/openai-compatible" && /^https?:\/\//i.test(baseURL || "")) {
    // 配置了 key 却解析不出（{env} 缺失）→ 跳过探测，避免注定 401 的请求
    const resolvedKey = apiKey ? resolveApiKey(apiKey) : "";
    if (!apiKey || resolvedKey) {
      probeInfo = await probeVision({ baseURL, apiKey: resolvedKey || null, modelId });
      if (probeInfo.vision !== null) {
        // 实测只裁决 image；其余模态沿用证据基底（existing / 可信目录），避免丢 audio/video/pdf 声明
        const base = existing || trustedCatalog || { input: ["text"], output: ["text"] };
        const others = base.input.filter((x) => x !== "image");
        const input = probeInfo.vision
          ? [...new Set([...others, "image"])]
          : others.length
            ? others
            : ["text"];
        const merged = { input, output: base.output };
        return wrap(validateModalities(merged) ? merged : base, "probe", probeInfo);
      }
    } else {
      probeInfo = { vision: null, httpStatus: null, latencyMs: 0, error: "apiKey 引用的环境变量缺失，已跳过实测" };
    }
  }

  // 实测无定论（或不可探测）→ 回退既有声明，再走名单/兜底
  if (existing) return wrap(existing, "existing", probeInfo);
  if (VISION_MODEL_RE.test(modelId)) return wrap({ input: ["text", "image"], output: ["text"] }, "preset", probeInfo);
  return wrap({ input: ["text"], output: ["text"] }, "default", probeInfo);
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
  const name = String(input.name || "").trim() || providerId;
  const apiKey = String(input.apiKey || "").trim();
  if (apiKey && /\s/.test(apiKey)) throw new UsageError("apiKey 不能含空白（可填 {env:MY_KEY} 引用环境变量）");
  const setAsCurrent = input.setAsCurrent === true;
  const requested = parseRequestedModalities(input); //显式能力入参，非法 → UsageError(400)

  const { effective } = readMergedConfig();
  const mergedProvider = isPlainObj(effective.provider) ? effective.provider : null;
  const conflict = mergedProvider?.[providerId];
  if (conflict && (conflict?.options?.baseURL !== baseURL || conflict?.npm !== npm)) {
    throw new UsageError(
      `providerId「${providerId}」已存在且配置不同（baseURL/适配器不一致），请改用其他 ID，如 ${providerId}-2`,
    );
  }

  const { target, raw, own } = readTargetConfig();
  const ownProvider = isPlainObj(own.provider) ? own.provider : {};
  const existing = isPlainObj(ownProvider[providerId]) ? ownProvider[providerId] : null;

  // providerId 命中**内置目录**时：
  //  ① 不写 only_configured_models（该键只要出现就会收窄目录模型，官方示例只用于全新端点）；
  //  ② 实测 `mimo` 这类 provider 一旦出现配置块，其目录模型会被整体顶掉（mimo/mimo-auto 消失），
  //     所以把目录里该 provider 的既有模型**一并写进 models** 保全（xiaomi 系同理，写入无副作用）；
  //  ③ 目录模型自带 endpoint 且不受 options.baseURL 影响，但保全后的模型会共用新 baseURL → 给出提示。
  const catalog = await listModels();
  const catalogModels = (catalog.models || []).filter((m) => m.providerID === providerId);
  const inCatalog = catalogModels.length > 0;

  const block = { ...(existing || {}), name, npm };
  if (inCatalog) delete block.only_configured_models;
  else block.only_configured_models = true;
  block.options = { ...(isPlainObj(existing?.options) ? existing.options : {}), baseURL };
  if (apiKey) block.options.apiKey = apiKey;

  // —— 能力初始化（修复：初次添加不识别识图）——
  // 写配置前先跑完流水线，一次写入成型；新模型总是显式声明 modalities（含兜底纯文本），
  // 目录保全模型仅在自身条目缺合法 modalities 时按目录补（fill-if-missing，不覆盖人工设定）。
  const existingModels = isPlainObj(existing?.models) ? existing.models : {};
  const catalogModel = catalogModels.find((m) => m.modelID === modelId) || null;
  const caps = await resolveCapabilities({
    requested,
    catalogModel,
    existingEntry: existingModels[modelId],
    npm,
    baseURL,
    apiKey: apiKey || (isPlainObj(existing?.options) ? existing.options.apiKey : null),
    modelId,
  });
  const fillCap = (m) => {
    if (validateModalities(existingModels[m.modelID]?.modalities)) return {};
    if (!m.api?.url) return {}; // 配置自声明模型的 capabilities 是回声，不足为凭（防 name-only 缺陷态固化）
    const cap = modalitiesFromCatalogCapabilities(m.capabilities);
    return cap ? { modalities: cap } : {};
  };
  block.models = {
    ...existingModels,
    ...Object.fromEntries(
      catalogModels.map((m) => [m.modelID, { ...existingModels[m.modelID], name: m.name, ...fillCap(m) }]),
    ),
    [modelId]: { ...existingModels[modelId], name: modelName, modalities: caps.modalities },
  };

  const preserved = catalogModels.filter((m) => m.modelID !== modelId).map((m) => m.key);
  const endpointConflicts = catalogModels
    .filter((m) => m.api?.url && m.api.url !== baseURL)
    .map((m) => ({ model: m.key, catalogUrl: m.api.url }));

  let next = setTopLevelValue(raw, "provider", JSON.stringify({ ...ownProvider, [providerId]: block }));

  // 允许名单/拒绝名单与新 provider 保持一致（数组整键替换 → 以合并后取值为基础，不丢其它条目）
  if (Array.isArray(effective.enabled_providers) && !effective.enabled_providers.includes(providerId)) {
    const merged = [...new Set([...(own.enabled_providers ?? effective.enabled_providers), providerId])];
    next = setTopLevelValue(next, "enabled_providers", JSON.stringify(merged));
  }
  if (Array.isArray(effective.disabled_providers) && effective.disabled_providers.includes(providerId)) {
    const kept = (own.disabled_providers ?? effective.disabled_providers).filter((x) => x !== providerId);
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
    verified = await verifyModelRegistered(providerId, modelId);
  } catch (e) {
    verifyError = e.message;
  }

  const applied = setAsCurrent && verified;
  let recent = readModelState().recent;
  if (applied) {
    const target2 = readTargetConfig();
    writeTarget(target2.target, setTopLevelModel(target2.raw, `${providerId}/${modelId}`));
    try {
      recent = pushRecentModel(providerId, modelId);
    } catch (e) {
      console.warn("[MiMoCodeConfig] 更新 model.json recent 失败:", e.message);
    }
  }

  const conflictWarn = endpointConflicts.length
    ? `；注意：目录原模型 ${endpointConflicts.map((c) => c.model).join("、")} 原端点 ${endpointConflicts[0].catalogUrl} 与新 baseURL 不同，将随该 provider 共用新端点`
    : "";
  const capNote = `；模型能力已初始化（来源：${CAP_SOURCE_CN[caps.source]}）${
    caps.source === "default" ? "，识图能力未确认，可在模型详情调用能力再初始化实测" : ""
  }`;
  const baseNote = (verified
    ? inCatalog
      ? `已写入配置；内置目录原模型 ${preserved.join("、") || "无"} 已一并并入，未被顶掉${conflictWarn}。新会话生效`
      : "已写入配置；新会话生效，已运行的 MiMoCode TUI 需重新选择或重启"
    : `已写入 provider，但 CLI 校验未通过${verifyError ? `：${verifyError}` : ""}，请检查 baseURL / 模型 ID 后刷新目录`) + capNote;

  return {
    providerId,
    model: applied ? `${providerId}/${modelId}` : null,
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
    capabilities: caps, // { modalities, source, confirmed, probe }
    note: baseNote,
  };
}

/**
 * 能力再初始化：对**已写入配置**的 provider/model 补写/移除 modalities（存量模型补救、手动重测）。
 * mode：auto（流水线）| probe（强制实测，跳过 user/catalog）| clear（移除声明=能力级回滚）；
 * 显式传 modalities/vision 等价 user 来源（仅 auto）。读写同一配置文件，不跨文件复制 provider 块。
 * 返回 { providerId, modelId, mode, configFile, capabilities, note }；不合法入参抛 UsageError。
 */
export async function initModelCapabilities(input = {}) {
  const providerId = String(input.providerId || "").trim();
  if (!PROVIDER_ID_RE.test(providerId)) throw new UsageError("providerId 格式不正确");
  const modelId = String(input.modelId || "").trim();
  if (!modelId || /\s/.test(modelId)) throw new UsageError("modelId 不能为空且不能含空白字符");
  const mode = String(input.mode || "auto");
  if (!["auto", "probe", "clear"].includes(mode)) throw new UsageError("mode 仅支持 auto / probe / clear");
  const requested = mode === "clear" ? null : parseRequestedModalities(input);

  // 找到实际声明了该模型的配置文件（优先级高者先，与 removeProvider 的 modelSource 口径一致）
  const files = configCandidates().filter((f) => f.exists);
  let hit = null;
  for (let i = files.length - 1; i >= 0; i--) {
    let own;
    try {
      own = JSON.parse(stripJsonc(fs.readFileSync(files[i].path, "utf8")));
    } catch {
      continue;
    }
    const block = isPlainObj(own?.provider) ? own.provider[providerId] : null;
    const entry = isPlainObj(block) && isPlainObj(block.models) ? block.models[modelId] : null;
    if (isPlainObj(entry)) {
      hit = { file: files[i], raw: fs.readFileSync(files[i].path, "utf8"), own, block, entry };
      break;
    }
  }
  if (!hit) {
    throw new UsageError(`模型 ${providerId}/${modelId} 未在配置文件中声明，请先通过「新增大模型」添加`);
  }

  if (mode === "clear") {
    const { modalities: _drop, ...restEntry } = hit.entry;
    const nextProvider = {
      ...hit.own.provider,
      [providerId]: { ...hit.block, models: { ...hit.block.models, [modelId]: restEntry } },
    };
    fs.writeFileSync(hit.file.path, setTopLevelValue(hit.raw, "provider", JSON.stringify(nextProvider)));
    invalidateModelCache();
    return {
      providerId,
      modelId,
      mode,
      configFile: hit.file.path,
      capabilities: { modalities: null, source: "clear", confirmed: false, probe: null },
      note: "已移除该模型的 modalities 声明；对新会话生效",
    };
  }

  const catalog = await listModels();
  const catalogModels = (catalog.models || []).filter((m) => m.providerID === providerId);
  const caps = await resolveCapabilities({
    requested,
    catalogModel: catalogModels.find((m) => m.modelID === modelId) || null,
    existingEntry: hit.entry,
    npm: hit.block.npm,
    baseURL: isPlainObj(hit.block.options) ? hit.block.options.baseURL : null,
    apiKey: isPlainObj(hit.block.options) ? hit.block.options.apiKey : null,
    modelId,
    forceProbe: mode === "probe",
  });

  const nextProvider = {
    ...hit.own.provider,
    [providerId]: {
      ...hit.block,
      models: { ...hit.block.models, [modelId]: { ...hit.entry, modalities: caps.modalities } },
    },
  };
  fs.writeFileSync(hit.file.path, setTopLevelValue(hit.raw, "provider", JSON.stringify(nextProvider)));
  invalidateModelCache();

  return {
    providerId,
    modelId,
    mode,
    configFile: hit.file.path,
    capabilities: caps,
    note: `已写入模型能力（来源：${CAP_SOURCE_CN[caps.source]}）；对新会话生效${
      caps.source === "default" ? "，识图能力未确认" : ""
    }`,
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
