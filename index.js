/**
 * dsh-html-to-ppt — turn 16:9 HTML slides into a PowerPoint.
 *
 * Model-facing tool `html_to_ppt`: for each 16:9 HTML file it renders the page
 * at an exact CSS viewport (width×height) scaled by a device-scale factor into
 * a high-resolution PNG, then assembles one full-bleed 16:9 slide per image
 * into a .pptx with python-pptx.
 *
 * Rendering is driven through the Chrome DevTools Protocol over the runtime's
 * built-in WebSocket (Node 22+) so the CSS viewport is exact
 * (`Emulation.setDeviceMetricsOverride` sets `window.innerHeight` precisely),
 * which keeps JS-fitted slide layouts full-canvas with no cropping. Relative
 * assets resolve because each file is rendered in place via its file: URL.
 *
 * Dependencies at runtime (resolved automatically unless overridden in
 * parameters/config):
 *   - a Chromium-based browser for headless rendering,
 *   - a Python interpreter with the python-pptx package.
 *
 * No third-party npm packages are required.
 * @module dsh-html-to-ppt
 */

import { execFile, spawn } from 'node:child_process'
import { mkdtemp, writeFile, rm, access, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve, isAbsolute, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'dsh-html-to-ppt'
/** the tools service grants the `ctx.tools` registry used to expose the agent tool. */
export const inject = ['tools']

/**
 * Runtime configuration with sensible defaults; all values are overridable per call.
 * @typedef {Object} Config
 * @property {number} [scale] Default device-scale factor (image resolution multiplier).
 * @property {number} [width] Default CSS viewport width.
 * @property {number} [height] Default CSS viewport height.
 * @property {string} [chromePath] Headless browser executable; auto-detected when omitted.
 * @property {string} [pythonPath] Python interpreter with python-pptx; auto-detected when omitted.
 * @property {number} [settleMs] Frames to wait after load before capture.
 */

export const Config = z.object({
  scale: z.natural().min(1).max(16).default(2),
  width: z.natural().min(320).max(16384).default(1600),
  height: z.natural().min(180).max(16384).default(900),
  chromePath: z.string().required(false),
  pythonPath: z.string().required(false),
  settleMs: z.natural().min(0).max(60_000).default(1200),
})

/** A tiny CDP client over one WebSocket connection. */
class CdpSession {
  #counter = 0
  #pending = new Map()
  #events = new Map()
  constructor(ws) {
    this.ws = ws
    ws.addEventListener('message', (event) => {
      let msg
      try { msg = JSON.parse(String(event.data)) } catch { return }
      if (msg.id !== undefined) {
        const p = this.#pending.get(msg.id)
        if (!p) return
        this.#pending.delete(msg.id)
        if (msg.error) p.reject(new Error(`CDP ${msg.error.message}`))
        else p.resolve(msg.result)
      } else if (msg.method) {
        const list = this.#events.get(msg.method)
        if (list) for (const h of [...list]) h(msg.params)
      }
    })
  }
  send(method, params = {}, sessionId) {
    const id = ++this.#counter
    return new Promise((resolveFn, reject) => {
      this.#pending.set(id, { resolve: resolveFn, reject })
      this.ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }))
    })
  }
  once(method, timeoutMs) {
    return new Promise((resolveFn) => {
      const list = this.#events.get(method) ?? []
      const timer = setTimeout(() => {
        const i = this.#events.get(method)?.indexOf(handler)
        if (i !== undefined && i >= 0) this.#events.get(method).splice(i, 1)
        resolveFn()
      }, timeoutMs)
      const handler = (params) => { clearTimeout(timer); resolveFn(params) }
      list.push(handler)
      this.#events.set(method, list)
    })
  }
  close() { try { this.ws.close() } catch { /* ignore */ } }
}

/** Resolve each parameter/environment/config option in order; first defined wins. */
function pick(...values) {
  for (const v of values) if (v !== undefined && v !== null && v !== '') return v
  return undefined
}

function defaultChromeCandidates() {
  const list = []
  if (process.platform === 'darwin') {
    list.push(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    )
  } else if (process.platform === 'win32') {
    list.push(
      process.env.PROGRAMFILES ? join(process.env.PROGRAMFILES, 'Google/Chrome/Application/chrome.exe') : '',
      process.env['PROGRAMFILES(X86)'] ? join(process.env['PROGRAMFILES(X86)'], 'Google/Chrome/Application/chrome.exe') : '',
      process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe') : '',
    )
  } else {
    list.push('/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser')
  }
  return list.filter(Boolean)
}

async function resolveChrome(explicit) {
  const fromEnv = pick(process.env.DSH_HTML_TO_PPT_CHROME, process.env.CHROME_PATH, process.env.PUPPETEER_EXECUTABLE_PATH)
  const candidates = [explicit, fromEnv, ...defaultChromeCandidates()]
  for (const c of candidates) {
    if (!c) continue
    if (!isAbsolute(c)) return c // bare command name; PATH resolves it at launch
    try { await access(c) } catch { continue }
    return c
  }
  throw new Error('html_to_ppt: no Chromium browser found. Pass chromePath or set CHROME_PATH/PUPPETEER_EXECUTABLE_PATH.')
}

