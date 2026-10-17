# Windows 触控板无法捏合缩放论文

## 原因

PDF 原先已有 Ctrl/Cmd+wheel 与 WebKit gesturestart/change/end 处理，但 Windows
精准触控板捏合没有进入页面。Tauri/Wry 默认的 `zoom_hotkeys_enabled=false`
同时调用 WebView2 的 `SetIsZoomControlEnabled(false)` 与
`SetIsPinchZoomEnabled(false)`。后者会在原生层关闭捏合识别，前端单独增加
wheel 监听无效。

源码依据：[Wry WebView2 settings](https://github.com/tauri-apps/wry/blob/dev/src/webview2/mod.rs)。
微软说明 [IsPinchZoomEnabled](https://learn.microsoft.com/en-us/dotnet/api/microsoft.web.webview2.core.corewebview2settings.ispinchzoomenabled)
控制原生 Page Scale，独立于布局缩放和 ZoomFactor。

## 修复

- Windows-only Tauri 插件在所有 WebView 创建时仅开启原生捏合识别，不开启
  整窗 Ctrl+/- 快捷键缩放。主窗口、新窗口与文档弹出窗口走同一插件。
- 同一插件在页面及 iframe 初始化时注入 capture wheel guard。合成 Ctrl+wheel 进入
  PDF 前先取消原生 Page Scale，因此 PDF 外的捏合、普通滚动期间 listener
  处于 passive 时的首个捏合 tick 都不会误放大应用。
- Guard 常驻 non-passive，但仅处理事件，不改布局或 React 状态；普通滚动
  不 preventDefault。该 Windows 平台取舍在前端 PDF 文档中明确记录。
- 记录实体 Ctrl 按键与失焦状态，用像素增量和幅度上限标记精准触控板事件。
  PDF 按 Chromium 的 `-100 * ln(scale)` 还原捏合倍率，Ctrl+鼠标滚轮继续走
  原先较慢的比例，避免一格滚轮直接跳到缩放上限。
- 复用已有 CSS 预览、50%–300% 限制、手势锚点与静默后一次真实 zoom 提交，
  不新增 PDF 缩放状态。WebKit 路径与移动端不启用这个 Windows 插件。

## 验证

使用本机真实 WebView2、Wry 0.55.1，DevTools Protocol
`Input.synthesizePinchGesture(gestureSourceType="mouse")` 注入 Chromium 的
touchpad pinch 输入。测试页面载入生产 guard 与编译后的 `bindZoomGesture`：

| 场景 | 观察 |
|---|---|
| 原生捏合关闭 | wheel 数为 0，PDF 比例保持 1 |
| 开启识别并启用生产脚本，捏合 1.7 | PDF 比例约 1.7，一次 start / end，整窗 scale 仍为 1 |
| 捏合 0.7 | PDF 比例约 0.7，整窗 scale 仍为 1 |
| 先普通 wheel，再捏合 | PDF 比例约 1.7，首个 passive tick 不泄漏整窗缩放 |
| PDF 外捏合（含嵌入 iframe） | 没有 PDF 缩放回调，整窗 scale 仍为 1 |
| 实体 Ctrl + 一格鼠标 wheel（-120） | PDF 比例约 1.1275，保持缓慢步进 |

前端回归覆盖 guard、原生倍率、鼠标与实体 Ctrl、普通滚动、WebKit gestures、
缩放数学与双栏同步。该测试是 Windows 原生引擎中的合成手势测试，尚不等于
完整 Agentero GUI 流程或实体触控板实测；老式驱动若模拟键盘 Ctrl+滚轮，会
按兼容的鼠标滚轮路径处理。
