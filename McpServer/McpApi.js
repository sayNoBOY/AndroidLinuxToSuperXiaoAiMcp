/**
 * android-linux-to-super-xiao-ai-mcp — MCP Streamable HTTP 路由与 1 个工具实现（ask_mimocode）
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

function createServer() {
  const server = new McpServer({
    name: "my-mcp-server",
    version: "1.0.0",
  });

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
