# ACP 历史恢复误用 15 秒预算

## 现象与边界

Windows Agentero 0.11.9 通过基于 pi-acp 0.0.34、含 `agentero-context` 桥接补丁的
本地副本恢复历史时，初始化成功，但约 15 秒报
`session/load timed out after 15s`。重启和部分 MCP 改 lazy 后仍可发生。
尚未与未修改的适配器做对照，不能据此判定 Pi 内部发生阻塞。

## 原因与修复

历史浏览 `history.rs` 和续聊 `run.rs::open_resume_on` 都把 `session/load` 交给
通用 15 秒超时封装。初始化的 30 秒预算不覆盖 load；适配器可能还需启动 Pi RPC、
读取历史并逐条回放。

两个入口改用 `client.rs::timed_acp_load_session` 的独立 60 秒预算，续聊的
`tokio::select!` 取消分支保持有效。其他 RPC 的预算不随之放宽。
宿主记录每次 load 的 agent/session、预算、结果及请求总耗时；future 被丢弃也记录
cancelled，错误日志保留适配器错误或超时原因。不记录会话内容。

## 验证

虚拟时钟测试覆盖：45 秒 load 成功而普通 RPC 仍在 15 秒超时；未完成的 load
在 60 秒超时；等待 load 的调用者可在 2 秒收到取消后退出。

### Windows 官方包诊断（2026-10-17）

在仓库 `target/pi-acp-diagnosis` 隔离安装 pi-acp **0.0.34** 和 Pi **1.3.0**，
用官方 Pi `SessionManager` 生成历史，不调用模型、不使用真实凭证或用户数据。
测试进程用独立 `PI_CODING_AGENT_DIR` 和 `USERPROFILE`；适配器的会话映射仍依赖
`os.homedir()`，仅覆盖 Pi 配置目录不足以隔离它。

| 场景 | 实测结果 |
|---|---|
| Pi RPC 读取 4 / 2000 条消息 | get_state 约 0.6–0.7 秒，get_messages 约 1 / 30 ms |
| 官方 ACP 冷进程恢复 4 条消息，两次 | 约 0.70–0.78 秒，4 条回放均完整 |
| 官方 ACP 冷进程恢复 2000 条消息（约 4.7 MB），两次 | 约 0.84–0.94 秒，2000 条回放均完整 |
| Agentero Rust 宿主恢复 4 / 2000 条消息，各两次 | 约 1.07–1.27 / 1.89–1.93 秒，内容与条数检查通过 |
| 人为延迟 Pi 启动 20 秒，再运行真实 Pi | 初始化 0.26 秒，load 约 21.2 秒成功 |
| 人为让 Pi 启动后不回复 | 初始化仍成功；诊断程序等待 4 秒后主动结束，load 没有返回 |

后两项为**故障注入**，不代表反馈用户的实际原因。默认官方环境没有复现 15 秒超时，
因此 60 秒预算只能定性为缓解，不能定性为该用户故障的根因修复。
故障注入还确认 Pi 子进程写入的 stderr 标记不会被官方适配器转发，可能掩盖启动错误。

另有显式启用的 Windows 宿主集成测试
`official_pi_history_survives_fresh_processes`，通过真实 `load_acp_session` 验证回放内容。
运行时设置 `AGENTERO_PI_HISTORY_ROOT` 为隔离安装根、
`AGENTERO_PI_HISTORY_NODE` 为 Node 可执行文件，并使用 `--ignored --nocapture`。
根目录的 `fixtures.json` 包含 `cwd`、`home` 和 `fixtures: [{id, turns}]`；
每个 fixture 由 Pi SessionManager 生成交替的 `question N` / `answer N` 消息，N 从 0 开始。
安装根沿用 `node_modules/pi-acp` 和 `.bin/pi.cmd` 布局。

## 限制与后续

- 60 秒只解决宿主过短预算，无法修复适配器内部死锁或无限等待。
- 本仓库不包含该本地 pi-acp 副本。Pi 启动至就绪、读取消息、回放消息及失败阶段
  的细分日志需在适配器侧补充，并与未修改版本对照。
- 反馈用户的 Pi 版本、全局 MCP/扩展配置及本地补丁仍需采集、对照；本机默认环境
  的成功结果不能排除其内部阻塞。历史浏览没有宿主取消接口，本次保持现有行为。
