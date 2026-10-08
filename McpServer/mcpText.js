/**
 * MCP 工具文案（i18n）—— 1 个工具（ask_mimocode）的 description、4 处 zod .describe()、
 * 运行时结果文案的 zh/en 双语表，供 McpApi.js 引用。
 *
 * 语言解析（模块加载时读一次）：
 *   1) 环境变量 MCP_LOCALE 显式设置：zh | en | both（zh\nen 拼接）优先；
 *   2) 未设/非法值 → 检查当前系统语言（LC_ALL > LC_MESSAGES > LANG）：
 *      zh* → zh；策略：非中文环境统一切换为英语 → en。
 * zh 文案与 McpApi.js 原值逐字一致 —— 中文环境下输出与现状完全一致。
 * 绝不翻译：工具名（ask_mimocode 等）、error.type、AI 生成内容、协议字段（session_id 等）。
 *
 * 制作人：老实人留一手（抖音 / B站同名）
 */

// 模块级常量：只在 import 时读一次，运行期改环境变量不生效
const LOCALE = (() => {
  const v = (process.env.MCP_LOCALE || "").trim().toLowerCase();
  if (v === "zh" || v === "en" || v === "both") return v;
  // 未设/非法 → 检查系统语言：zh* → 中文，否则统一切英语（含 C/POSIX/无法识别）
  const sys = (
    process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG || ""
  )
    .trim()
    .toLowerCase();
  return sys.startsWith("zh") ? "zh" : "en";
})();

/** 按 LOCALE 取文案：zh → zh，en → en，both → `zh\nen` */
function pick(entry) {
  if (LOCALE === "en") return entry.en;
  if (LOCALE === "both") return `${entry.zh}\n${entry.en}`;
  return entry.zh;
}

/** 占位符替换：{name} → params.name（缺参保留原样） */
function fill(text, params) {
  if (!params) return text;
  return text.replace(/\{(\w+)\}/g, (m, k) => (params[k] !== undefined ? String(params[k]) : m));
}

// ---------------------------------------------------------------------------
// 工具 description（server.tool 第 2 参）
// ---------------------------------------------------------------------------
const TOOL_DESCS = {
  ask_mimocode: {
    zh: "把消息发给 MiMoCode agent 无头执行并返回其回答。支持传入 session_id 续接多轮对话",
    en: "Send a message to the MiMoCode agent for headless execution and return its answer. Pass session_id to continue a multi-turn conversation",
  },
};

// ---------------------------------------------------------------------------
// 参数描述（zod .describe()，toolParamDesc 工具名/参数名两级）
// ---------------------------------------------------------------------------
const PARAM_DESCS = {
  ask_mimocode: {
    message: {
      zh: "要发给 MiMoCode 的消息/任务",
      en: "Message/task to send to MiMoCode",
    },
    session_id: {
      zh: "续接已有会话时传入上次返回的 session_id；首次调用留空",
      en: "Pass the session_id returned last time to continue an existing session; leave empty on first call",
    },
    model: {
      zh: "可选，指定 provider/model",
      en: "Optional, specify provider/model",
    },
    cwd: {
      zh: "可选，agent 的工作目录，默认为用户主目录",
      en: "Optional, working directory of the agent, defaults to the user home directory",
    },
  },
};

// ---------------------------------------------------------------------------
// 运行时结果文案（resultText；{name} 为占位符，由调用方传参）
// ---------------------------------------------------------------------------
const RESULT_TEXTS = {
  // ask_mimocode
  "ask.workdirMissing": {
    zh: "工作目录不存在: {dir}",
    en: "Working directory does not exist: {dir}",
  },
  "ask.runFail": {
    zh: "mimo run 失败: {msg}\n{stderr}",
    en: "mimo run failed: {msg}\n{stderr}",
  },
  "ask.noOutput": {
    zh: "(无文本输出)",
    en: "(no text output)",
  },
  // session_id: 未知（整段登记；`session_id: <id>` 有值时是协议字段名，两种语言一致，留在 McpApi）
  "ask.sidUnknown": {
    zh: "session_id: 未知",
    en: "session_id: unknown",
  },
};

/** 工具 description（McpApi server.tool 第 2 参） */
export function toolDescription(name) {
  return pick(TOOL_DESCS[name]);
}

/** 工具参数描述（zod .describe() 用） */
export function toolParamDesc(name, param) {
  return pick(PARAM_DESCS[name][param]);
}

/** 运行时结果文案：key 见 RESULT_TEXTS，params 为 {name: 值} 占位符表 */
export function resultText(key, params) {
  return fill(pick(RESULT_TEXTS[key]), params);
}
