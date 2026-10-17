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

## 限制与后续

- 60 秒只解决宿主过短预算，无法修复适配器内部死锁或无限等待。
- 本仓库不包含该本地 pi-acp 副本。Pi 启动至就绪、读取消息、回放消息及失败阶段
  的细分日志需在适配器侧补充，并与未修改版本对照。
- 真实 Windows Pi 环境仍需验证长历史恢复和取消；历史浏览没有宿主取消接口，
  本次保持现有行为。
