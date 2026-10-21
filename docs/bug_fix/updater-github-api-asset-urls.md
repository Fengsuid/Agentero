# 应用内更新安装一直失败（GitHub API asset URL 403）

**状态**：已修复（发布流水线改写 `latest.json` URL；已发布 tag 可用 workflow_dispatch 补修）
**影响面**：所有桌面端「设置 → 关于 → 检查更新 / 安装并重启」以及启动 Toast、标题栏「新版本」安装
**相关代码**：

- `scripts/rewrite-updater-latest.mjs` — 把 API asset URL 改写成 `browser_download_url`
- `.github/workflows/release.yml` — installer 矩阵结束后的 `updater-latest-urls` job
- `.github/workflows/rewrite-updater-latest.yml` — 按 tag 手动补修已发布 Release
- `src/lib/update/service.ts` — 检查/安装失败把插件错误写入 snapshot
- 文档：[`../frontend/settings.md`](../frontend/settings.md)、[`../test/release.md`](../test/release.md)

---

## 1. 问题现象

设置 → 关于点击检查更新后，再点「安装并重启」，Toast 一直是「无法安装更新，请重试」。检查清单本身能成功（能看到新版本）。

## 2. 根因

GitHub Release 的 `latest.json` 由 `tauri-apps/tauri-action` 写入，平台下载地址是：

```text
https://api.github.com/repos/poco-ai/Agentero/releases/assets/<id>
```

而不是公开的：

```text
https://github.com/poco-ai/Agentero/releases/download/vX.Y.Z/<file>
```

检查更新只拉 `releases/latest/download/latest.json`，不需要登录。安装时 updater 插件用 `Accept: application/octet-stream` 去拉 API asset URL；未带 GitHub token 时 GitHub 返回 **403 Forbidden**，签名校验/下载失败，于是每次安装都失败。

公开仓库对同一 API URL 的普通 JSON GET（无 `octet-stream`）可以拿到 metadata，其中的 `browser_download_url` 才是可匿名下载的地址。

## 3. 修复

1. 发布流水线在所有 installer job 之后改写并重新上传 `latest.json`。
2. 已发布的 tag 在 Actions 中运行 **Rewrite updater latest.json URLs**，填入例如 `v0.12.0`。
3. 失败 Toast 附带插件原始错误，避免只看到泛化的「请重试」。