/** Expand python3 launchers under the DSH runtimes directory. */
async function dshRuntimePythons() {
  const { readdir } = await import('node:fs/promises')
  const home = process.env.HOME
  if (!home) return []
  const roots = [join(home, '.dsh', 'dsh-runtimes')]
  // A profile directory may sit under the same ~/.dsh tree; include any sibling runtimes root.
  const profileDir = process.env.DSH_PROFILE_DIR
  if (profileDir && !profileDir.startsWith(roots[0])) {
    const parent = dirname(dirname(profileDir))
    const candidate = join(parent, 'dsh-runtimes')
    if (candidate !== roots[0]) roots.push(candidate)
  }
  const found = []
  for (const root of roots) {
    let runtimes = []
    try { runtimes = await readdir(root) } catch { continue }
    for (const runtime of runtimes) {
      const candidate = join(root, runtime, 'dependencies', 'python', 'bin', 'python3')
      try { await access(candidate) } catch { continue }
      found.push(candidate)
    }
  }
  return found
}

async function resolvePython(explicit) {
  const env = pick(process.env.DSH_HTML_TO_PPT_PYTHON, process.env.PYTHON)
  const bundled = await dshRuntimePythons()
  const candidates = [explicit, env, ...bundled, 'python3', 'python'].filter(Boolean)
  for (const c of candidates) {
    if (await hasPptx(c)) return c
  }
  throw new Error('html_to_ppt: no Python interpreter with the python-pptx package found. Pass pythonPath, install python-pptx, or set DSH_HTML_TO_PPT_PYTHON.')
}

/** Return true if cmd is a working Python that can import python-pptx. */
function hasPptx(cmd) {
  return new Promise((res) => {
    execFile(cmd, ['-c', 'import pptx'], { timeout: 15_000 }, (err) => res(err === null))
  })
}

/** Spawn headless Chrome with a DevTools port; resolves with the browser WebSocket URL and the child process. */
async function launchCdpChrome(chromePath, userDataDir) {
  return new Promise((resolveFn, reject) => {
    const args = [
      '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
      `--user-data-dir=${userDataDir}`, '--remote-debugging-port=0', 'about:blank',
    ]
    const child = spawn(chromePath, args, { stdio: ['ignore', 'ignore', 'pipe'] })
    let wsUrl
    let stderr = ''
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('html_to_ppt: timed out launching Chrome.')) }, 20_000)
    child.stderr.on('data', (buf) => {
      stderr += buf.toString()
      const m = /DevTools listening on (ws:\/\/[^\s]+)/.exec(stderr)
      if (m && !wsUrl) {
        wsUrl = m[1]
        clearTimeout(timer)
        resolveFn({ wsUrl, child })
      }
    })
    child.once('error', (err) => { clearTimeout(timer); reject(new Error(`html_to_ppt: failed to launch Chrome: ${err.message}`)) })
    child.once('exit', (code) => {
      if (!wsUrl) { clearTimeout(timer); reject(new Error(`html_to_ppt: Chrome exited early (${code}).`)) }
    })
  })
}

function urlFromPath(p) {
  const abs = resolve(p)
  // Paths with non-ASCII or spaces round-trip through the WHATWG URL.
  return pathToFileURL(abs).href
}

/** Render one HTML file to a PNG at (width×height)×scale via CDP. */
async function renderSlide(chromePath, userDataDir, htmlPath, width, height, scale, settleMs, outPng) {
  const { wsUrl, child } = await launchCdpChrome(chromePath, userDataDir)
  let ws
  try {
    ws = new WebSocket(wsUrl)
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true })
      ws.addEventListener('error', () => rej(new Error('html_to_ppt: could not connect to Chrome DevTools.')), { once: true })
    })
    const cdp = new CdpSession(ws)
    try {
      const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' })
      const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true })
      // All future commands target this page session; keep sessionId at the message top level.
      const send = (method, params = {}) => cdp.send(method, params, sessionId)
      await send('Page.enable')
      await send('Emulation.setDeviceMetricsOverride', {
        width, height, deviceScaleFactor: scale, mobile: false,
        screenWidth: width, screenHeight: height,
      })
      const load = cdp.once('Page.loadEventFired', Math.max(settleMs + 5000, 7000))
      await send('Page.navigate', { url: urlFromPath(htmlPath) })
      await load
      await new Promise((r) => setTimeout(r, settleMs))
      const { data } = await send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false })
      await writeFile(outPng, Buffer.from(data, 'base64'))
      return outPng
    } finally {
      cdp.close()
    }
  } finally {
    // Always reap the browser, even when CDP or the page failed.
    try { ws?.close() } catch { /* ignore */ }
    try { child.kill('SIGKILL') } catch { /* ignore */ }
  }
}

