/**
 * android-linux-to-super-xiao-ai-mcp — 原 stdio 版 MCP 服务器（保留未改动）
 *
 * 制作人：老实人留一手（抖音 / B站同名）
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({
  name: "my-mcp-server",
  version: "1.0.0",
});

// 工具1：计算
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

// 工具2：获取天气（示例，实际可对接API）
server.tool(
  "get_weather",
  "获取指定城市的天气",
  { city: z.string().describe("城市名") },
  async ({ city }) => {
    return {
      content: [{ type: "text", text: `${city}：晴天，28°C` }],
    };
  }
);

// 工具3：执行shell命令
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

// 启动 stdio 传输
const transport = new StdioServerTransport();
await server.connect(transport);
