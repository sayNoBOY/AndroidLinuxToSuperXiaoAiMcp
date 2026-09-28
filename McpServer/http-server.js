import express from "express";

import { mountMcpApi } from "./McpApi.js";
import { mountLoginApi } from "./LoginApi.js";

const app = express();
// 视频等大文件 base64 后体积更大，放宽 body 限制
app.use(express.json({ limit: "512mb" }));

mountMcpApi(app);
mountLoginApi(app);

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`MCP Streamable HTTP server running at http://0.0.0.0:${PORT}/mcp`);
  console.log(`Login API running at http://0.0.0.0:${PORT}/api/v1/auth`);
});
