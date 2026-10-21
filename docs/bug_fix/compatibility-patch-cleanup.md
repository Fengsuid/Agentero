# 兼容补丁清理与验证（2026-10-21）

本轮由编辑器、PDF、后端三个并行审查切片实施，并交叉复核高风险路径。目标是删除失效实现、复用上游能力，把仍必要的适配收敛到明确的生命周期边界。不是按补丁文件数量删代码；原有 5 个依赖补丁仍有必要，新增 2 个小范围根因修复，替代应用侧的不可靠处理。

## 已完成

| 范围 | 替代与清理 | 保留的行为 |
|---|---|---|
| Markdown | 复用 Plate Link 插件、Markdown link rule 与 Slate fragment 解码；移除全局 toolbar API 异常吞噬及 pointer backend 无法触发的文件 drop 分支 | Vault 相对链接、中文括号、IME 批量输入、富文本粘贴、标题块策略、代码中的字面量 |
| PDF 引擎 | viewer/headless 共用创建策略与原生 Task.toPromise；删去 direct factory 返回 Promise 上的无效 readiness 补丁 | worker 启动失败/超时降级、取消及迟到引擎释放、正常文档关闭 |
| PDF 导航 | 以 onLayoutReady 和最新请求 token 替代 300/800/2000ms 重放；本地导航归属各自 viewer，外部引用按 canonical tab 路由 | 阅读位置恢复、快速连续引用、同论文分屏、冷加载关闭再打开 |
| PDF 批注 | 观察公开状态结算，最多补回一次被旧 commit 吞掉的删除；失败后释放队列并提示 | 创建/更新期间删除、撤销、失败后显式重试 |
| PDF 滚动 | 几何比较器内聚到 scroll 补丁，删除应用全局桥接及多余 optimizeDeps 排除 | 页窗口、旋转、缩放和尺寸变化仍更新 |
| Dockview | 由 overlay 所属对象清理 DOM 与内部引用，删除应用侧按 .dv-* 类名移除 DOM 的代码 | 离开后重新拖入、内部子元素切换、真实 drop 只接受一次、外部 dragend 不误触发 drop |
| Agent | semver 替代手写版本排序；ACP 响应作为历史回放边界；warm pool 由状态通知唤醒 | banner/短版本/opaque 输入、预热超时预算、取消与并发单次领取 |
| 进程环境 | ACP、探测、安装器共享可刷新的 shell 环境；后台 Windows 命令统一隐藏控制台 helper | 安装后 PATH 刷新、descriptor 覆盖优先级、交互式终端例外 |
| CLI/文件写入 | 统一 config 路径并无损迁移；原子写复用 tempfile 独占 sibling + persist，删除失败后截断目标的回退 | 新配置优先、迁移保留旧源与未知字段、Unix 权限、Wiki watcher 标记、.tmp 同步排除 |
| MinerU | 相同请求共享在途提取与 ZIP，弱引用不持久保留完成产物 | 配置/凭据隔离、独立进度与取消、最后消费者退出释放 HTTP future、失败后重试 |
| 后端冗余 | 移除未使用的 shell/store 插件、权限、Wiki helper、排名别名、重复 schema 检查、恒真条件与空分支；Catalog open counter 限于测试 | 现有数据模型、迁移与生产入口 |
| HTTP | client 与缓存键使用同一代理快照 | 显式代理优先级、Windows 系统代理 TTL、子进程代理环境 |

## 仍保留的依赖补丁

核查已锁定包及上游发行包后，EmbedPDF 2.15.1 的相关实现仍不能替代当前修复；AI 仍为 0.0.1。版本升级时按行为逐 hunk 验证，不整体盲删。

