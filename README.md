# Network Packet Lab · 网络协议数据包可视化实验室

项目 10：一个用于学习和演示网络协议解析过程的可视化实验室。当前版本聚焦模拟 HTTP / TCP 数据包，提供输入、场景选择、协议层级字段树、十六进制数据、解析时间线，以及可供 React 管理界面调用的 Node.js API。

## 技术栈

- **前端**：React 18、Vite、TypeScript
- **后端**：Node.js、Express、TypeScript
- **工程**：前后端共享 `shared/types.ts` 类型，根目录统一管理脚本

## 目录结构

```text
network-packet-lab/
├── client/
│   ├── index.html
│   └── src/
│       ├── App.tsx
│       ├── main.tsx
│       └── styles.css
├── server/
│   └── index.ts
├── shared/
│   └── types.ts
├── package.json
├── tsconfig.json
├── tsconfig.server.json
├── vite.config.ts
└── .gitignore
```

## 功能

1. **模拟数据选择**：在 HTTP / TCP 协议之间切换，并选择请求、响应或 TCP 握手场景。
2. **数据包输入**：编辑原始 HTTP 文本或 TCP 模拟摘要，点击“解析数据包”重新生成可视化结果。
3. **协议字段树**：HTTP 展示起始行、Header、Payload；TCP 展示 Ethernet、IPv4、TCP 和 Payload 层级，并支持折叠。
4. **十六进制视图**：以 offset、hex bytes、ASCII 三列展示当前 payload 的 UTF-8 字节。
5. **传输时间线**：展示抓包、起始行/路由识别、Header/TCP 解码、Payload 形成和结构化输出五个阶段。
6. **逐步回放（课堂演示）**：点击“逐步回放”后，服务端为当前输入生成带 5 个阶段快照的解析轨迹；播放器支持播放 / 暂停 / 单步前进 / 单步后退 / 回到起点，以及拖动进度条和点击阶段刻度跳转。字段树、摘要、元数据、十六进制视图（已解码字节高亮、未解析字节变暗）和时间线随当前阶段同步变化；结束后可“退出回放，回到普通解析结果”。
7. **解析 API / 模拟数据 API**：Express 服务提供 `/api/parse`、`/api/replay`、`/api/simulate`、`/api/packets` 和 `/api/health`。

### 回放阶段

| # | HTTP | TCP |
|---|------|-----|
| ① 抓取 capture | 原始帧进入缓冲区，无字段、无事件 | 同左 |
| ② 识别 identify | 切出 Request-Line / Status-Line | 解析源/目的路由，装入 IPv4 节点 |
| ③ 解码 decode | 逐行解析 Header 字段 | 解码 Seq/Ack/Flags/Win（Len 待 Payload 阶段确定） |
| ④ Payload | 空行之后的消息体形成 Payload | 依据 Len 附加段数据，Len=0 显示 (empty) |
| ⑤ 最终输出 | 完整字段树、元数据、校验和（与 `/api/parse` 完全一致） | 同左 |

空输入或阶段生成失败时，`/api/replay` 返回 4xx/5xx，前端会先清空上一包画面再提示错误，不会残留旧快照；回放中切换协议或场景会立即退出回放并加载新示例。

## 启动方式

当前只完整落盘项目文件，**没有安装依赖**。准备运行时，在本目录执行：

```bash
npm install
```

然后打开两个终端：

```bash
# 终端 1：启动 API 服务（默认 3001）
npm run dev:server

# 终端 2：启动 Vite 管理界面（默认 5173）
npm run dev:client
```

浏览器访问 `http://localhost:5173`。如需更换 API 地址，可设置 `VITE_API_BASE`，例如：

```bash
VITE_API_BASE=http://localhost:3001 npm run dev:client
```

生产构建：

```bash
npm run build
npm start
```

> `npm start` 会启动编译后的 API 服务；前端静态产物位于 `dist/client`，可交给任意静态服务器托管。

## API 示例

### 获取模拟数据

```bash
curl 'http://localhost:3001/api/simulate?protocol=HTTP&scenario=request'
curl 'http://localhost:3001/api/simulate?protocol=TCP&scenario=handshake'
```

### 解析输入数据包

```bash
curl -X POST 'http://localhost:3001/api/parse' \
  -H 'Content-Type: application/json' \
  -d '{"protocol":"HTTP","scenario":"request","raw":"GET /health HTTP/1.1\\r\\nHost: lab.local\\r\\n\\r\\n"}'
```

### 生成逐步回放轨迹（含 5 个阶段快照）

```bash
curl -X POST 'http://localhost:3001/api/replay' \
  -H 'Content-Type: application/json' \
  -d '{"protocol":"TCP","scenario":"handshake","raw":"TCP 10.0.0.24:51842 > 10.0.0.8:443 | Seq=0 Ack=0 | Flags=SYN | Win=64240 | MSS=1460 | WS=7"}'
```

返回 `data.stages[]`，每个阶段带独立的 `fields / hex / revealedBytes / timeline / metadata / narration`；`data.final` 为最终结构化结果（与 `/api/parse` 等价）。空输入返回 `400`，阶段生成失败返回 `500`。

### 获取某协议的全部示例

```bash
curl 'http://localhost:3001/api/packets?protocol=TCP'
```

## 说明

本项目是教学用模拟器，不执行真实网卡抓包，也不声称校验真实 TCP 校验和。十六进制内容由当前输入字符串的 UTF-8 字节生成，字段解析为面向演示的轻量级解析结果。
