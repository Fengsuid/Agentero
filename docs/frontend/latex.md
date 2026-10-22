# LaTeX 写作与编译

LaTeX 编辑使用 CodeMirror；正式编译走本机 latexmk，PDF 使用已有 EmbedPDF 查看器；实时预览走独立 LuaLaTeX/rtex 会话。后端见 [../backend/latex.md](../backend/latex.md)。

## 界面与编译

当前文件属于 LaTeX 项目时，左栏显示 LaTeX 操作和整篇论文的结构。命令包括编译、强制重建、清理后重建、查看 PDF、实时预览、清理中间产物与编译日志。引擎和项目设置放在标题右侧的设置按钮里。

- **普通编译**保留当前文件与活动编辑 pane，只刷新已打开的 PDF，不自动打开或激活 PDF；“查看 PDF”负责打开/切换预览。文件树与 LaTeX 侧栏的编译、强制重建、清理后重建遵循同一规则。文件树的编译图标保持透明背景，按下时不触发整行的按下底色，保留选中状态和键盘焦点提示。编译使用 latexmk 的增量判断；强制重建无视增量缓存；清理后重建先清除中间产物、保留 PDF。
- **手动保存**先保存所有挂载的文本编辑器，再编译项目主文件；后台自动编译可按项目选择手动、保存后或依赖变化时触发。
- **编译期间**保留上一份成功 PDF，可以继续阅读；只有没有旧产物时才显示加载占位。成功后替换所有同路径 PDF 分屏的字节，恢复页码、阅读点和缩放；失败时保留旧 PDF。
- **问题**保持编辑页面底部原有计数与悬停列表，也可用键盘聚焦打开。只显示 ChkTeX 原始规则结果，浮层保留消息中的规则编号，不另起一行重复显示来源，单击定位；文字可拖选并使用系统复制，拖选结束不会跳转。每条末尾平时显示行列，悬停或键盘聚焦时在原位换为紧凑复制图标（触屏常显），复制当前问题的文件、行列、严重度和原始规则消息；不提供复制全部。不启用语言包诊断或自写项目诊断。编译失败仍通过任务、日志和 toast 呈现。
- **实时预览状态**：入口名称始终为“实时预览”；开启时整行淡色高亮、文字右上方紧跟常亮绿点；背景复用主题 CSS 变量 `--primary` 并降低不透明度，绿点保持统一的绿色状态色。关闭时恢复普通背景并隐藏绿点（保留占位）。点击整行切换，键盘与读屏通过 toggle button 的 `aria-pressed` 获取状态，不另加开关或引擎后缀。
- **日志**只有 LaTeX 侧栏的一个按钮，点击打开 modal，查看当前构建的完整输出。日志 modal 与任务面板支持停止编译。

编辑器不会为每次自动构建弹成功 toast；操作失败通过 `notifyError` 提示。LaTeX 侧栏没有第二份问题计数或问题列表。

## 项目设置与配方

主文件自动识别支持 `% !TEX root`、自身 document 标记、反向 include 图和 subfiles 的父文件。项目设置可显式选择主文件，或让某个 subfile 独立编译；选择随本机工作区保留。

引擎仍按根文件 `% !TEX program` / `% !TEX TS-program` → 项目记忆 → XeLaTeX / 已安装引擎的顺序选择。实时预览固定使用 LuaLaTeX，切换预览不会改正式编译引擎。

项目设置支持输出目录、中间产物目录、输出文件名、编译后跟随源码光标，以及多个命名构建配方。配方列表使用 JSON 编辑，侧栏选择当前配方并记忆；默认项仍使用项目引擎驱动 latexmk。

```json
[
  {
    "name": "LuaLaTeX + latexmk",
    "tools": [
      {
        "command": "latexmk",
        "args": ["-lualatex", "-synctex=1", "-file-line-error", "-recorder", "-interaction=nonstopmode", "-outdir=%OUTDIR%", "%DOC%"]
      }
    ]
  }
]
```

工具可设置独立 `cwd` 和 `env`，支持 `%DOC%`、`%DOCFILE%`、`%DIR%`、`%OUTDIR%`、`%AUXDIR%`、`%JOBNAME%`。占位符含义与执行约束见后端文档。项目设置是本机偏好；已有 `.latexmkrc` 继续由 latexmk 按自身规则读取。

## 自动编译与导航

自动编译按主文件合并请求，1 秒防抖；编译中继续编辑只留下尾随请求。显式重建不会被自动请求降级。依赖来自项目扫描与所选产物目录的 `.fls`，同时保留 `.bib`；编译中间产物不会反过来触发构建循环。切换 Vault 清除待触发的旧项目请求。

编辑器工具栏的定位按钮或 `Mod-Alt-j` 将源码光标定位到 PDF；PDF 中修饰键点击跳回源码，包含章节文件。定位处理缩放、旋转页、分屏和异步加载；编译后跟随只作用于新产物版本，关闭时不会抢走阅读位置。自定义输出 PDF 的 `texRoot` 随工作区布局持久化。

## 写作辅助

- `\cite{}` 搜索整项目 bibliography，按 key、标题和作者过滤；同时识别 `.tex` 中 `thebibliography` 的 `\bibitem`，用于补全、预览与定义跳转。
- `\ref{}` 等引用搜索所有章节的标签；F12 或修饰键点击打开定义。`\href` 的 URL 与 `\hyperref` 的显示文字不会被当成 label。
- 悬停公式、标签引用和文献引用显示预览；公式使用 KaTeX，完整排版以编译 PDF 为准。
- 大纲内联章节文件中的标题，并列出图、表、标签；点击章节定位，点击 include 文件行打开对应子文件。
- 工具栏的论文库引用入口可以搜索当前 Vault 论文，写入项目 bibliography 并插入 citation key；按 DOI / arXiv / 标题去重，处理 key 冲突。已声明但不存在的 `.bib` 会按声明创建；没有声明时添加必要的 bibliography 接入代码。
- 保存成功或外部 `.tex` / `.bib` 变化会刷新项目索引与大纲；格式化入口已按产品决定移除。

## 代码入口与验证

`lib/tex/config.ts` 保存项目偏好；`build-queue.ts` / `auto-build.ts` 负责调度；`build-state.ts` 汇总构建输出；`project-index.ts` 提供补全、引用跳转与大纲共享的项目索引；`synctex.ts` 负责源码与 PDF 导航。UI 入口是 `latex-panel.tsx`、`latex-build-log.tsx`、`text-editor-lint-footer.tsx` 与 `tex-citation-picker.tsx`。

```bash
pnpm exec vitest run test/tex-*.test.ts test/pdf-reload-position.test.ts
pnpm typecheck
```

当前以本机桌面项目为范围。TeX 宏展开生成的动态路径与完整包语义仍以实际编译结果为准；实时预览的字体、分页和全文搜索限制见 [../backend/rtex.md](../backend/rtex.md)。
