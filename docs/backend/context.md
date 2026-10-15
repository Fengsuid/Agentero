# 研究上下文

Quick Chat 和侧边栏共用同一套只读上下文。Host 根据这一轮的选区、当前论文和 `@` 提及生成 `ContextRequest`，解析器得到 `ContextPlan`：放进 prompt 的最小证据、本轮允许访问的来源、预算，以及指纹。

```text
ContextRequest → Context Resolver → ContextPlan
                                  ├─ 最小证据（paper ref、标题、页/章节、引文）
                                  ├─ 允许的来源
                                  ├─ 预算
                                  └─ fingerprint
```

首期只覆盖当前 Vault，只读。不接 Zotero、OpenViking、PaperQA，也不提供写工具。

## 最小证据

Prompt 里只有稳定 paper ref、标题、页码或章节、引用原文，以及能跳回原文的 citation URI（`papers/…/paper.pdf#page=3` 这种，和现有引用跳转同一格式）。摘要不进 prompt。引用超过 1200 字会截断，剩下的靠工具读。

远程会话，或者这一轮没有可授权的来源时，prompt 会写明无法继续展开，agent 不能假设自己能读 Vault。

`@` 到普通目录时，目录本身是允许来源，prompt 里标成 directory。`context_search` 在其中的文本文件里找短卡片，数量有上限。对目录调用 `context_read` 只返回一层文件名；要读正文需点名目录里的文件。没有扩展名的普通文件仍按文件授权。

## 会话 MCP

每个带授权来源的本地 ACP 会话会在 `session/new`、`session/resume`、`session/load` 上挂一个 stdio MCP，名字是 `agentero-context`。宿主用当前可执行文件加 `--agentero-context-mcp <grant>` 拉起它。Grant 写在 `{vault}/.agentero/context-sessions/{runtime-id}/grant.json`，里面是这一轮的允许列表。

它和设置里的 loopback `agentero` MCP 不是同一套权限。那个面向外部客户端，能看当前整个 Vault。`agentero-context` 只看本轮 grant。

三个工具：

| 工具 | 行为 |
|---|---|
| `context_search` | 少量证据卡片，摘录有字数上限，不返回全文 |
| `context_read` | 默认 `metadata`（标题、作者、摘要）。然后才是 `excerpt`、`section`、`page`、`region`。`full` 必须点名，并且仍受预算限制。文件的 `excerpt` 先在文件里定位引文，再按预算截取返回 |
| `paper_relations` | 引用、被引、库内相关论文的瘦卡片。引用 sidecar 和 citing-scan 缓存。grant 外的论文只出现在卡片上，`context_read` 会拒绝 |

工具结果带 `citationUri`。实际用过的 URI 追加到同目录的 `usage.jsonl`，回合结束时放进 `agent:completed` 的 `sources`。侧边栏和 Quick Chat 把这些来源画成可点击的定位。

## 指纹和恢复

指纹覆盖工具名单、允许的来源、预算，以及这次是挂了 MCP 还是只能用 prompt。引文改字不改变指纹。授权范围变了，或者这份会话以前没有指纹，Host 会丢掉 resume id，新开 ACP 会话，避免旧会话悄悄多读到新的来源。侧栏会把已经显示的先前对话交给这次新会话，已经在 prompt 里的那份不会再贴一次。被拒绝续上的旧 ACP 会话也不会从 warm pool 里接着用。

关系卡片只在能打开时带 citation URI：库内路径、`https://doi.org/…` 或 `https://arxiv.org/abs/…`。没有这些时 URI 留空，聊天里不出现点不开的链接。

带 MCP 的回合不走 warm pool。Warm 出来的会话创建时没有这个 MCP，不能事后把授权塞进去。

## 代码

| 层 | 路径 |
|---|---|
| 计划、grant、读取 | `crates/agentero-core/src/features/context/` |
| stdio MCP | `src-tauri/src/integration/context_mcp.rs` |
| 挂到 ACP 回合 | `src-tauri/src/features/agent/context_turn.rs` |
| Quick Chat / 侧边栏锚点 | `src/lib/agent/context-request.ts` |
