# 插件 API 契约（Phase 0）

状态：只冻结契约。没有插件进程、没有宿主、没有 Tauri command、没有设置页或 UI。

机器可调用的操作目录本来就在 `agentero-core::ops`，给 CLI `describe` 和 MCP 共用。这一步给每条操作补上稳定性、权限和代际（`since`），并单独列出允许对外的生命周期事件。前端事件名仍以 `src/lib/lifecycle/events.ts` 为准，本步不改那个文件。

## 代码位置

| 内容 | 路径 |
|---|---|
| `OpSpec`、`all()`、`get()` | `crates/agentero-core/src/ops/mod.rs` |
| 静态操作列表 | `crates/agentero-core/src/ops/catalog.rs` |
| 每条 id 的稳定性 / 权限 / `since` | `crates/agentero-core/src/ops/classify.rs` |
| 公开事件 `public_events()` | `crates/agentero-core/src/ops/events.rs` |
| 前端事件类型（未改） | `src/lib/lifecycle/events.ts` |

`op()` 的默认值是 `stability: internal`、`permission: unspecified`、`since: "0"`。`classify.rs` 的表必须覆盖目录里的每一个 id，且每个 id 只出现一次。漏写或写两次，`cargo test -p agentero-core ops::` 失败。新操作不能靠默认值悄悄留在未分类状态。

## 稳定性

`OpSpec.stability`：`internal` | `experimental` | `stable`。

`OpSpec.since` 是契约代际字符串。`internal` 为 `"0"`；`experimental` 和 `stable` 为 `"1"`。

在一个 minor 版本内：

- `stable` 的 id 不改名、不删除
- `stable` 操作已有的必填输入 / 输出字段不改名、不删除、不改类型
- 新增字段是可选的

`internal` 和 `experimental` 可以改、可以删。本阶段没有 `experimental` 条目。

## 权限

`OpSpec.permission` 序列化成下面的字符串。冒号是权限名的一部分，不是 camelCase 标识符。

| 值 | 含义 |
|---|---|
| `unspecified` | 未纳入公开契约。当前所有 `internal` 操作都是这个值 |
| `vault:read` | 读 Vault 文件或 catalog，不写 |
| `catalog:write` | 只改 catalog 里的已读状态和用户标签，不动文件树 |
| `vault:notes:write` | 只写论文目录下的 `NOTES.md` |
| `vault:write` | 写任意 Vault 文本，或移动论文目录 |

`paper.notes.write` 和 `file.write` 分开：笔记是用户的阅读记录，`file.write` 能改草稿和源文件。只需要记笔记的调用方不应拿到改写整个 Vault 的权限。`catalog:write` 同样不包含移动或删除文件。

`side_effects` 仍是 `Read` / `Write` / `Destructive` / `None`。公开读操作的 `side_effects` 都是 `Read`；公开写操作都是 `Write`。本步没有为了通过测试去改 `side_effects`。

## 公开 allowlist（`stable`，`since = "1"`）

读，`vault:read`：

`vault.list`、`vault.search`、`paper.list`、`paper.get`、`paper.paths`、`paper.notes.get`、`paper.tag.list`、`file.list`、`file.read`、`layout.list`、`layout.get`、`page.read`

窄写：

- `paper.set_read`、`paper.tag.add`、`paper.tag.rm`、`paper.tag.set` — `catalog:write`
- `paper.notes.write` — `vault:notes:write`

宽写，`vault:write`：

`file.write`、`paper.move`

`paper.move` 的副作用是 `Write`（移动论文目录，并更新链接与 catalog 路径）。

## 刻意保持 internal

破坏性操作不公开：`file.delete`、`paper.delete`、`mark.delete`，以及任何 `side_effects = Destructive` 的操作。

也不公开：`import.*`（`import.id`、`import.pdf`）、`paper.download`、`paper.parse`、`discover.arxiv`、`doctor`、`doctor.wiki`、`export.bib`、`mark.*`、`file.move`、`vault.create`、`translate`、`open`、`describe`。

`file.move` 会改任意路径并重写双链，比 `paper.move` 宽，留在 internal。

壳动作不进这条数据 API：`ui.open`、`ui.close`、`ui.window`、`ui.split`、`paper.open`。它们留给以后的命令贡献（command contribution），不在本契约里授予数据权限。`open`（用桌面应用打开一个目录）同样是壳动作，保持 internal。

## 公开事件

`public_events()` 只列这五个。不包含 `window:closed`、`job:completed`、`job:failed`、`agent:registry-changed`、`app:ready`。

| name | 契约字段 |
|---|---|
| `vault:opened` | `vaultId` |
| `paper:imported` | `vaultId`, `paperId` |
| `paper:assets-ready` | `vaultId`, `paperId` |
| `paper:renamed` | `vaultId`, `oldPaperId`, `newPaperId`, `oldPath`, `newPath`, `outcome` |
| `paper:opened` | `paperId` |

宿主实际 payload 还带 `timestamp`；`paper:renamed` 还带 `updatedSources`。这两项不在 v0 契约字段里。字段名与 `src/lib/lifecycle/events.ts` 一致。`paper:imported` / `paper:assets-ready` / `paper:renamed` 的发射在 `crates/agentero-core/src/features/lifecycle.rs`；`vault:opened` 和 `paper:opened` 由前端发出。

没有订阅 API。这张表只规定名字和字段。

## 进程内命令注册表

命令面板的命令列表是进程内注册表（`src/lib/shell/commands/registry.ts`），不是一份写死的数组。这一层只在应用进程里追加命令，不加载外部代码。外部列表在生产环境是空的。没有插件宿主。

两份列表按各自的注册顺序拼接：先内置，再外部。`listCommands()` 原样返回，不在这里看 `when`。命令面板自己决定隐藏哪些命令。

内置命令在 `src/components/shell/palette-commands.ts` 加载时通过 `registerBuiltinCommands` 显式以 `"builtin"` 注册。`registerCommand` 不写 source 时记为 `"external"`，避免调用方漏参数就登记成内置。同一个 id 再注册会抛错，并保留第一次的那条，不会替换。模块再次求值时，已经注册过的内置 id 会跳过，不会因为重复而抛错。

内置命令继续用 `titleKey` 和可选的 `categoryKey`（现有 i18n）。外部命令用普通字符串 `title` 和可选的 `category`，不需要 `titleKey`，文案不进 `src/i18n/locales`。面板用 `commandTitle` / `commandCategory` 取显示文案。

快捷键仍绑定 `src/lib/shell/shortcuts.ts` 里的内置 id。外部命令不会从这份注册表拿走快捷键。
