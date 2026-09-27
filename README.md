# android-linux-to-super-xiao-ai-mcp

让小爱同学(或任意支持 **Streamable HTTP** 的 MCP 客户端)接入本机能力的 MCP 服务器。
运行环境是一台跑在 Android 上的 Debian(aarch64),因此工具可以直接操作手机共享存储、执行命令、调用 MiMoCode 等。

## 项目结构

```
.
├── LICENSE
├── McpServer/          # MCP 服务器(源码、依赖、详细文档)
│   ├── README.md       # 完整文档:接入方式、工具列表、安全提示
│   ├── http-server.js  # Streamable HTTP 版 MCP 服务器(主力,端点 3000/mcp)
│   ├── server.js       # 原 stdio 版 MCP 服务器(保留未改动)
│   ├── package.json
│   └── node_modules/
└── README.md
```

## 快速开始

```bash
cd McpServer
npm install
node http-server.js        # 默认监听 0.0.0.0:3000,端点 /mcp
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

## 工具列表(共 4 个)

`run_command`、`get_find_file`、`ask_mimocode`、`video_upload`

详细的工具说明、传输层协议细节与接入步骤见 **[McpServer/README.md](McpServer/README.md)**。

## ⚠ 安全提示

服务器绑定 `0.0.0.0` 且**没有任何鉴权**,局域网内任何人只要知道 IP 就能调用 `run_command`、`ask_mimocode`、`get_find_file` 等高危工具。请仅在可信网络环境下运行,或自行加防火墙/反向代理/令牌后暴露。

## License

[MIT](LICENSE) © 2026 刘春卫
