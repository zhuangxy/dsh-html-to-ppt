# HTML to PPT

把 16:9 比例的 HTML 幻灯片（可多张）先渲染成高清大图，再一页一页放进 PowerPoint（`.pptx`）。

## 用法

调用工具 `html_to_ppt`：

- `htmls`：一个或多个 16:9 HTML 文件路径，按演示顺序每张一页。
- `output`（可选）：输出 `.pptx` 路径，默认生成在第一个 HTML 旁边。
- `scale`（可选，默认 2）：分辨率倍数，图片尺寸 = 视口 × scale。
- `width` / `height`（可选，默认 1600×900）：CSS 视口尺寸（16:9）。
- `chromePath` / `pythonPath`（可选）：手动指定浏览器 / Python。

## 原理

- 用无头浏览器按**精确** CSS 视口（`width × height`）渲染每个 HTML，再乘以 `scale` 得到高清图片，因此 JS 自动缩放型幻灯片也能保持满幅、不裁切、不模糊。
- 在 HTML 原目录就地渲染，页面内相对路径资源（如图片、logo）自动生效。
- 用 python-pptx 生成 13.333" × 7.5"（16:9）的 PPT，每个 HTML 独占一页满幅图。

## 依赖

- 一个可用的 Chromium 内核浏览器（自动探测，或用 `chromePath` / `CHROME_PATH` 指定）。
- 装有 `python-pptx` 的 Python（自动探测 DSH 内置运行时，或用 `pythonPath` 指定）。

## 注意

- 设计为 16:9 幻灯片，内容应能容纳在对应视口内。
- 图片按高清图内嵌到 PPT；若图片过大可降低 `scale` 以控制文件体积。
