# LaTeX 编译与项目服务

正式构建由 `src-tauri/src/features/compile/` 实现，继续使用 JobCenter 的 `LatexCompile` 任务。实时预览是独立的 LuaLaTeX 会话，见 [rtex.md](rtex.md)。前端交互见 [../frontend/latex.md](../frontend/latex.md)。

## 模块和契约

| 模块 | 职责 |
|---|---|
| `mod.rs` | 引擎发现、ChkTeX、兼容旧清理命令、任务 runner 注册 |
| `root.rs` | magic root、主文件标记、反向 include 图、subfiles 父文件发现 |
| `project.rs` | 章节与 bibliography 递归扫描、候选主文件、合并 recorder 依赖 |
| `types.rs` | Recipe / Tool / BuildOptions、输出与中间产物路径计算 |
| `runner.rs` | 顺序执行配方、构建日志、进度、取消、结果发布 |
| `diagnostics.rs` | 编译诊断、章节文件栈、跨行警告、`.fls` INPUT 解析 |
| `tools.rs` | SyncTeX、格式化、配置产物清理、子进程环境 |

`job_latex_compile_enqueue` 的 `build` 为可选项，旧 `{ engine }` 调用仍有效。它接受 recipe、outDir、auxDir、jobname、force、clean。任务层 `force` 控制已结束任务的去重；`build.force` 才表示强制重建，两者不能混用。

`src/lib/tex/host.ts` 提供前端类型和调用包装。所有新 command 注册在 `app/handlers.rs` 与 `app/bindings_test.rs`；Rust 签名变更后运行：

```bash
AGENTERO_UPDATE_BINDINGS=1 cargo test -p agentero export_typescript_bindings
```

## 构建行为

默认配方通过 latexmk 调用 PDFLaTeX / XeLaTeX / LuaLaTeX，启用 `-file-line-error`、`-synctex=1`、`-recorder`、nonstopmode 和 halt-on-error。普通构建保留 latexmk 增量判断；force 增加 `-g`；clean 先清理可再生产物再重建，保留已有 PDF。

自定义 recipe 是顺序执行的工具列表。每个工具有 command、独立 argv、可选 env 和 cwd；不把 argv 拼成 shell 命令。支持：

| 占位符 | 值 |
|---|---|
| `%DOC%` | 主文件绝对路径，包含 `.tex` |
| `%DOCFILE%` | 主文件名，包含扩展名 |
| `%DIR%` | 主文件目录 |
| `%OUTDIR%` / `%AUXDIR%` | 解析后的输出 / 中间产物目录 |
| `%JOBNAME%` | 产物文件名，不含扩展名 |

相对 cwd、可执行文件、输出参数按同一工具上下文解析。兼容的编译器步骤会接收项目显式输出参数；任意 helper 工具保留原参数。直接 TeX 引擎不支持分离 aux 时明确报错，建议使用 latexmk。

产物路径统一由 `latex_build_artifacts` 计算。PDF 与 `.synctex.gz` 位于输出目录，`.fls` 与 `*.agentero.log` 位于 aux 目录；`*.agentero.log` 保存整条配方的输出，不覆盖引擎自己的 `.log`。自定义工具需要让参数与声明的产物布局一致。

## 日志与诊断

- `compile:log`：jobId、rootPath、line。
- `compile:finished`：jobId、rootPath、success、PDF / log / SyncTeX 路径、dependencies、diagnostics。
- 每条诊断包含 path、1 起始的 line / column、severity、message、source。

无 `file:line:` 前缀的警告借助 TeX 日志文件栈恢复章节归属。引擎日志补充 console 未输出的警告。取消既覆盖流式读取，也覆盖 stdout/stderr 关闭后的进程等待；Unix 使用独立进程组，Windows 使用隐藏进程与 `taskkill /T`。

`.fls` 表示引擎读取的真实文件，但通常没有 BibTeX/Biber 读取的 `.bib`。前端必须保留项目扫描得到的 bibliography 依赖，不能用 recorder 列表直接覆盖。

## 项目、SyncTeX 和格式化

`latex_project_inspect(texPath, vaultPath, rootPath?, build?)` 返回主文件、候选根、TeX 文件、BibTeX 文件和实际依赖。显式 root 可用于 standalone subfiles；build 参数决定读取哪份 `.fls`。普通 include 优先按项目编译目录解析，再尝试声明文件目录。

SyncTeX command 调用本机 `synctex`，返回页码、PDF 点坐标或源码文件 / 行 / 列；前端负责缩放与旋转转换，保持与 EmbedPDF 的坐标体系一致。

`latex_format` 通过 stdin 运行 `latexindent` 或 `tex-fmt`，只返回结果，不写源文件。超时、缺少工具、工具报错均返回错误；前端检查文档是否仍为请求时的快照后应用，避免覆盖并发编辑。

本地 TeX 工具由用户安装。正式构建、SyncTeX 和格式化属于本机桌面能力，不提供远程编译服务。

## 验证

```bash
cargo test -p agentero features::compile --lib
cargo test -p agentero app::events_contract --lib
cargo test -p agentero export_typescript_bindings --lib
```

回归覆盖参数注入、cwd 与相对路径、产物推导、章节诊断、配置后的 recorder、SyncTeX、subfiles 和管道关闭后的取消。跨平台发布仍走项目现有 CI。
