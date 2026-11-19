# dsh-html-to-ppt

A [DeepSeek Harness](https://github.com/deepseek-ai) plugin that turns 16:9 HTML slides into a PowerPoint deck.

It registers one agent tool, `html_to_ppt`:

1. renders each HTML file to a high-resolution image (exact 16:9 CSS viewport × a device-scale factor),
2. places one image full-bleed on each 16:9 slide,
3. saves a real `.pptx` built with `python-pptx`.

## Requirements

- Node 22+ (the plugin uses the built-in WebSocket to drive headless Chrome over CDP).
- A Chromium-based browser (Chrome, Chromium, or Edge). Auto-detected; override with `chromePath` or `CHROME_PATH`.
- A Python interpreter with the `python-pptx` package. Auto-detected — including the Python runtime DSH bundles for its own Office tools; override with `pythonPath` or `DSH_HTML_TO_PPT_PYTHON`.

## Install

Install the bundle from this directory through **Plugins → Add plugin**, or let an agent run
`plugin_manager` with `install_bundle` and this directory as the target.

## Usage

Ask the agent to convert HTML slides, or call the tool directly:

```json
{
  "htmls": ["slides/01.html", "slides/02.html"],
  "output": "deck.pptx",
  "scale": 2
}
```

| Parameter | Default | Meaning |
| --- | --- | --- |
| `htmls` | — | 16:9 HTML files, one per slide, in presentation order. |
| `output` | `<first>.pptx` | Output path, next to the first HTML unless absolute. |
| `scale` | 2 | Resolution multiplier: image is `width×scale` by `height×scale` px. |
| `width` / `height` | 1600 / 900 | CSS viewport (16:9). |
| `chromePath` / `pythonPath` | auto | Explicit browser / Python interpreter. |

Example with the slides in this repo: 1600×900 at `scale: 2` yields 3200×1800 images inside a
13.333″ × 7.5″ deck, which stays sharp on a full-screen projector.

## How it works

The plugin starts a headless Chromium with a DevTools port and drives it over the Chrome DevTools
Protocol. `Emulation.setDeviceMetricsOverride` sets the CSS viewport *exactly*, so slides that scale
themselves from `window.innerHeight` stay full-canvas without the bottom band that `--screenshot`
leaves; `deviceScaleFactor` then supplies the extra resolution. Each HTML is rendered in place via
its own `file:` URL, so relative assets (logos, images) resolve normally.

## Notes

- Inputs are expected to be 16:9 slides whose content fits the viewport.
- Images are embedded at full resolution; lower `scale` if deck size matters.

## License

MIT
