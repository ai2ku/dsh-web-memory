# dsh-web-memory

DSH（DeepSeek Harness）原生 Web 记忆 + 人格插件。从 dsh-memory-brain（QQ 桥接）剥离记忆 + 人格系统，适配 DSH 原生 Web 会话，实现跨会话 / 跨设备共享记忆，并保留人格系统。

## 功能

- **记忆存档**：Web 会话每条用户消息 / AI 回复写进记忆存档（`chat:{userId}`，跨设备共享，带 device 标注来源）。
- **人格系统**：持续判读对话，维护性格 / 情绪 / 关系随经历变化，注入 systemPrompt。
- **记忆检索**：会话开始时用最近用户消息检索记忆，注入 systemPrompt.context。
- **主动唤醒**：到期约定 / 忽然想起，定时主动投递。

## 数据存储

记忆 / 人格数据全存 **memory-rag 容器**（HTTP 访问），插件本身是纯客户端。容器提供 `/file/read`、`/file/write`、`/file/append`、`/file/delete`、`/file/list` 接口作为通用文件存储后端。

本地仅保留角色配置（`current-role.json`）与唤醒状态（`life-loop.json`）。

## 配置

复制 `config.example.json` 为 `config.json` 并填写：

```bash
cp config.example.json config.json
```

关键配置项（`config.json`）：

| 字段 | 说明 |
|------|------|
| `memoryRag.url` | memory-rag 容器地址（默认 `http://127.0.0.1:8093`）|
| `memoryRag.token` | 容器认证 token |
| `memoryRag.enabled` | 记忆服务开关 |
| `crossDevice.userId` | 跨端共享记忆的用户标识（单用户默认 `root`）|
| `lifeLoop.enabled` | 主动唤醒开关 |

## 安装

DSH 插件目录（如 `plugins/dsh-web-memory/`），DSH 启动时自动加载。

## 开发

- `src/`：核心逻辑（web-memory-core、long-memory、persona、life-loop 等）
- `lib/index.js`：DSH 插件入口（agent 挂载、API 路由）
- `client.js`：前端（侧边栏「记忆与人格」页面 + 设置页）

## License

MIT
