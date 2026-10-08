# android-linux-to-super-xiao-ai-mcp

让小爱同学(或任意支持 **Streamable HTTP** 的 MCP 客户端)接入本机能力的 MCP 服务器。
运行环境是一台跑在 Android 上的 Debian(aarch64),因此工具可以直接操作手机共享存储、执行命令、调用 MiMoCode 等。

**制作人:老实人留一手**

## 制作人

| 项目 | 信息 |
| --- | --- |
| 制作人 / 软件作者 | 老实人留一手 |
| 抖音账号 | 老实人留一手 |
| B站账号 | 老实人留一手 |

> 前端「我的 → 关于软件信息」弹窗的「软件作者 / 抖音账号 / b 站账号」即上述制作人(见 `App/HtmlView/src/views/Service.vue`);各源码文件头部也标注了制作人。

## 项目结构

```
.
├── LICENSE
├── App/                  # 随身互联 Web 管理台(Vue 3 + Vite,端口 5173)
│   └── HtmlView/         # 前端源码 src/views、构建产物 dist、README.md
├── McpServer/            # MCP 服务器(源码、依赖、详细文档)
│   ├── README.md         # 完整文档:接入方式、工具列表、安全提示
│   ├── http-server.js    # 服务入口:创建 express app 并监听 3000/mcp
│   ├── McpApi.js         # MCP 服务实现:4 个工具定义 + /mcp 路由与会话管理
│   ├── LoginApi.js       # 登录认证接口(login/refresh/logout/me,SQLite + JWT)
│   ├── TaskApi.js        # 任务管理接口(上传、下发、产物下载、WS 事件)
│   ├── SysApi.js         # 系统状态与操作日志接口
│   ├── OpLog.js          # 全局操作日志(operation_log)
│   ├── MiMoCodeConfig.js # 大模型配置读取 / 切换
│   ├── NetworkWatch.js   # 网络通断探测(离线挂起、恢复续跑)
│   ├── server.js         # 原 stdio 版 MCP 服务器(保留未改动)
│   ├── package.json
│   └── node_modules/
├── restart.sh            # 重启前后端并冒烟验证
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

前端管理台与后端一起重启可用仓库根的一键脚本:

```bash
./restart.sh          # 重启后端(:3000) + 前端(:5173)
./restart.sh backend  # 只重启后端
```

## 接入小爱同学

小爱 App → 设置 → **MCP 服务** → 添加服务:

| 字段 | 值 |
| --- | --- |
| 名称 | 随意(如 `node`) |
| 地址 | `http://<本机IP>:3000/mcp` |

## 工具列表(共 1 个)

`ask_mimocode`

详细的工具说明、传输层协议细节与接入步骤见 **[McpServer/README.md](McpServer/README.md)**。

## ⚠ 安全提示

服务器绑定 `0.0.0.0` 且**没有任何鉴权**,局域网内任何人只要知道 IP 就能调用 `ask_mimocode` 驱动本机 agent 执行任务。请仅在可信网络环境下运行,或自行加防火墙/反向代理/令牌后暴露。

## License

[MIT](LICENSE) © 2026 刘春卫

**制作人:老实人留一手**(抖音 / B站同名)
