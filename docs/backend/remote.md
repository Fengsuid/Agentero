# 远程 Vault（SSH/SFTP）

文件权威在服务器；本机 UI + 可选远端 BYOA。

## 能力

| 层 | 说明 |
|---|---|
| 连接 | `remote_connect` / `disconnect`；密钥或 SSH agent；`remote_ssh_config_hosts` 解析 `~/.ssh/config` 供对话框联想 |
| 文件 | SFTP list/read/write/mkdir/remove/bytes |
| Catalog | work mirror（本机查询，写回远端） |
| PDF | blob 缓存（`remote_cache_*`） |
| Agent | ACP over SSH：`remote_agent_probe` / scan / 与 `agent_run_once` 集成（命令实现属 agent 域 `features/agent/commands/remote.rs`，经反转 trait `agent::remote_host::{RemoteAgentHosts, RemoteAgentLaunch}` 复用 remote 域的 SSH session/exec） |
| 入库 / 回收站 | 远端写路径与 trash bridge；features 命令经反转 trait `import::RemoteImportOps` / `trash::remote_ops::RemoteTrashOps` 调用（`integration::remote` 实现并在 app 启动时注册为 State） |
| Connector | 可绑定 `remote:<sessionId>` |

前端伪路径 `remote:<sessionId>`（解析在 `core/remote.rs`，纯字符串工具，features/integration 共用）。客户端：**macOS / Linux**（Windows 客户端暂不支持打开远程 Vault）。

## Catalog 发布

连接和元数据刷新通过 SSH 在服务器执行 Python 3 标准库 `sqlite3` 的 `VACUUM INTO`，以只读源连接生成包含已提交 WAL 页的独立快照；临时文件自动清理，不复制正在变化的主库/WAL，也不强制 checkpoint。服务器需要 `python3` 和其 `sqlite3` 模块，无需安装 Agentero CLI。快照失败时明确报错，不回退到可能过期的主文件。下载前后校验主库 size/mtime 和 WAL 内容摘要；变化时拒绝该次下载，用户可重试。

`remote_paper_list/get` 会检查服务器主库和 WAL，检测变化后通过 SQLite backup API 刷新无本机未发布修改的 work mirror，并清退其旧缓存连接，保留独立读连接的 SQLite 锁语义。存在未发布修改时拒绝刷新，避免静默丢失本机修改。远端非空 WAL 存在时拒绝上传 Catalog；应停止远端写者，再重新打开 Vault。只读会话断开不重复上传 Catalog。

本机 work mirror 开启 WAL。初始化远端 Catalog 与每次 push 都通过 SQLite `VACUUM INTO` 导出独立一致快照，读取已提交的主库与 WAL 内容；其他写连接保持打开或存在未提交事务时也不依赖连接关闭/checkpoint。临时快照在成功或失败后自动清理，导出失败不上传。

发布仍先检查远端 size/mtime 是否与上次一致，再上传临时文件并 rename（不支持时回退覆盖）；该检查保留现有乐观冲突语义，不是远端原子 CAS。快照只包含开始读取时可见的已提交数据，之后的修改由后续 push 发布。sidecar 投影及远端会话清退仍见架构计划 B1/B2。

## 超时

建连与校验约 15s；SFTP 操作约 30s；SSH ServerAlive；不自动重连、不重放写。

## 代码

`src-tauri/src/integration/remote/`（handle 解析：`crates/agentero-core/src/remote.rs`）  
教程：[../usage/remote-vault.md](../usage/remote-vault.md)
