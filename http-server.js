import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { randomUUID } from "node:crypto";
import express from "express";
import { z } from "zod";

const app = express();
// 视频等大文件 base64 后体积更大，放宽 body 限制
app.use(express.json({ limit: "512mb" }));

const VIDEO_DIR = "/mnt/shared/Video"; // Android 共享存储中的 Video 目录

import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";

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

const CONTENT_LIMIT = 100 * 1024; // 单文件最多返回 100KB
const COPY_DIR = "/sdcard/Documents"; // 找到文件后复制到此目录

async function readFileSnippet(full) {
  try {
    const stat = await fs.stat(full);
    const buf = await fs.readFile(full);
    const slice = buf.subarray(0, CONTENT_LIMIT);
    if (slice.includes(0)) {
      return `【二进制文件，${stat.size} 字节，不返回内容】`;
    }
    const truncated = buf.length > CONTENT_LIMIT;
    return slice.toString("utf-8") + (truncated ? "\n……（内容已截断）" : "");
  } catch (e) {
    return `【读取失败: ${e.message}】`;
  }
}

function createServer() {
  const server = new McpServer({
    name: "my-mcp-server",
    version: "1.0.0",
  });

  server.tool(
    "hello",
    "向指定的人打招呼",
    { name: z.string().describe("你的名字") },
    async ({ name }) => ({
      content: [{ type: "text", text: `你好，${name}！` }],
    })
  );

  server.tool(
    "calculator",
    "计算两个数的加减乘除",
    {
      operation: z.enum(["add", "subtract", "multiply", "divide"]),
      a: z.number(),
      b: z.number(),
    },
    async ({ operation, a, b }) => {
      let result;
      switch (operation) {
        case "add": result = a + b; break;
        case "subtract": result = a - b; break;
        case "multiply": result = a * b; break;
        case "divide": result = b !== 0 ? a / b : "除数不能为0"; break;
      }
      return { content: [{ type: "text", text: String(result) }] };
    }
  );

  server.tool(
    "get_weather",
    "获取指定城市的天气",
    { city: z.string().describe("城市名") },
    async ({ city }) => ({
      content: [{ type: "text", text: `${city}：晴天，28°C` }],
    })
  );

  server.tool(
    "run_command",
    "在设备上执行shell命令",
    { command: z.string().describe("要执行的命令") },
    async ({ command }) => {
      const { execSync } = await import("child_process");
      try {
        const output = execSync(command, { encoding: "utf-8", timeout: 10000 });
        return { content: [{ type: "text", text: output || "执行成功（无输出）" }] };
      } catch (e) {
        return { content: [{ type: "text", text: e.message }] };
      }
    }
  );

  server.tool(
    "get_find_file",
    "查找系统中的相关文件并发送返回：按文件名关键词或通配符（如 *.log、report*）搜索，返回匹配的文件路径，可选返回文件内容",
    {
      query: z.string().describe("搜索条件：文件名关键词或通配符模式，如 report 或 *.log"),
      root: z.string().optional().describe("搜索起始目录，默认为用户主目录"),
      include_content: z.boolean().optional().describe("是否同时返回文件内容（默认 false，只返回路径）"),
      max_results: z.number().int().min(1).max(100).optional().describe("最多返回的文件数，默认 20"),
    },
    async ({ query, root, include_content, max_results }) => {
      const startDir = root ? path.resolve(root) : os.homedir();
      const limit = max_results ?? 20;

      let stat;
      try {
        stat = await fs.stat(startDir);
      } catch {
        return { content: [{ type: "text", text: `起始目录不存在: ${startDir}` }] };
      }
      if (!stat.isDirectory()) {
        return { content: [{ type: "text", text: `起始路径不是目录: ${startDir}` }] };
      }

      const paths = await searchFiles(startDir, query, limit);
      if (paths.length === 0) {
        return { content: [{ type: "text", text: `在 ${startDir} 下未找到匹配 "${query}" 的文件` }] };
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
        (copied.length > 0 ? `已复制 ${copied.length} 个文件到 ${COPY_DIR}:\n` + copied.map((p, i) => `${i + 1}. ${p}`).join("\n") : "") +
        (failed.length > 0 ? `\n复制失败 ${failed.length} 个:\n` + failed.join("\n") : "");

      if (!include_content) {
        const list = paths.map((p, i) => `${i + 1}. ${p}`).join("\n");
        return { content: [{ type: "text", text: `找到 ${paths.length} 个文件:\n${list}\n\n${copyReport}` }] };
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
    "把消息发给 MiMoCode agent 无头执行并返回其回答。支持传入 session_id 续接多轮对话",
    {
      message: z.string().describe("要发给 MiMoCode 的消息/任务"),
      session_id: z
        .string()
        .optional()
        .describe("续接已有会话时传入上次返回的 session_id；首次调用留空"),
      model: z.string().optional().describe("可选，指定 provider/model"),
      cwd: z.string().optional().describe("可选，agent 的工作目录，默认为用户主目录"),
    },
    async ({ message, session_id, model, cwd }) => {
      const args = ["run", message, "--format", "json"];
      if (session_id) args.push("--session", session_id);
      if (model) args.push("-m", model);

      const workdir = cwd ? path.resolve(cwd) : os.homedir();
      try {
        const stat = await fs.stat(workdir);
        if (!stat.isDirectory()) {
          return { content: [{ type: "text", text: `工作目录不存在: ${workdir}` }] };
        }
      } catch {
        return { content: [{ type: "text", text: `工作目录不存在: ${workdir}` }] };
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
            { type: "text", text: `mimo run 失败: ${raw.error.message}\n${raw.stderr.slice(0, 2000)}` },
          ],
          isError: true,
        };
      }

      return {
        content: [
          {
            type: "text",
            text: `${answer || "(无文本输出)"}\n\n---\nsession_id: ${sid ?? "未知"}`,
          },
        ],
      };
    }
  );

  server.tool(
    "video_upload",
    "通过 HTTP 上传文件到 Video 目录：内容以 base64 传入，保存到 Video/<年月日>/ 子文件夹，文件名保持原名（撞名自动加序号）",
    {
      filename: z.string().describe("保存的文件名，如 holiday.mp4"),
      content: z.string().describe("文件内容的 base64 编码"),
      date: z
        .string()
        .regex(/^\d{8}$/)
        .optional()
        .describe("子文件夹名 YYYYMMDD，默认为今天"),
    },
    async ({ filename, content, date }) => {
      // 文件名清洗：只取 basename，防止路径穿越
      const safeName = path.basename(filename).replace(/[\x00-\x1f]/g, "").trim();
      if (!safeName || safeName === "." || safeName === "..") {
        return { content: [{ type: "text", text: `非法文件名: ${filename}` }], isError: true };
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
        return { content: [{ type: "text", text: "content 不是合法的 base64" }], isError: true };
      }
      if (buf.length === 0) {
        return { content: [{ type: "text", text: "文件内容为空" }], isError: true };
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
            { type: "text", text: `上传成功\n路径: ${dest}\n大小: ${kb} KB` },
          ],
        };
      } catch (e) {
        return { content: [{ type: "text", text: `保存失败: ${e.message}` }], isError: true };
      }
    }
  );

  return server;
}

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

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`MCP Streamable HTTP server running at http://0.0.0.0:${PORT}/mcp`);
});
