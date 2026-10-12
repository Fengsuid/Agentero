# 缩放后批注高亮与字形错位

**影响面**：带 `/Rotate`（或阅读器旋转）的 PDF 页上的文字高亮、划词底色，以及缩放后的点击命中。

## 现象

放大或缩小之后，批注高亮不再盖住被划中的文字，偏差随缩放变大。正立页面（旋转为 0）没有这层错位。

## 原因

页框按旋转后的显示尺寸排版，瓦片用 `transformRect` 把未旋转的屏幕矩形旋进这个页框。高亮和划词底色仍按 `origin * scale` 画在未旋转的内容空间里，所在的 `PagePointerProvider` 也是未旋转尺寸、贴在页框左上角。旋转为 0 时两者重合；旋转不为 0 时高亮留在侧躺的盒子里，而字形已经转正，缩放把这条缝拉开。

高亮本身没有 `noZoom`。滚轮期间的 CSS 预览会在松手后清掉，不是错位留下来的原因。

## 修复

- `unrotatedPageFrameTransform` 用与 `transformRect` / `transformPosition` 相同的 CSS matrix，只在旋转不为 0 时包住高亮层、划词底色和文字批注的强调层。正立页直接渲染子节点，不多一层 DOM。
- 点击命中先取页框上的比例，再经 `restorePosition` 回到未旋转页的比例，因此点在字形上仍能命中高亮。旋转为 0 时比例原样返回，滚轮预览期间的命中不变。

## 验证

```bash
pnpm exec vitest run test/pdf-page-frame.test.ts
```

矩阵把高亮矩形的四角变到与 `transformRect(..., rotation, 1)` 相同的包围盒；`shellFractionToUnrotatedPdf` 是 `transformPosition` 的逆。