| 包 | 原因与退出条件 |
|---|---|
| @platejs/toc 53.0.0 | 官方 latest 仍为 53.0.0，发行包及 main 仍每次 scroll 更新 status 并重建 IntersectionObserver；上游稳定订阅且真实长笔记滚动通过后移除 |
| @embedpdf/ai 0.0.1 | 按 backend 选择 ORT 的 WASM/WebGPU 入口；上游等价实现并通过无 WebGPU 的 WebView 推理验证后移除 |
| @embedpdf/engines 2.14.4 | document 引用计数、内存读取/批量导出、页面原点、worker 初始化传播仍必要；相关边界逐项通过后拆除对应 hunk |
| @embedpdf/plugin-scroll 2.14.4 | 相同布局不重复触发 Scroller 更新；上游去重通过真实组件测试后移除 |
| @embedpdf/plugin-tiling 2.14.4 | rotation-aware tile ID/渲染/定位、DPR override 与失效；旋转、DPR 和双栏卸载回归通过后移除 |
| @embedpdf/plugin-annotation 2.14.4（新增） | ESM/CJS 各绑定 deleteTask.fail 一处，避免失败任务永久挂起；上游修复后以真实 PluginRegistry 拒绝路径测试验证替代 |
| dockview-core 7.0.4（新增） | 正确处理离开边界和 native dragend，并同步 overlay 引用；上游等价修复且保留当前功能后移除 |

Dockview 保持 7.0.4：v8 将现有 Ctrl+M 键盘停靠移入商业模块，直接升级会改变现有可用功能。pointer 取消保护、隐藏面板定位、sash 帧节流继续保留。Windows 路径规范化、系统代理适配、历史迁移、远端 WAL 快照和 FSEvents 原地写例外也有明确平台或数据契约，不作为死代码删除。

上游依据：[ACP session/load 顺序](https://agentclientprotocol.com/protocol/v1/session-setup)、[EmbedPDF 2.15.1](https://github.com/embedpdf/embed-pdf-viewer/releases/tag/v2.15.1)、[annotation 2.15.1 官方发行包](https://registry.npmjs.org/@embedpdf/plugin-annotation/-/plugin-annotation-2.15.1.tgz)、[TOC 官方 latest](https://registry.npmjs.org/@platejs%2ftoc/latest)、[TOC observer 源码](https://github.com/udecode/plate/blob/main/packages/toc/src/react/hooks/useContentObserver.ts)。具体功能契约见 [Markdown](../frontend/markdown.md)、[PDF](../frontend/pdf.md)、[工作区](../frontend/workspace.md)、[Agent](../backend/agent.md)、[CLI](../backend/cli.md)。

## Review 与验证

交叉 review 发现并修复了两个相关问题：旧批注操作失败时只清 pending 而不发成功事件；删除失败回调丢失 this，任务永久不结算。ESM/CJS 真实插件回归覆盖拒绝与恢复，不仅模拟成功事件。Dockview 回归使用真实库，覆盖 group center、root edge、真实 drop 和 dragend。导航、worker、ACP 排序、warm pool 并发、原子写、配置迁移与共享提取均有行为回归。

2026-10-21 在 macOS arm64 完成：

- Vitest 全量：258 文件通过，2,144 测试通过；1 文件、5 测试沿用现有跳过。并发上限为 4，未放宽断言或 timeout。
- cargo test --workspace --locked：1,362 通过，17 沿用现有忽略。
- TypeScript 与 Vite 生产构建通过；Biome 无 error（保留已有 7 warning、1 info）；dependency-cruiser 无违规；cargo fmt 与全 workspace/all-targets Clippy -D warnings 通过。
- 发布脚本测试 12 项、MkDocs strict 构建通过。
- 浏览器临时验收页挂载生产 MarkdownEditor、PdfViewer 与真实 PDFium worker：PDF 五页渲染、页码/区域跳转、Markdown 链接转换与编辑、笔记块拖动通过，无未捕获运行时异常。验收页不进入产品构建或提交。

验证边界：未执行 Windows 专属原子替换锁回归、原生 WebKit 拖拽人工验收及依赖真实服务凭据的既有忽略用例；不将浏览器组件验收表述为完整桌面平台验收。MinerU 长期缓存、跨 provider 提取计划层、跨文件恢复日志仍是原路线图的后续项，见 [Rust 重构进度](../development/rust-arch-refactor.md)。