function execFileAsync(cmd, args, opts = {}) {
  return new Promise((res, rej) => {
    execFile(cmd, args, opts, (err, stdout, stderr) => {
      if (err) rej(new Error(`${stderr?.trim() || err.message}`))
      else res(stdout)
    })
  })
}

/** Invoke the bundled python-pptx builder. */
async function buildPptx(pythonPath, scriptPath, images, output, slideWidth, slideHeight) {
  await execFileAsync(pythonPath, [
    scriptPath, '--output', output, '--width', String(slideWidth), '--height', String(slideHeight), ...images,
  ], { timeout: 120_000, maxBuffer: 8 * 1024 * 1024 })
}

export function apply(ctx, config = {}) {
  ctx.tools.register(defineTool({
    name: 'html_to_ppt',
    description: 'Render one or more 16:9 HTML slide files into high-resolution images and assemble them into a PowerPoint (.pptx), one full-bleed slide per HTML file. '
      + 'The plugin captures each HTML at an exact 16:9 viewport (default 1600×900) scaled by a device-scale factor (default 2 → 3200×1800) so text stays sharp when the deck is played full-screen. '
      + 'Relative assets inside each HTML resolve automatically because files are rendered in place. '
      + 'The output is a real PowerPoint you can open and edit.',
    parameters: {
      htmls: {
        type: 'array', items: { type: 'string' }, required: true,
        description: 'Absolute or workspace-relative paths to the 16:9 HTML files, one per slide in presentation order.',
      },
      output: {
        type: 'string',
        description: 'Output .pptx path. Defaults to "<first-html-basename>.pptx" next to the first HTML.',
      },
      scale: {
        type: 'integer',
        description: 'Resolution multiplier from 1 to 16: each page is captured at viewport×(this). Higher values are sharper but make larger files. Default 2.',
      },
      width: { type: 'integer', description: 'CSS viewport width (16:9), 320–16384. Default 1600.' },
      height: { type: 'integer', description: 'CSS viewport height (16:9), 180–16384. Default 900.' },
      chromePath: { type: 'string', description: 'Optional Chromium executable path. Auto-detected when omitted.' },
      pythonPath: { type: 'string', description: 'Optional Python interpreter that has python-pptx. Auto-detected when omitted.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          output: { type: 'string', required: true, description: 'Absolute path of the generated .pptx.' },
          slides: { type: 'integer', required: true, description: 'Number of slides produced.' },
          resolution: { type: 'string', required: true, description: 'Pixel size of each embedded image, e.g. "3200×1800".' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `Built ${value.slides} slide(s) at ${value.resolution} → ${value.output}` }],
      presentationMeta: (_args, value) => ({ output: value.output, slides: value.slides, resolution: value.resolution }),
    },
    async execute(args, exec) {
      const scale = args.scale ?? config.scale ?? 2
      const width = args.width ?? config.width ?? 1600
      const height = args.height ?? config.height ?? 900
      const settleMs = config.settleMs ?? 1200
      const chromePath = await resolveChrome(args.chromePath ?? config.chromePath)
      const pythonPath = await resolvePython(args.pythonPath ?? config.pythonPath)
      const sources = []
      for (const raw of args.htmls) {
        const abs = resolve(raw)
        try { await access(abs) } catch {
          throw new Error(`html_to_ppt: cannot read "${raw}": not found`)
        }
        sources.push(abs)
      }
      const firstDir = dirname(sources[0])
      const stem = basename(sources[0]).replace(/\.[^.]+$/, '')
      const output = args.output
        ? (isAbsolute(args.output) ? args.output : resolve(firstDir, args.output))
        : join(firstDir, `${stem}.pptx`)
      await mkdir(dirname(output), { recursive: true })
      const dir = await mkdtemp(join(tmpdir(), 'html-to-ppt-'))
      try {
        const images = []
        for (let i = 0; i < sources.length; i++) {
          const out = join(dir, `slide-${i + 1}.png`)
          await renderSlide(chromePath, join(dir, `chrome-${i}`), sources[i], width, height, scale, settleMs, out)
          images.push(out)
        }
        const scriptPath = fileURLToPath(new URL('./scripts/build_pptx.py', import.meta.url))
        // Slide geometry: 13.333" × 7.5" inches (16:9).
        await buildPptx(pythonPath, scriptPath, images, output, 13.333, 7.5)
        return {
          output,
          slides: images.length,
          resolution: `${width * scale}×${height * scale}`,
        }
      } finally {
        // The .pptx embeds the images; the temporary render directory is disposable.
        await rm(dir, { recursive: true, force: true }).catch(() => {})
      }
    },
  }))
}

/** Best-effort path projection for the result (platform separator normalization). */
function processPath(p) { return p }
