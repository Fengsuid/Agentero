# Windows 安装推荐 Skill 反复弹出 gh.exe 控制台窗口（#741）

**状态**：已修复
**影响面**：Windows 发布版（GUI 子系统）；广场「Skill 推荐」/ 魔棒导入 GitHub Skill 时，凡走本机 `gh` 的请求
**相关代码**：

- `crates/agentero-core/src/features/paper/import/skill/mod.rs` — `fetch_github_api_json_via_gh()`
- `crates/agentero-core/src/http.rs` — `discover_github_auth_token()`
- `crates/agentero-core/src/process/mod.rs` — `hide_console_window()` / `hide_console_window_tokio()`
- 同类问题（启动设备探测 / 问题诊断）：[windows-console-window-flash.md](windows-console-window-flash.md)

## 1. 现象

Windows 11（`gh` 由 scoop 安装）安装推荐 Skill 时，反复弹出 `gh.exe` 命令行窗口。

## 2. 根因

### 2.1 GUI 进程 + 未带 CREATE_NO_WINDOW 的控制台子进程 = 可见控制台

与 [windows-console-window-flash.md](windows-console-window-flash.md) 同一机制：发布版是 GUI 子系统二进制，
spawn 控制台程序时缺 `CREATE_NO_WINDOW`，Windows 会为子进程分配一个可见控制台窗口。

### 2.2 Skill 导入按 API 请求逐次 spawn `gh`，所以是「反复」

`crates/agentero-core/src/features/paper/import/skill/mod.rs` 的 GitHub REST 请求优先走本机已登录的 `gh`
（`gh api --hostname github.com …`），每个请求都 spawn 一次：

- 候选发现：默认分支 1 次、`git/trees?recursive=1`（或逐层 contents）1 次、每个 `SKILL.md` 读 1 次 blob；
- 选中安装：每层目录列一次 contents、每个文件读一次 blob。

一次安装几十次 `gh api` 调用，每次都 spawn 一个 `gh.exe`，所以窗口不是闪一次而是「反复」出现。
另外 HTTP 回退路径的 `http.rs::discover_github_auth_token()` 还会 spawn `gh auth token`（5 分钟缓存）。

scoop 的 `gh.exe` 是 shim（再转发到真实 gh.exe），shim 本身也是控制台程序，窗口在 spawn 它时就已经产生。

### 2.3 为什么之前没暴露

没装 `gh` 的用户不走这条路径（直接 HTTP 请求，无子进程）；macOS 没有控制台窗口概念。

## 3. 修复

- `crates/agentero-core/src/process/mod.rs` 新增 `hide_console_window()`（`std::process::Command`）与
  `hide_console_window_tokio()`（`tokio::process::Command`）：Windows 下统一
  `creation_flags(CREATE_NO_WINDOW)`，其他平台 no-op；
- 上述两处 `gh` spawn 改为经这两个 helper 启动。

`CREATE_NO_WINDOW` 给 shim 一个隐藏控制台缓冲，shim 再启动的真实 `gh.exe` 以默认标志共享该隐藏缓冲，
同样不可见；`gh` 的 stdout / stderr 本就由 `output()` 走管道读取，功能与解析逻辑不变。

## 4. 验证

- `cargo check -p agentero-core`；`cargo fmt -p agentero-core -- --check` 干净。
- `cargo test -p agentero-core --lib`：`process::` / `http::` / `import::skill::` 全部通过。
- 本次未在真实 Windows 上做垫片复测；`#[cfg(windows)]` 代码与仓库既有 Windows CI 已编译的同型写法一致
  （`integration/mcp/tunnel.rs` 的 tokio `creation_flags`、`features/vault/agent_links.rs` 的 std `CommandExt`）。
