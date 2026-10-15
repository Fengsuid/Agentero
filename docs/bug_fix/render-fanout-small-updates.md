# 小更新引发大面积无关重渲染：全项目审计与修复

**状态**：第一批 19 项已修复（2026-10）；遗留项见 §5
**影响面**：Agent 流式输出、PDF 阅读（翻页/高亮/划词/hover）、论文库表格、文件树、Markdown/文本编辑器、Excalidraw、设置跨窗口同步、命令面板
**审计方法**：6 个审查通道（Agent 流式 / zustand 订阅 / 编辑器 / PDF / 库表与文件树 / 壳层与 Context）+ 3 轮交叉验证，全部结论基于 file:line 代码证据

---

## 1. 问题模式

历史上的「流式输出全页重渲染」核心链路（host 40ms 合流 + rAF 合帧 + 行级 memo + 虚拟化）在位且无回归。本轮修的是四类结构性残留：

| 模式 | 典型案例 | 后果 |
|---|---|---|
| memo 边界被内联回调击穿 | `vault-sidebar.tsx` 内联 `onPasteInto` 是 FileTree 全部 ~35 个 props 中唯一不稳定项 | Library 行 hover 每换一行 = 文件树全量重渲染 |
| 粗订阅挂在巨型组件顶层 | PDF `useLayoutAnalysis` 每页分析完 setState 一次 2161 行的 PdfViewerInner | 打开 PDF 开始读笔记的窗口期 20 次全量渲染 |
| 上游 identity churn | `vaultStore.setTree` 每次刷新 mint 5 个新派生数组（内容可能没变） | WikiNavContext 全部消费者 + AgentPanel mention 标签全量重算 |
| 渲染期重计算漏 memo | ReferencesPanel 每按键对 100–500 条引用重建含 BibTeX 原文的 haystack | 每键 O(N × raw 拼接) |

## 2. 已修复清单（按提交）

### 状态与订阅

- **vault store 派生数组内容保护**（`src/lib/vault/store.ts`）：`setTree`/`setVaultPath` 对 5 个 `string[]` 派生字段做内容等值守卫（对照 `samePapers` 模式），内容不变沿用旧引用；`setVaultPath` 全等早退跳过 setState
- **Agent 面板 lines 订阅下沉**（`use-agent-panel.ts` / `agent-panel.tsx` / `chat-transcript.tsx`）：`useActiveChatLines` 从面板顶层移入 ChatTranscript，面板壳层流式期间零重渲染；ChatTranscript/AgentConfigBar 包 memo（含 latest-ref 回调 shim）；`selectionNavigationStore` 改原始值 selector；`parseAskUserQuestions` 模块级缓存（256 容量）；copyPayload/agentText 改为点击时构建（`CopyAction` 改懒取值 API）
- **历史弹层指纹订阅**（`agent-history.tsx`）：sessions 数组订阅改为身份指纹字符串 + `getState` 快照，流式期间不再每帧重渲染列表；行 label useMemo
- **背景任务窄订阅**（`use-background-tasks.ts`）：全项目唯一无 selector 裸订阅改为 `(s) => s.tasks`

### PDF

- **版面分析订阅移除**（`pdf-viewer.tsx`）：`useLayoutAnalysis`（全量 state 订阅）改为已有 `layoutCap` capability 调用，每页分析不再全量渲染
- **chrome memo 化**：PdfToolbar/BottomBar/CardStack/OutlinePanel/FiguresPanel/ReferencesPanel/FindBar/OutlineTree 包 memo；CardStack 调用点 7 个 inline 对象 + 3 个 inline lambda 全部 useMemo/useCallback 稳定；outline 节点 key 用 WeakMap 缓存（不再每渲染全树 `JSON.stringify`）
- **textLinks 逐页引用保留**：memo 内与上次结果逐页对比，未变页复用旧数组/旧 Map
- **hoveredCommentId 按拥有页门控**：从 pageMarks 共享 bundle 拆出为按页 prop（非拥有页恒 null），hover 批注只重渲染拥有页；`PdfPageMarksSlice.hoveredCommentId` 保留为 optional fallback（翻译 pane 静态 slice 兼容）
- **page text link 等值守卫**（`use-pdf-page-text.ts`）：`setPageTextLinkMap` 补上与 `setPageTextMap` 对称的逐元素等值守卫
- **citationLinks 等值守卫**（`use-pdf-highlights.ts`）：链接集合未变时跳过 `setCitationLinks`（加高亮不再全页重算引用链层）
- **gutter/批注卡片布局 memo**（`selection-gutter.tsx` / `comment-cards-layer.tsx`）：layoutPins/layoutCommentCards + Map 渲染期重算改 useMemo；ReferencesPanel 引用过滤 haystack 预计算（含 raw BibTeX 的拼接只在 citations 变化时做一次）

### 编辑器与查看器

