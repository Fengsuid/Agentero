# 本地插件系统

桌面应用支持从本机目录安装 JavaScript 插件，在每个本地 Vault 单独启用、授权和配置。插件代码不进入 React Webview，不自动执行 Vault 内代码。iOS、Android 与远程 Vault 不提供本地插件宿主。

带界面截图的操作教程见 [使用本地插件](../usage/plugins.md)。

## 使用

1. 运行 `pnpm tauri dev`，打开本地 Vault，在「设置 → 插件」选择「从文件夹安装…」。示例目录是 `examples/plugins/reading-tools`。
2. 安装后默认停用。打开开关，选择需要授予的权限并保存。授权只作用于设置窗口对应的 Vault；其他 Vault 需要单独授权。
3. 命令面板可执行插件命令；示例也向论文库行、文件树行和 PDF 选区菜单贡献操作。
4. 关闭开关撤销当前 Vault 的授权并取消执行。卸载删除包与授权，保留本机私有数据供重装使用。重新安装同 ID 的包视为更新，所有旧授权失效，需要重新启用。

debug 构建另有「加载开发插件…」：捕获目录源码快照，临时授予当前窗口只读权限。需要写权限的包应通过设置页安装和授权。改动源目录不会静默修改已安装/已加载的代码，需重新安装/加载。

## 包格式与 SDK

固定文件为 `manifest.json` 与 `main.js`。Manifest 上限 16 KiB，源文件上限 128 KiB；解析后的路径必须在所选目录内。支持单文件 ES module，不提供 Node、DOM、网络、文件 IO 或原生模块 loader。

- `apiVersion`：当前为 `1`；兼容早期 `0`，拒绝更高代际。
- `id`、`version`、`name`：包身份、显示版本、多语言名称。
- `permissions`：声明权限；安装本身不授予这些权限。
- `commands`：最多 16 项，包含 `id` 与 en / zh-CN `title`。
- `menus`：将命令贡献到 `fileTree.item`、`library.row`、`pdf.selection`，可指定 `order`。
- `events`：订阅公开生命周期事件闭集，需要 `vault:read` 授权才接收数据事件。
- `settings`：最多 32 个 string / boolean / number 字段；包含多语言标题与默认值，宿主生成配置表单。

开发者类型见 `examples/plugins/sdk.d.ts`；完整示例见 `examples/plugins/reading-tools`。公开导出：

```js
export async function activate(context) { /* 可选：本次会话初始化 */ }
export async function run(commandId, context) { /* 返回字符串或空值 */ }
export async function onEvent(event, context) { /* 可选：处理订阅事件 */ }
export async function deactivate(context) { /* 可选：尽力清理 */ }
```

**每次调用使用新的 JS 进程**，模块变量不跨调用保留。跨调用状态使用私有存储。`deactivate` 仅在空闲、仍有效的窗口卸载时尽力执行；忙碌、撤权、关窗或崩溃时直接取消，不能依赖该钩子保证数据持久化。不支持常驻后台进程或任意插件 React/HTML 界面。

上下文包含 `windowId`、`vaultId`（opaque 会话授权标识）、`paperRef`、`locale`、`relPath`、`selectionText`、`settings`、`event` 和 `payload`。菜单取点击对象的快照，命令面板取当前论文；不会因为稍后切换焦点而重新定位。插件结果只能是 JSON null，或最多 4096 字节的字符串，仅作为 Toast 文本显示。其它 JSON 值在宿主 `run()` 即为 `plugin_invalid_result`（桌面命令层仍保留同样的 4096 检查）。

## 数据 API 与权限

统一入口为 `await agentero.call(operation, args)`；错误为带 `code` 的 Error。宿主显式分派闭集操作，不透传 Tauri invoke，也不接受插件指定 Vault 或窗口。

| 权限 | 操作 |
|---|---|
| `vault:read` | `vault.list`、`vault.search`、`paper.list`、`paper.get`、`paper.paths`、`paper.notes.get`、`paper.tag.list`、`file.list`、`file.read`、`layout.list`、`layout.get`、`page.read` |
| `catalog:write` | `paper.set_read`、`paper.tag.add`、`paper.tag.rm`、`paper.tag.set` |
| `vault:notes:write` | `paper.notes.write` |
| `vault:write` | `file.write`、`paper.move` |
| 插件自身命名空间 | `storage.get`、`storage.set`、`storage.delete` |

