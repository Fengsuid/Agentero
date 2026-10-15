# Windows ACP 启动失败：环境变量名含 `=`

对应 [Issue #772](https://github.com/poco-ai/Agentero/issues/772)。

## 现象与根因

Windows 11 / Agentero 0.11.8 在设置 → Agent 探测时可能报：

```text
Internal error: {
  "spawned_at": "...agent-client-protocol-1.3.0/src/jsonrpc.rs:1524:39",
  "data": "environment variable name must not contain `=`"
}
```

Windows 进程环境可包含 `=C:` / `=D:` 等隐藏的盘符工作目录条目。Agentero 的
`build_child_env` 原先把进程、login-shell、descriptor 的环境合并后全部转成
ACP `EnvVariable`，进而显式调用子进程 Command 的 `env` 设置。
Windows ACP 传输使用 `windows-spawn`，其显式变量名校验拒绝 `=`，因此错误
发生在创建 Agent 进程之前。`spawned_at` 是 SDK 创建异步任务的位置，不是
OpenCode 业务代码报错的位置。该问题可能影响任何走此路径的本地 ACP Agent。

## 修复

在共享合并函数返回前，仅过滤空名称、含 `=` 或 NUL 的名称。三个来源均经过
相同过滤；不清空宿主环境，也不改变合法名称、正常值中的 `=`、空值或 PATH
合并顺序。probe / run / warm / history 和复用该环境的诊断命令都受益。

保留原 Windows Job Object 进程树保护。修复不依赖每个用户手写清理环境的
PowerShell 启动器，也不按 OpenCode 单独绕过校验。

## 验证

- Windows 独立回归使用生产 `build_child_env` 源码及实际 `acp/process.rs`，
  注入进程来源的 `=C:` 后，修复前复现上述相同错误与 SDK 行号；修复后完成
  ACP `initialize` 握手。fixture 为本机 PowerShell，不依赖模型账号或网络。
- 单元测试覆盖 process / shell / descriptor 的非法名称，正常值 `literal=value`
  与空值仍被保留；既有优先级和 PATH 合并测试继续验证。
- Windows 原生设置探针回归调用实际 `probe_agent`，descriptor 中同时提供
  `=C:` / `=D:` 与合法变量，fixture 先验证合法值，再返回 ACP 初始化信息。

这些验证覆盖环境合并、原生进程创建和设置探测服务；不等于完整设置窗口 GUI
点击实测，也不验证特定用户的 OpenCode 登录或网络配置。
