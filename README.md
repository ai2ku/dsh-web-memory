# dsh-web-memory

DSH（DeepSeek Harness）原生 Web 记忆 + 人格插件。从 dsh-memory-brain（QQ 桥接）剥离记忆 + 人格系统，适配 DSH 原生 Web 会话，实现跨会话 / 跨设备共享记忆，并保留人格系统。

## 功能

- **记忆存档**：Web 会话每条用户消息 / AI 回复写进记忆存档（`chat:{userId}`，跨设备共享，带 device 标注来源）。
- **人格系统**：持续判读对话，维护性格 / 情绪 / 关系随经历变化，注入 systemPrompt。
- **记忆检索**：会话开始时用最近用户消息检索记忆，注入 systemPrompt.context。
- **主动唤醒**：到期约定 / 忽然想起，定时主动投递。
- **角色扮演**：`roles/` 下的角色卡（小鲸鱼、傲娇助手等），可切换进入角色。

## 目录结构

```
dsh-web-memory/
├── client.js                  # 前端（侧边栏「记忆与人格」+ 设置页）
├── lib/index.js               # DSH 插件入口（agent 挂载、API 路由）
├── src/                       # 核心逻辑
│   ├── web-memory-core.js     #   记忆 + 人格对外接口（ltm/persona）
│   ├── long-memory.js         #   长期记忆（listPeople/personView/archiveRows）
│   ├── persona.js / persona-store.js  # 人格系统
│   ├── life-loop.js           #   主动唤醒（到期约定/忽然想起）
│   └── ...                    #   其余模块（decay/rag-client/search 等）
├── config.example.json        # 插件配置模板（复制为 config.json 填写）
├── roles/                     # 角色卡（每个角色一个 .md，无密钥）
├── state/                     # 运行时状态（本地；example 为模板）
│   ├── current-role.example.json
│   └── life-loop.example.json
└── sidecars/
    └── memory-rag/            # memory-rag 容器源码（独立服务）
        ├── Dockerfile
        ├── docker-compose.yml
        ├── config.example.yml
        ├── .env.example
        └── memory_rag/        # 向量索引 + 提炼 + 检索 + /file/* 接口
```

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

## memory-rag 容器

容器源码在 `sidecars/memory-rag/`，独立服务（端口 8093）。部署：

```bash
cd sidecars/memory-rag
cp config.example.yml config.yml
cp .env.example .env          # 填 MEMORY_RAG_API_TOKEN
docker compose up -d --build
```

- **数据挂载**：只挂记忆数据子目录（`long-memory` + `persona`），源码/配置不进容器数据卷；数据路径用 `MEMORY_RAG_DATA_DIR`（默认 `/vol2/1000/docker/memory-rag`）。
- **认证**：容器 token（`.env` 的 `MEMORY_RAG_API_TOKEN`）与插件 `config.json` 的 `memoryRag.token` 保持一致。

## 安装

DSH 插件目录（如 `plugins/dsh-web-memory/`），DSH 启动时自动加载。

## 开发

- `src/`：核心逻辑（web-memory-core、long-memory、persona、life-loop 等）
- `lib/index.js`：DSH 插件入口（agent 挂载、API 路由）
- `client.js`：前端（侧边栏「记忆与人格」页面 + 设置页）
- `sidecars/memory-rag/`：容器源码（独立 Python 服务）

## License

MIT
