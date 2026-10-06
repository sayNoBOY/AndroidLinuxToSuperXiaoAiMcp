/**
 * MCP 工具文案（i18n）—— 4 个工具的 description、12 处 zod .describe()、
 * 运行时结果文案的 zh/en 双语表，供 McpApi.js 引用。
 *
 * 语言解析（模块加载时读一次）：
 *   1) 环境变量 MCP_LOCALE 显式设置：zh | en | both（zh\nen 拼接）优先；
 *   2) 未设/非法值 → 检查当前系统语言（LC_ALL > LC_MESSAGES > LANG）：
 *      zh* → zh；策略：非中文环境统一切换为英语 → en。
 * zh 文案与 McpApi.js 原值逐字一致 —— 中文环境下输出与现状完全一致。
 * 绝不翻译：工具名（run_command 等）、error.type、AI 生成内容、协议字段（session_id 等）。
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
  run_command: {
    zh: "在设备上执行shell命令",
    en: "Execute a shell command on the device",
  },
  get_find_file: {
    zh: "查找系统中的相关文件并发送返回：按文件名关键词或通配符（如 *.log、report*）搜索，返回匹配的文件路径，可选返回文件内容",
    en: "Find related files in the system and send them back: search by filename keyword or wildcard (e.g. *.log, report*), return matching file paths, optionally with file content",
  },
  ask_mimocode: {
    zh: "把消息发给 MiMoCode agent 无头执行并返回其回答。支持传入 session_id 续接多轮对话",
    en: "Send a message to the MiMoCode agent for headless execution and return its answer. Pass session_id to continue a multi-turn conversation",
  },
  video_upload: {
    zh: "通过 HTTP 上传文件到 Video 目录：内容以 base64 传入，保存到 Video/<年月日>/ 子文件夹，文件名保持原名（撞名自动加序号）",
    en: "Upload a file to the Video directory via HTTP: content is sent as base64 and saved to a Video/<YYYYMMDD>/ subfolder under its original name (auto-numbered on collision)",
  },
};

// ---------------------------------------------------------------------------
// 参数描述（zod .describe()，toolParamDesc 工具名/参数名两级）
// ---------------------------------------------------------------------------
const PARAM_DESCS = {
  run_command: {
    command: {
      zh: "要执行的命令",
      en: "The command to execute",
    },
  },
  get_find_file: {
    query: {
      zh: "搜索条件：文件名关键词或通配符模式，如 report 或 *.log",
      en: "Search criteria: filename keyword or wildcard pattern, e.g. report or *.log",
    },
    root: {
      zh: "搜索起始目录，默认为用户主目录",
      en: "Directory to start searching from, defaults to the user home directory",
    },
    include_content: {
      zh: "是否同时返回文件内容（默认 false，只返回路径）",
      en: "Whether to also return file content (default false, paths only)",
    },
    max_results: {
      zh: "最多返回的文件数，默认 20",
      en: "Maximum number of files to return, default 20",
    },
  },
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
  video_upload: {
    filename: {
      zh: "保存的文件名，如 holiday.mp4",
      en: "Filename to save as, e.g. holiday.mp4",
    },
    content: {
      zh: "文件内容的 base64 编码",
      en: "base64 encoding of the file content",
    },
    date: {
      zh: "子文件夹名 YYYYMMDD，默认为今天",
      en: "Subfolder name YYYYMMDD, defaults to today",
    },
  },
};

// ---------------------------------------------------------------------------
// 运行时结果文案（resultText；{name} 为占位符，由调用方传参）
// ---------------------------------------------------------------------------
const RESULT_TEXTS = {
  // run_command
  "run.noOutput": {
    zh: "执行成功（无输出）",
    en: "Executed successfully (no output)",
  },
  // get_find_file / readFileSnippet
  "file.binary": {
    zh: "【二进制文件，{size} 字节，不返回内容】",
    en: "[Binary file, {size} bytes, content not returned]",
  },
  "file.truncated": {
    zh: "……（内容已截断）",
    en: "...(content truncated)",
  },
  "file.readFail": {
    zh: "【读取失败: {msg}】",
    en: "[Read failed: {msg}]",
  },
  // get_find_file / 搜索与复制
  "find.rootMissing": {
    zh: "起始目录不存在: {dir}",
    en: "Start directory does not exist: {dir}",
  },
  "find.notDir": {
    zh: "起始路径不是目录: {dir}",
    en: "Start path is not a directory: {dir}",
  },
  "find.none": {
    zh: '在 {dir} 下未找到匹配 "{query}" 的文件',
    en: 'No files matching "{query}" found under {dir}',
  },
  "find.copyOk": {
    zh: "已复制 {n} 个文件到 {dir}:",
    en: "Copied {n} files to {dir}:",
  },
  "find.copyFail": {
    zh: "复制失败 {n} 个:",
    en: "{n} copies failed:",
  },
  "find.found": {
    zh: "找到 {n} 个文件:",
    en: "Found {n} files:",
  },
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
  // video_upload
  "upload.badName": {
    zh: "非法文件名: {name}",
    en: "Illegal filename: {name}",
  },
  "upload.badBase64": {
    zh: "content 不是合法的 base64",
    en: "content is not valid base64",
  },
  "upload.empty": {
    zh: "文件内容为空",
    en: "File content is empty",
  },
  "upload.ok": {
    zh: "上传成功\n路径: {dest}\n大小: {kb} KB",
    en: "Upload succeeded\nPath: {dest}\nSize: {kb} KB",
  },
  "upload.saveFail": {
    zh: "保存失败: {msg}",
    en: "Save failed: {msg}",
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
