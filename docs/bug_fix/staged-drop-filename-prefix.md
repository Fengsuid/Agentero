# 无路径拖放的 PDF 标题/目录名带暂存前缀（#801）

**状态**：已修复
**影响面**：macOS WKWebView 等拖放事件拿不到 `File.path` 的导入路径（拖到窗口任意区域、魔棒多选直选）。在后台识别完成前或识别未命中时，论文标题、paper id、目录名与主 PDF 文件名都会带上 Host 暂存前缀。
**相关代码**：

- `crates/agentero-core/src/features/paper/import/mod.rs` — `stage_import_file`（暂存）、`import_one_local_pdf`（派生标题/id）、新增 `import_staging_dir` / `is_import_staging_path` / `strip_staged_drop_prefix` / `import_metadata_stem`
- 前端入口：`src/lib/shell/external-file-drop.ts` — `resolveDroppedPdfPaths` 暂存字节；`isImportTempPath` / `cleanupImportTempPaths` 负责导入后清理
- `src/lib/paper/import-actions.ts` — `dropLocalPdfs` 只把暂存路径作为 `{ filePath }` 交回 Host，不携带原始文件名/标题
- 文档：[`../backend/api.md`](../backend/api.md) § `paper_stage_import_file`

---

## 1. 问题现象

Issue #801（translator 有奇怪前缀）：拖入 PDF 后，论文标题、目录名和 PDF 文件名变成 `1792563636997-a5e60013-Differentiated Treatment….pdf` 这类形态。用户从未这样命名文件，也看不出前缀含义。

## 2. 根因

macOS WKWebView 的 OS 拖放不暴露 `File.path`，前端只能把文件字节交给 Host 暂存：`stage_import_file` 写入

```text
~/.agentero/import-tmp/<epoch 毫秒>-<uuid8>-<原文件名>
```

并把这个**暂存路径**作为 `entries[].filePath` 交回 `paper_import_local_pdf`（`dropLocalPdfs` 只传 `{ filePath }`，不带原始标题）。`import_one_local_pdf` 用 `src.file_stem()` 派生标题与基础 id（`title_from_stem` / `slug_from_stem`），暂存前缀因此进入了用户可见的元数据。以拖入 `Differentiated Treatment.pdf` 为例：

| 位置 | 修复前 | 修复后 |
|---|---|---|
| 标题 | `1792563636997-a5e60013-Differentiated Treatment` | `Differentiated Treatment` |
| paper id / 目录 | `papers/1792563636997-a5e60013-Differentiated-Treatment` | `papers/Differentiated-Treatment` |
| 主 PDF 文件 | `papers/1792563636997-a5e60013-Differentiated-Treatment/1792563636997-a5e60013-Differentiated-Treatment.pdf` | `papers/Differentiated-Treatment/Differentiated-Treatment.pdf` |

主 PDF 固定为 `{id}.pdf`，因此 id 变干净后 PDF 文件名同步变干净。

Issue 里的文件名前缀 `1792563636997` 是 epoch 毫秒值，换算为 2026-10-21 06:20:36 UTC，与 issue 评论时间 06:21:34Z 吻合，确认来自该暂存路径。

后台 `RecognizeMetadata` 命中标识符后会把目录改名为规范 id（如 `1706.03762`），但识别完成前、以及识别未命中时，前缀会长期留在论文库里。

## 3. 修复

只改 Host（`agentero-core`），前端与暂存目录布局保持不变（因此 `isImportTempPath` / `cleanupImportTempPaths` 的清理逻辑无需调整）：

- **`import_staging_dir()`** 统一解析 `~/.agentero/import-tmp`，`stage_import_file` 也复用它，暂存位置与识别逻辑不会漂移。
- **`strip_staged_drop_prefix(stem)`** 只剥离精确的 `^[0-9]{13}-[0-9a-f]{8}-` 前缀（13 位毫秒 + `-` + 8 位小写十六进制 + `-`）。大小写不符、位数不符、缺少分隔符、前缀后无内容时都原样返回，`1706.03762`、`10.1038-nature12373` 等普通文件名不受影响。
- **`is_import_staging_path(path, staging_dir)`** + **`import_metadata_stem(path, staging_dir)`**：仅当源路径确实位于暂存目录内时才剥离；用户目录里长得一样的文件名被视为真实文件名，保持原样。PDF 内容仍从真实暂存路径读取/复制，导入行为不变。
- 修复只作用于之后的新导入；已入库的旧条目不会被追溯改名，需要等后台识别命中，或通过 Edit Metadata 手动修正。

## 4. 验证

- `cargo test -p agentero-core --lib features::paper::import` — 132 passed，含新增单测：暂存 stem 剥离后得到干净 title/slug、近似模式（大写十六进制/12 位毫秒/7 位 hex/缺分隔符/仅前缀）不变、仅暂存目录内剥离而用户目录同名文件保留。
- `cargo clippy -p agentero-core --all-targets -- -D warnings`、`cargo fmt --all -- --check`。
