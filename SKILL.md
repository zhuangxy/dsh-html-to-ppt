---
name: html-to-ppt
description: 把 16:9 的 HTML 幻灯片转成 PowerPoint（.pptx）。当用户说"帮我转成 ppt"、"导出 ppt"、"做成幻灯"、"html 转 ppt"、"生成 PPT" 且上下文中有 16:9 HTML 幻灯片文件时使用。调用 html_to_ppt 工具完成渲染与合成。
whenToUse: 用户要求把 HTML 页面/幻灯片变成 PPT、或提到把刚才的 HTML 画面放进演示文稿时。
---

# HTML 转 PPT

把 16:9 的 HTML 幻灯片文件渲染成高清大图，再一页一页组成 PowerPoint。执行靠 `html_to_ppt` 工具，本技能只负责判断何时用、怎么选参数。

## 何时使用

用户在对话里说"帮我转成 ppt"、"导出成 PPT"、"生成演示文稿"、"把这几页 HTML 做成幻灯"，并且工作区里能找到 16:9 的 HTML 幻灯片文件。

不适用：用户要的是图片（PNG/JPG）而非 PPT；用户给的是 Word/Excel/PDF 而非 HTML；要生成的是可编辑文字排版（本技能产出的是整页图片，文字不可在 PPT 内编辑）。

## 先找到 HTML 文件

`html_to_ppt` 的 `htmls` 是**必填**的。用户没有明确给路径时，先自己找：

1. 看用户明确提到的文件。
2. 否则在近期改动过的目录里找 16:9 的 HTML，例如：
   `grep -l "16x9" path/**/*.html` 或按修改时间列举 `*.html`。
3. 找到多个候选时列出文件名让用户确认，不要擅自猜测顺序。

一个文件 = 一页幻灯片，顺序即参数数组顺序。

## 调用

```json
{
  "htmls": ["slides/01-white.html", "slides/02-warm.html"],
  "scale": 2
}
```

| 参数 | 默认 | 何时调整 |
| --- | --- | --- |
| `htmls` | 必填 | 16:9 HTML，按演示顺序每张一页 |
| `output` | `<首个文件名>.pptx` | 用户指定了输出路径或文件名时 |
| `scale` | 2 | 用户嫌糊/要更高清 → 3 或 4；文件太大 → 1 |
| `width`/`height` | 1600/900 | 幻灯片本来就是别的 16:9 尺寸时（如 1920×1080） |
| `chromePath`/`pythonPath` | 自动 | 工具报"找不到浏览器/Python"时再显式指定 |

`scale: 2` 配合默认视口产出 3200×1800 图片，投影全屏足够清晰。用户抱怨过模糊时直接提到 3。

## 注意

- HTML 内容应能容纳在对应视口内；内容超出的部分不会被裁切进图片。
- 每个 HTML 用自己的 file:// 原地渲染，页面内相对路径资源（如 `assets/logo.png`）会自动生效——不要把 HTML 复制到临时目录再渲染，那会让相对资源失效。
- 生成后如用户要预览，可用 `office_render` 渲染 pptx 页面（需先加载 `office` 技能）。

## 失败时

- "找不到 Chromium 浏览器" → 提示用户安装 Chrome，或传 `chromePath`。
- "找不到带 python-pptx 的 Python" → 传 `pythonPath`，指向 DSH 内置运行时：
  `~/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/python/bin/python3`