- **CodeMirror 延迟物化**（`text-editor.tsx`）：pending 存 `Text` 引用（零拷贝），800ms flush 时才 `toString()`，消除每击键 O(文档) 拷贝
- **MarkdownEditor memo 跨保存保持**（`markdown-editor.tsx` + `notes-split.ts`）：comparator 让 `initialMarkdown` 仅在 `reloadKey` 同时变化时参与比较；seed 写入加 no-op 守卫——自动保存不再重渲染整棵编辑器 chrome
- **跨窗口 settings 字段级合并**（`react-store.ts`）：外部广播逐顶层字段比较（原始值 `===`，对象 JSON 内容对比），只替换变化字段，未变字段保留旧引用（`libraryColumns` 等不再被打穿）
- **Excalidraw 序列化防抖**（`excalidraw-viewer.tsx`）：`serializeAsJSON`（含 base64 图片）从每 onChange 帧挪进 800ms 防抖 flush；`handleChange` 引用稳定
- **命令面板复用 searchText**（`command-palette.tsx` + `library-row-utils.ts`）：抽取 `buildPaperSearchText` 单一来源，palette 每键只做预计算字符串 includes

### Library 与壳层

- **PaperRow WeakMap 缓存**（`library-row-utils.ts`）：按 paper 对象身份缓存行构建（searchText + 8 个 sort key），单条更新只重渲染受影响行；前提：`setLibraryPapers` 的 map 对未变行保留对象身份
- **Header 回调稳定化**（`papers-library.tsx`）：`columnWidths` useMemo、`resizeColumn`/`onClearTagFilter` useCallback
- **EasyScholar 批量刷新**（`library-table-header.tsx`）：循环内只写 catalog，每 50 篇合并一次 store flush（原每篇一次全链路替换）
- **文件事件回调 ref 化**（`use-vault-file-events.ts`）：7 个回调存 ref，App 重渲染不再 unlisten/re-listen；修复失焦缓冲态下缓冲事件被 dispose 静默丢弃的正确性 bug
- **TitleBar 回调稳定化**（`App.tsx`）：`onApplyLayoutMode` useCallback
- **composer chips scroll 守卫**（`composer-context-chips.tsx`）：复用姊妹组件 `clientRectMoved`，任何容器滚动不再必然重渲染 VisualReferenceCard
- **FileTree 稳定回调**（`vault-sidebar.tsx`）：内联 `onPasteInto` 提为模块级函数

## 3. 验证

- `pnpm typecheck` / `pnpm lint:ts`（改动文件零告警）/ `pnpm test`（1945 通过）全绿
- 预期行为抽查：流式期间 AgentPanel 壳层与 composer 零重渲染（仅 transcript 行）；翻页仅 BottomBar 渲染（图库/大纲/引用面板 bail）；hover 批注仅拥有页渲染；改一个 tag 仅一行 + 树中一个 label

## 4. 修复期间发现的相邻问题（未修，登记）

- `agent-panel.tsx` composer 分隔条拖拽缺 `pointercancel`：指针取消后 move handler 永久泄漏（正确性）
- `anchored-popover.ts` `remToPx` 每调用 `getComputedStyle(documentElement)`：应模块级缓存
- `vault-sidebar.tsx` `citingScanBusy={ioBusy !== null}`：任何 IO 都显示 busy（应判断类型）
- `use-agent-panel.ts` agentChromeStore 同步 effect 依赖每渲染新引用的 `selected`，重复 setState
- markdown 编辑器 `use-completion-drafts` 打开期间每击键整树重渲染（P1 遗留，同 `docs/frontend/markdown.md` 登记）

## 5. 遗留 backlog（按优先级）

1. **agent tool 事件无合帧**：`applyToolEvent` 绕过 rAF 缓冲直写 store，且 `mergeToolState`/`applyToolToParts`/`applyToolToLines` 三层无条件换引用，store 侧 `nextLines === prevLines` guard 永远打不中——流式型工具输出几十次/s 全量通知
2. **PDF 选区菜单滚动**：`rePlaceSelectionMenu` 每滚动帧 setState 新对象 → PdfViewerInner 全量渲染（开自动翻译后菜单常驻）；需改 portal + ref 直写 style
3. **findQuery/pageField 下沉**：两个输入控件 state 挂在 inner 顶层，每键全组件渲染
4. **App 非布局订阅下沉**：`anyModalOverlayOpen`、connector/mcp scope、chrome 设置切片仍订阅在 App 函数体
5. **`reindexQueue` 每 tick 重建所有 task 对象**（background-tasks.ts）
6. **selection-navigation body 级 MutationObserver**：6s 窗口内流式 token 也触发全文档 querySelectorAll + textContent 走查
7. **`translateHighlightsFingerprint` 急切求值**（pdf-viewer.tsx:643-646，同 pinnedTranslates 手法可解）
8. **comment-cards 上游 `comments.map` 未 memo**（page-layers.tsx 翻译可见分支）
9. **figures-panel `s.ui` 对象订阅**：别的文档分析进度也触发本面板重渲染
