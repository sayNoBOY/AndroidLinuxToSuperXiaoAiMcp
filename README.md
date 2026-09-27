# android-linux-to-super-xiao-ai-mcp

让小爱同学(或任意支持 **Streamable HTTP** 的 MCP 客户端)接入本机能力的 MCP 服务器。
运行环境是一台跑在 Android 上的 Debian(aarch64),因此工具可以直接操作手机共享存储、执行命令、调用 MiMoCode 等。

- `http-server.js` — Streamable HTTP 版 MCP 服务器(主力,端口 3000)
- `server.js` — 原 stdio 版 MCP 服务器(保留未改动)

## 快速开始

```bash
npm install
node http-server.js        # 默认监听 0.0.0.0:3000,端点 /mcp
# 或指定端口
PORT=3000 node http-server.js
```

启动成功会打印:

```
MCP Streamable HTTP server running at http://0.0.0.0:3000/mcp
```

要求 Node.js 18+(项目为 ESM,`"type": "module"`)。

## 接入小爱同学

小爱 App → 设置 → **MCP 服务** → 添加服务:

| 字段 | 值 |
| --- | --- |
| 名称 | 随意(如 `node`) |
| 地址 | `http://<本机IP>:3000/mcp` |

添加后在 MCP 服务页开启该服务,即可看到下方工具列表并由小爱调用。

## 工具列表(共 7 个)

| 工具 | 说明 |
| --- | --- |
| `hello` | 向指定的人打招呼 |
| `calculator` | 计算两个数的加减乘除 |
| `get_weather` | 获取指定城市的天气 |
| `run_command` | 在设备上执行 shell 命令 |
| `get_find_file` | 按文件名关键词或通配符(如 `*.log`、`report*`)搜索文件,返回路径,可选返回文件内容 |
| `ask_mimocode` | 把消息发给 MiMoCode agent 无头执行并返回回答,支持 `session_id` 续接多轮对话 |
| `video_upload` | 以 base64 上传文件到 `Video/<年月日>/`,文件名撞名自动加序号 |

> 传输层为 MCP Streamable HTTP:`POST` 收 JSON-RPC(响应为 SSE 帧),`GET` 为 SSE 事件流,`DELETE` 结束会话;需要带 `Content-Type: application/json` 与 `Accept: application/json, text/event-stream`。
> 请求体上限已放宽到 `512mb`(`video_upload` 传大文件用)。

## ⚠ 安全提示

服务器绑定 `0.0.0.0` 且**没有任何鉴权**,局域网内任何人只要知道 IP 就能调用 `run_command`、`ask_mimocode`、`get_find_file` 等高危工具。请仅在可信网络环境下运行,或自行加防火墙/反向代理/令牌后暴露。

## License

[MIT](LICENSE) © 2026 刘春卫
