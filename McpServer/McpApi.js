/**
 * android-linux-to-super-xiao-ai-mcp — MCP Streamable HTTP 路由与 4 个工具实现
 *
 * 制作人：老实人留一手（抖音 / B站同名）
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { z } from "zod";
import { toolDescription, toolParamDesc, resultText } from "./mcpText.js";

const VIDEO_DIR = "/mnt/shared/Video"; // Android 共享存储中的 Video 目录
const CONTENT_LIMIT = 100 * 1024; // 单文件最多返回 100KB
const COPY_DIR = "/sdcard/Documents"; // 找到文件后复制到此目录

// 跳过不可读/无意义的系统目录
const SKIP_DIRS = new Set([
  "node_modules", ".git", "proc", "sys", "dev", "run", "snap",
  ".cache", ".local", "lost+found",
]);

// 将查询转为匹配器：含 * ? 视为通配符模式，否则按文件名关键词（不区分大小写）
function buildMatcher(query) {
  if (query.includes("*") || query.includes("?")) {
    const re = new RegExp(
      "^" + query.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$",
      "i"
    );
    return (name) => re.test(name);
  }
  const kw = query.toLowerCase();
  return (name) => name.toLowerCase().includes(kw);
}

async function searchFiles(root, query, maxResults) {
  const match = buildMatcher(query);
  const results = [];
  const queue = [root];
  while (queue.length > 0 && results.length < maxResults) {
    const dir = queue.shift();
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue; // 无权限等，跳过
    }
    for (const e of entries) {
      if (results.length >= maxResults) break;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) queue.push(full);
      } else if (e.isFile() && match(e.name)) {
        results.push(full);
      }
    }
  }
  return results;
}

async function readFileSnippet(full) {
  try {
    const stat = await fs.stat(full);
    const buf = await fs.readFile(full);
    const slice = buf.subarray(0, CONTENT_LIMIT);
    if (slice.includes(0)) {
      return resultText("file.binary", { size: stat.size });
    }
    const truncated = buf.length > CONTENT_LIMIT;
    return slice.toString("utf-8") + (truncated ? `\n${resultText("file.truncated")}` : "");
  } catch (e) {
    return resultText("file.readFail", { msg: e.message });
  }
}

function createServer() {
  const server = new McpServer({
    name: "my-mcp-server",
    version: "1.0.0",
  });

  server.tool(
    "run_command",
    toolDescription("run_command"),
    { command: z.string().describe(toolParamDesc("run_command", "command")) },
    async ({ command }) => {
      const { execSync } = await import("child_process");
      try {
        const output = execSync(command, { encoding: "utf-8", timeout: 10000 });
        return { content: [{ type: "text", text: output || resultText("run.noOutput") }] };
      } catch (e) {
        return { content: [{ type: "text", text: e.message }] };
      }
    }
  );

  server.tool(
    "get_find_file",
    toolDescription("get_find_file"),
    {
      query: z.string().describe(toolParamDesc("get_find_file", "query")),
      root: z.string().optional().describe(toolParamDesc("get_find_file", "root")),
      include_content: z.boolean().optional().describe(toolParamDesc("get_find_file", "include_content")),
      max_results: z.number().int().min(1).max(100).optional().describe(toolParamDesc("get_find_file", "max_results")),
    },
    async ({ query, root, include_content, max_results }) => {
      const startDir = root ? path.resolve(root) : os.homedir();
      const limit = max_results ?? 20;

      let stat;
      try {
        stat = await fs.stat(startDir);
      } catch {
        return { content: [{ type: "text", text: resultText("find.rootMissing", { dir: startDir }) }] };
      }
      if (!stat.isDirectory()) {
        return { content: [{ type: "text", text: resultText("find.notDir", { dir: startDir }) }] };
      }

      const paths = await searchFiles(startDir, query, limit);
      if (paths.length === 0) {
        return { content: [{ type: "text", text: resultText("find.none", { dir: startDir, query }) }] };
      }

      // 找到完整路径后，复制到 /sdcard/Documents/（文件名加序号前缀，避免同名覆盖）
      const copied = [];
      const failed = [];
      await fs.mkdir(COPY_DIR, { recursive: true }).catch(() => {});
      let idx = 0;
      for (const p of paths) {
        try {
          idx++;
          const base = `${idx}_${path.basename(p)}`;
          let dest = path.join(COPY_DIR, base);
          // 跨次调用仍撞名时，追加 -1、-2……直到不冲突
          let n = 0;
          while (await fs.access(dest).then(() => true).catch(() => false)) {
            n++;
            dest = path.join(COPY_DIR, `${idx}_${n}_${path.basename(p)}`);
          }
          await fs.copyFile(p, dest);
          copied.push(dest);
        } catch (e) {
          failed.push(`${p}: ${e.message}`);
        }
      }

      const copyReport =
        (copied.length > 0 ? `${resultText("find.copyOk", { n: copied.length, dir: COPY_DIR })}\n` + copied.map((p, i) => `${i + 1}. ${p}`).join("\n") : "") +
        (failed.length > 0 ? `\n${resultText("find.copyFail", { n: failed.length })}\n` + failed.join("\n") : "");

      if (!include_content) {
        const list = paths.map((p, i) => `${i + 1}. ${p}`).join("\n");
        return { content: [{ type: "text", text: `${resultText("find.found", { n: paths.length })}\n${list}\n\n${copyReport}` }] };
      }

      const parts = [];
      for (const p of paths) {
        const snippet = await readFileSnippet(p);
        parts.push(`=== ${p} ===\n${snippet}`);
      }
      return { content: [{ type: "text", text: parts.join("\n\n") + "\n\n" + copyReport }] };
    }
  );

  server.tool(
    "ask_mimocode",
    toolDescription("ask_mimocode"),
    {
      message: z.string().describe(toolParamDesc("ask_mimocode", "message")),
      session_id: z
        .string()
        .optional()
        .describe(toolParamDesc("ask_mimocode", "session_id")),
      model: z.string().optional().describe(toolParamDesc("ask_mimocode", "model")),
      cwd: z.string().optional().describe(toolParamDesc("ask_mimocode", "cwd")),
    },
    async ({ message, session_id, model, cwd }) => {
      const args = ["run", message, "--format", "json"];
      if (session_id) args.push("--session", session_id);
      if (model) args.push("-m", model);

      const workdir = cwd ? path.resolve(cwd) : os.homedir();
      try {
        const stat = await fs.stat(workdir);
        if (!stat.isDirectory()) {
          return { content: [{ type: "text", text: resultText("ask.workdirMissing", { dir: workdir }) }] };
        }
      } catch {
        return { content: [{ type: "text", text: resultText("ask.workdirMissing", { dir: workdir }) }] };
      }

      const raw = await new Promise((resolve) => {
        // stdin 必须忽略：pipe 会让 mimo run 一直等待输入而不退出
        const child = spawn("mimo", args, {
          cwd: workdir,
          stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (d) => (stdout += d));
        child.stderr.on("data", (d) => (stderr += d));
        const timer = setTimeout(() => child.kill("SIGKILL"), 300_000);
        child.on("close", (code) => {
          clearTimeout(timer);
          resolve({ error: code === 0 ? null : new Error(`exit code ${code}`), stdout, stderr });
        });
        child.on("error", (err) => {
          clearTimeout(timer);
          resolve({ error: err, stdout, stderr });
        });
      });

      // 解析 NDJSON 事件流：拼接 text 片段，提取 sessionID
      const texts = [];
      let sid = session_id ?? null;
      for (const line of raw.stdout.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let ev;
        try {
          ev = JSON.parse(trimmed);
        } catch {
          continue;
        }
        if (ev.sessionID) sid = ev.sessionID;
        if (ev.type === "text" && ev.part?.text) texts.push(ev.part.text);
      }

      const answer = texts.join("\n").trim();
      if (raw.error && !answer) {
        return {
          content: [
            {
              type: "text",
              text: resultText("ask.runFail", {
                msg: raw.error.message,
                stderr: raw.stderr.slice(0, 2000),
              }),
            },
          ],
          isError: true,
        };
      }

      return {
        content: [
          {
            type: "text",
            // answer 是 MiMoCode 生成内容，不翻译；session_id 有值时保留协议字段名原文
            text: `${answer || resultText("ask.noOutput")}\n\n---\n${sid ? `session_id: ${sid}` : resultText("ask.sidUnknown")}`,
          },
        ],
      };
    }
  );

  server.tool(
    "video_upload",
    toolDescription("video_upload"),
    {
      filename: z.string().describe(toolParamDesc("video_upload", "filename")),
      content: z.string().describe(toolParamDesc("video_upload", "content")),
      date: z
        .string()
        .regex(/^\d{8}$/)
        .optional()
        .describe(toolParamDesc("video_upload", "date")),
    },
    async ({ filename, content, date }) => {
      // 文件名清洗：只取 basename，防止路径穿越
      const safeName = path.basename(filename).replace(/[\x00-\x1f]/g, "").trim();
      if (!safeName || safeName === "." || safeName === "..") {
        return { content: [{ type: "text", text: resultText("upload.badName", { name: filename }) }], isError: true };
      }

      const now = new Date();
      const ymd =
        date ??
        `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}`;
      const dir = path.join(VIDEO_DIR, ymd);

      let buf;
      try {
        buf = Buffer.from(content, "base64");
      } catch {
        return { content: [{ type: "text", text: resultText("upload.badBase64") }], isError: true };
      }
      if (buf.length === 0) {
        return { content: [{ type: "text", text: resultText("upload.empty") }], isError: true };
      }

      try {
        await fs.mkdir(dir, { recursive: true });
        // 撞名时追加 _1、_2……
        const ext = path.extname(safeName);
        const stem = safeName.slice(0, safeName.length - ext.length);
        let dest = path.join(dir, safeName);
        let n = 0;
        while (await fs.access(dest).then(() => true).catch(() => false)) {
          n++;
          dest = path.join(dir, `${stem}_${n}${ext}`);
        }
        await fs.writeFile(dest, buf);
        const kb = (buf.length / 1024).toFixed(1);
        return {
          content: [
            { type: "text", text: resultText("upload.ok", { dest, kb }) },
          ],
        };
      } catch (e) {
        return { content: [{ type: "text", text: resultText("upload.saveFail", { msg: e.message }) }], isError: true };
      }
    }
  );

  return server;
}

/**
 * 把 /mcp 的 POST / GET / DELETE 路由挂载到 app 上。
 * 每个新会话调用一次 createServer，得到一个带工具注册的 McpServer 实例。
 */