业务操作还校验 core ops 的 stable 标记及权限分类。`vault.list` 只返回当前授权 Vault 的名称，不枚举其他 Vault。`page.read` 读取已有布局数据，不隐式启动 OCR。`paper.move` 复用 core 的目录、Catalog 与双链事务。删除、导入、执行程序等 internal 操作不公开。

文本读取返回 `content` 与 SHA-256 `revision`。写入必须提供 `expectedRevision`，不匹配返回 `plugin_revision_conflict`；替换 NOTES 保留原 frontmatter。正文上限 128 KiB，支持 replace / append。隐藏目录、AGENTS.md、路径越界、符号链接及通过普通文件写接口改 NOTES 均拒绝。

执行时的未保存路径快照和编辑器状态更新共同保护未保存内容。同一 Vault 同时被多个窗口持有时，插件文本写入和论文移动直接拒绝；这版不尝试跨窗口编辑事务。磁盘版本检查是乐观并发控制，不提供对外部编辑器的文件锁。已经开始的 blocking 业务事务可能完成，取消不回滚已完成写入；进程结果会被丢弃。

## 存储、会话和故障处理

`plugins.json` 与 settings.json 同目录，沿用 schemaVersion 1，并保留未知顶层/条目字段。已安装条目保存 manifest、源码快照以及以 canonical Vault 路径为键的 scopes（enabled / grants / settings）。最多 32 个包；更新清空 scopes。

私有存储在 `$XDG_DATA_HOME/agentero/plugins/<pluginId>/<vault-path-hash>.json`，按插件和 Vault 隔离，配额 128 KiB。配置和存储不写入 Vault，不随 Vault 同步，不是密钥保险库。

宿主以实际 IPC 调用窗口定位授权，并检查该窗口仍持有 Vault。切库/关窗撤销实例；启停、授权变化、更新或卸载广播刷新各窗口的注册。前端 generation 与串行恢复队列过滤迟到加载和结果，命令注册与菜单订阅均可释放。

- 每个实例只允许一个在途进程；前端队列最多 16 项。
- 连续三次调用失败时暂停该窗口的实例，提示用户重新启用。
- JS 堆 32 MiB、栈 256 KiB。用户脚本时限 5 秒，从子进程写完 `ready`、开始执行用户代码时起算；QuickJS interrupt 与父进程剩余交换共用这一时刻。进程启动、装载运行时和读取 invocation 不计入这 5 秒，另有 30 秒启动预算，超时为 `plugin_worker_start_timeout`。
- 协议帧：Call 的回复、Done、Failed 单帧 256 KiB。第一条父→子 Invocation 单独限额 2 MiB（128 KiB 源码经 JSON 转义后会膨胀，再加上已有上限的 selection / payload / settings）。超过 2 MiB 返回 `plugin_frame_too_large`，且不启动进程。Done 超过 256 KiB 时子进程改写 Failed，而不是直接退出。
- 最多 64 次 `Call`（broker 调用）。`ready` 不计。第 65 次 Call 不调用 broker，终止子进程并返回 `plugin_call_limit`。64 次调用后的 Done 仍然成功。
- 子进程在装好内存、栈和 interrupt 之后、执行用户代码之前写一帧 `{"type":"ready","cleanEnv":true|false}`。`cleanEnv` 仅表示子进程里 `std::env::vars()` 是否为空，不暴露给访客 JS。`run()` 会清空子进程环境。
- 失败码只由 worker / supervisor 选择，访客脚本文本不能冒充。`run()` 的 `Err` 在 release 中只有码；debug 构建在 message 非空时为 `code: message`。`throw "plugin_permission_denied"` 是 `plugin_exception`，不是 `plugin_permission_denied`（该码仍只出现在访客可见的 broker 拒绝里）。
  - `plugin_exception`：访客抛错或 QuickJS 异常。message 为访客文本，换行改空格，最多 500 字符。
  - `plugin_timeout`
  - `plugin_worker_start_timeout`
  - `plugin_frame_too_large`
  - `plugin_invalid_frame`
  - `plugin_invalid_result`
  - `plugin_call_limit`
  - `plugin_cancelled`
  - `plugin_worker_missing`
  - `plugin_worker_failed`：其余 spawn / IO 失败。码不用操作系统原文；message 可带简短清洗后的系统说明。