export function mountMcpApi(app) {
  // sessionId -> transport（每个会话对应一个 McpServer 实例）
  const transports = {};

  app.post("/mcp", async (req, res) => {
    try {
      const sessionId = req.headers["mcp-session-id"];
      let transport;

      if (sessionId && transports[sessionId]) {
        transport = transports[sessionId];
      } else if (!sessionId && req.body?.method === "initialize") {
        const server = createServer();
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sid) => {
            transports[sid] = transport;
          },
        });
        transport.onclose = () => {
          if (transport.sessionId) {
            delete transports[transport.sessionId];
          }
        };
        await server.connect(transport);
      } else {
        res.status(400).json({
          jsonrpc: "2.0",
          error: { code: -32000, message: "Bad Request: no valid session" },
          id: null,
        });
        return;
      }

      await transport.handleRequest(req, res, req.body);
    } catch (e) {
      console.error("POST /mcp error:", e);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    }
  });

  // GET：SSE 通知流（复用已有会话）
  app.get("/mcp", async (req, res) => {
    const sessionId = req.headers["mcp-session-id"];
    const transport = sessionId && transports[sessionId];
    if (!transport) {
      res.status(400).send("Invalid or missing session ID");
      return;
    }
    await transport.handleRequest(req, res);
  });

  // DELETE：终止会话
  app.delete("/mcp", async (req, res) => {
    const sessionId = req.headers["mcp-session-id"];
    const transport = sessionId && transports[sessionId];
    if (!transport) {
      res.status(400).send("Invalid or missing session ID");
      return;
    }
    await transport.handleRequest(req, res);
  });
}