- 桌面进程不再把 GUI 可执行文件重新执行成插件 worker。解析顺序：`AGENTERO_PLUGIN_WORKER`（已设置且该路径是文件）、当前可执行文件同目录的 `agentero-plugin-host`（Windows 同时接受 `.exe`）、debug 构建再找 workspace `target/debug` 与 `src-tauri/target/debug`。都没有则 `plugin_worker_missing`，不会回退到 GUI。spawn 仍附带 `--agentero-plugin-worker`，以免路径误指向 GUI 时打开窗口（GUI 在 Tauri 与 single-instance 之前仍会走 worker 早退）。worker 是普通控制台子系统二进制；Windows 上 supervisor 仍设 `CREATE_NO_WINDOW`。
- 解析顺序仍是：`AGENTERO_PLUGIN_WORKER`（已设置且该路径是文件）、当前可执行文件同目录的 `agentero-plugin-host`（Windows 同时接受 `.exe`）、debug 构建再找 workspace `target/debug` 与 `src-tauri/target/debug`。都没有则 `plugin_worker_missing`，不会回退到 GUI。桌面发行包用 Tauri `bundle.externalBin`（`binaries/agentero-plugin-host`）附带真正的控制台二进制：macOS 放在 `Contents/MacOS/agentero-plugin-host` 并按可执行文件签名，Windows/Linux 放在 exe 旁边，所以上面的同目录查找在安装包里也能命中。开发和 CI 在 `tauri-build` 之前用 `pnpm plugin-worker:stage`（release 为 `pnpm plugin-worker:stage:release`，即 `scripts/prepare-plugin-worker.mjs`）把 `src-tauri/binaries/agentero-plugin-host-<triple>` 准备好；`tauri-build` 再复制到应用 exe 同目录。`cargo test -p agentero-plugin-host` 仍直接跑 crate bin。iOS/Android 的平台配置保持 `externalBin: []`，`beforeBuildCommand` 仍只是 `pnpm build`，没有插件宿主。
- 子进程清空继承环境；超时、取消和协议错误均终止并回收子进程。

这是受限 API 与进程故障隔离，**没有实现抵御引擎/native 漏洞的操作系统沙箱**。应只启用信任的本地代码。

## 验证与范围

```bash
cargo test -p agentero-plugin-host
cargo test -p agentero --lib integration::plugins
AGENTERO_UPDATE_BINDINGS=1 cargo test -p agentero export_typescript_bindings
pnpm exec vitest run test/development-plugins.test.ts test/menu-contributions.test.ts test/command-registry.test.ts test/lifecycle-vault-scope.test.ts
pnpm typecheck
pnpm tauri dev
```

也可用 `cargo run -p agentero --features bindings-export --example export_bindings` 单独生成 IPC 类型。

验收应覆盖安装默认停用、按 Vault 授权、菜单对象与选区、事件/存储、修改设置、停用/重启恢复、更新撤权和卸载；异常场景包括未授权调用、旧版本写入、未保存编辑、多窗口写入拒绝及失控脚本取消。

2026-10-22 macOS 开发版验收：`pnpm tauri dev` 编译启动当前源码；为 UI 自动化附加临时 `.app` 外壳，使用同一 debug 二进制与 `localhost:1420` Vite 服务，独立 XDG 配置/数据和临时 demo Vault。实际通过：目录安装默认停用、权限说明与设置保存、论文行标记已读、PDF 选区追加 NOTES 并实时刷新、事件阅读计数、命令面板执行、进程重启后恢复、撤销写权限返回 `plugin_permission_denied`、停用移除命令、同 ID 更新清空授权，以及卸载保留私有存储。首次冷启动曾触发当时的 5 秒超时保护（启动耗时算进了访客预算）；现已把进程启动放到单独的 30 秒预算里，访客脚本仍是 5 秒，限额没有放宽。那次验收里的 `plugin_permission_denied` 是 broker 拒绝进入访客 `error.message`；进程级失败现在只用上面的闭集错误码。

自动化验证覆盖 8 个 Host 插件测试、`cargo test -p agentero-plugin-host` 的 18 个通过（库内 4、`tests/process.rs` 14；该二进制与 doc 测试均为 0）、39 个前端相关测试，以及 IPC 类型导出检查。类型检查、前端生产构建和 Rust Clippy 通过。未保存编辑和多窗口写入拒绝尚未完成 GUI 手工复测，不能把上述验收视为跨平台发布验收。

后续范围：Windows/Linux 实机验收、操作系统沙箱、常驻长任务、跨窗口编辑事务，以及在线市场、自动更新、签名发布。市场与发布不属于本地初版。
