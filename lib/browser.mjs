// Chromium automation over the DevTools Protocol. Zero dependencies: the global
// WebSocket (Node 24) carries a single browser-level connection; page targets are
// attached with flattened sessions. No Playwright/Puppeteer.
import { spawn } from 'node:child_process'
import { mkdir, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { basename, dirname, join, resolve as resolvePath } from 'node:path'
import { AutomationError, asObject, parseJson, which, run, sleep, stamp } from './util.mjs'

/** Actions understood by `BrowserManager.run`. */
const ACTIONS = [
  'launch', 'connect', 'close', 'status', 'pages', 'new_page', 'select_page',
  'goto', 'back', 'forward', 'reload',
  'click', 'dblclick', 'hover', 'fill', 'type', 'press', 'select_option', 'check',
  'uncheck', 'scroll', 'wait_for', 'snapshot', 'eval', 'screenshot',
  'record_start', 'record_stop', 'console', 'network', 'dialog', 'viewport',
  'download_list', 'pdf',
]

const DEFAULT_VIEWPORT = { width: 1280, height: 800 }

const BROWSER_EXECUTABLES = {
  chrome: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  'google-chrome': '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  edge: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  'microsoft-edge': '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  chromium: '/Applications/Chromium.app/Contents/MacOS/Chromium',
  brave: '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  'brave-browser': '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
}

const MODIFIER_ALT = 1
const MODIFIER_CTRL = 2
const MODIFIER_META = 4
const MODIFIER_SHIFT = 8

const CONSOLE_LEVELS = {
  log: 'log',
  debug: 'debug',
  info: 'info',
  warning: 'warn',
  warn: 'warn',
  error: 'error',
  assert: 'assert',
  dir: 'log',
  dirxml: 'log',
  table: 'log',
  trace: 'trace',
  clear: 'log',
  startGroup: 'log',
  startGroupCollapsed: 'log',
  endGroup: 'log',
  profile: 'log',
  profileEnd: 'log',
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/**
 * @param {unknown} value
 * @param {number} fallback
 * @returns {number}
 */
function numberOr(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/**
 * @param {unknown} value
 * @param {number} min
 * @param {number} max
 * @param {number} fallback
 * @returns {number}
 */
function clampNumber(value, min, max, fallback) {
  const number = numberOr(value, fallback)
  return Math.min(max, Math.max(min, number))
}

/**
 * @param {unknown} value
 * @param {number} min
 * @param {number} max
 * @param {number} fallback
 * @returns {number}
 */
function clampInteger(value, min, max, fallback) {
  return Math.round(clampNumber(value, min, max, fallback))
}

/**
 * @returns {Promise<number>}
 */
async function findFreePort() {
  return await new Promise((resolve, reject) => {
    const server = createServer()
    server.unref()
    server.once('error', (error) => {
      server.close(() => reject(error))
    })
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = address !== null && typeof address === 'object' ? address.port : 0
      server.close(() => resolve(port))
    })
  })
}

/**
 * @param {string} wsUrl
 * @returns {number | null}
 */
function portFromWebSocketUrl(wsUrl) {
  try {
    const url = new URL(wsUrl)
    if (url.port !== '') return Number(url.port)
    return url.protocol === 'wss:' ? 443 : 80
  } catch {
    return null
  }
}

/**
 * @param {unknown} value
 * @returns {{ width: number, height: number, deviceScaleFactor: number, mobile: boolean } | null}
 */
function normalizeViewport(value) {
  if (value === undefined || value === null) return null
  const object = asObject(value, 'viewport')
  return {
    width: clampInteger(object.width, 100, 10000, DEFAULT_VIEWPORT.width),
    height: clampInteger(object.height, 100, 10000, DEFAULT_VIEWPORT.height),
    deviceScaleFactor: clampNumber(object.deviceScaleFactor, 0.1, 10, 1),
    mobile: object.mobile === true,
  }
}

/**
 * Build the Chromium command line. `--no-sandbox` is test-only (seatbelt), so it
 * is never added unless explicitly requested.
 * @param {{ port: number, userDataDir: string, headless: boolean, noSandbox: boolean,
 *   viewport: {width: number, height: number} | null, extraArgs: string[] }} options
 * @returns {string[]}
 */
function buildLaunchArgs({ port, userDataDir, headless, noSandbox, viewport, extraArgs }) {
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--remote-allow-origins=*',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-features=Translate,OptimizationHints,MediaRouter',
    '--mute-audio',
    '--hide-scrollbars',
    '--force-color-profile=srgb',
  ]
  if (headless) args.push('--headless', '--disable-gpu', '--disable-dev-shm-usage')
  if (noSandbox) args.push('--no-sandbox')
  if (viewport !== null) args.push(`--window-size=${viewport.width},${viewport.height}`)
  for (const extra of extraArgs) {
    if (typeof extra === 'string' && extra.trim() !== '') args.push(extra.trim())
  }
  args.push('about:blank')
  return args
}

/**
 * Kill a detached process group: SIGTERM, wait, then SIGKILL.
 * @param {number} pid
 * @param {number} graceMs
 * @returns {Promise<boolean>} true when the process is gone
 */
async function killProcessGroup(pid, graceMs = 2500) {
  if (typeof pid !== 'number' || !Number.isFinite(pid) || pid <= 0) return false
  const alive = () => {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }
  if (!alive()) return false
  const signal = (name) => {
    try {
      process.kill(-pid, name)
    } catch {
      try {
        process.kill(pid, name)
      } catch {
        // already gone
      }
    }
  }
  signal('SIGTERM')
  const softDeadline = Date.now() + Math.max(200, graceMs)
  while (Date.now() < softDeadline) {
    if (!alive()) return true
    await sleep(100)
  }
  signal('SIGKILL')
  const hardDeadline = Date.now() + 3000
  while (Date.now() < hardDeadline) {
    if (!alive()) return true
    await sleep(100)
  }
  return !alive()
}

/**
 * @param {import('node:child_process').ChildProcess} child
 * @param {number} timeoutMs
 * @returns {Promise<void>}
 */
async function waitForChildExit(child, timeoutMs = 3000) {
  if (child === null || child === undefined) return
  if (child.exitCode !== null || child.signalCode !== null) return
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, Math.max(1, timeoutMs))
    child.once('exit', () => {
      clearTimeout(timer)
      resolve()
    })
  })
}

/**
 * Read pixel dimensions out of a PNG or JPEG buffer.
 * @param {Buffer} buffer
 * @returns {{ format: 'png' | 'jpeg' | 'unknown', width?: number, height?: number }}
 */
function imageDimensions(buffer) {
  if (
    buffer.length >= 24 &&
    buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47
  ) {
    return { format: 'png', width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
  }
  if (buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2
    while (offset + 9 < buffer.length) {
      if (buffer[offset] !== 0xff) {
        offset += 1
        continue
      }
      const marker = buffer[offset + 1]
      const length = buffer.readUInt16BE(offset + 2)
      const isStartOfFrame =
        marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
      if (isStartOfFrame) {
        return {
          format: 'jpeg',
          height: buffer.readUInt16BE(offset + 5),
          width: buffer.readUInt16BE(offset + 7),
        }
      }
      if (length < 2) break
      offset += 2 + length
    }
  }
  return { format: 'unknown' }
}

/**
 * Quote one path for the ffmpeg concat demuxer.
 * @param {string} filePath
 * @returns {string}
 */
function concatQuote(filePath) {
  return `'${filePath.replace(/\\/gu, '\\\\').replace(/'/gu, "'\\''")}'`
}

/**
 * Turn a CDP RemoteObject into plain text.
 * @param {any} object
 * @returns {string}
 */
function remoteObjectText(object) {
  if (object === null || object === undefined) return ''
  if (object.type === 'undefined') return 'undefined'
  if (object.type === 'string') return String(object.value ?? '')
  if (object.type === 'number' || object.type === 'boolean') return String(object.value)
  if (object.type === 'object' && object.subtype === 'null') return 'null'
  if (object.value !== undefined) {
    try {
      return JSON.stringify(object.value).slice(0, 1000)
    } catch {
      return String(object.value).slice(0, 1000)
    }
  }
  if (typeof object.description === 'string') return object.description.slice(0, 2000)
  if (object.unserializableValue !== undefined) return String(object.unserializableValue)
  return object.type ?? 'unknown'
}

/**
 * @param {number} value
 * @returns {number}
 */
function round2(value) {
  return Math.round(value * 100) / 100
}

/**
 * @param {any} box
 * @returns {{ x: number, y: number, width: number, height: number } | null}
 */
function roundBox(box) {
  if (box === null || box === undefined) return null
  return {
    x: round2(numberOr(box.x, 0)),
    y: round2(numberOr(box.y, 0)),
    width: round2(numberOr(box.width, 0)),
    height: round2(numberOr(box.height, 0)),
  }
}

// ---------------------------------------------------------------------------
// Selector + page helper JavaScript (executed inside Runtime.evaluate)
// ---------------------------------------------------------------------------

const RESOLVE_HELPERS = String.raw`
  const __dshVisible = (el) => {
    if (!el || el.nodeType !== 1) return false
    const rect = el.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return false
    const style = window.getComputedStyle(el)
    if (!style) return false
    if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false
    if (Number.parseFloat(style.opacity || '1') === 0) return false
    return true
  }
  const __dshText = (el) => ((el.innerText !== undefined && el.innerText !== null ? el.innerText : el.textContent) || '').replace(/\s+/g, ' ').trim()
  const __dshResolve = (selector) => {
    if (typeof selector !== 'string' || selector.length === 0) return null
    if (selector.startsWith('text=')) {
      const query = selector.slice(5).toLowerCase()
      if (!query) return null
      const nodes = document.querySelectorAll('body *')
      let best = null
      let bestLength = Infinity
      for (const el of nodes) {
        if (!__dshVisible(el)) continue
        const text = __dshText(el)
        if (!text || text.length >= bestLength) continue
        if (text.toLowerCase().includes(query)) { best = el; bestLength = text.length }
      }
      return best
    }
    if (selector.startsWith('xpath=')) {
      try {
        let node = document.evaluate(selector.slice(6), document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue
        if (node && node.nodeType !== 1) node = node.parentElement
        return node && node.nodeType === 1 ? node : null
      } catch (error) {
        return null
      }
    }
    try {
      return document.querySelector(selector)
    } catch (error) {
      return null
    }
  }
`

/** Scroll the resolved element into view and report its viewport box. */
const ELEMENT_BOX_BODY = String.raw`
  if (!__el) return { found: false }
  try { __el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }) } catch (error) { __el.scrollIntoView() }
  const __rect = __el.getBoundingClientRect()
  return {
    found: true,
    x: __rect.left,
    y: __rect.top,
    width: __rect.width,
    height: __rect.height,
    visible: __dshVisible(__el),
    tag: __el.tagName.toLowerCase(),
    text: __dshText(__el).slice(0, 200),
  }
`

/** Focus the resolved element without changing its selection. */
const FOCUS_ONLY_BODY = String.raw`
  if (!__el) return { found: false }
  try { __el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }) } catch (error) { __el.scrollIntoView() }
  if (typeof __el.focus === 'function') __el.focus()
  return { found: true, tag: __el.tagName.toLowerCase() }
`

/**
 * Shared tail for focus bodies: classify the element and report editability.
 * Expects `__tag` and `__editable` to be defined by the caller.
 */
const FOCUS_RESULT = `return {
    found: true,
    tag: __tag,
    editable: __editable,
    readonly: __el.readOnly === true,
    disabled: __el.disabled === true,
    type: typeof __el.type === 'string' ? __el.type : '',
  }`

/** Focus and select the contents of the resolved element (used by fill with clear). */
const FOCUS_BODY = String.raw`
  if (!__el) return { found: false }
  try { __el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }) } catch (error) { __el.scrollIntoView() }
  if (typeof __el.focus === 'function') __el.focus()
  const __tag = __el.tagName.toLowerCase()
  const __type = typeof __el.type === 'string' ? __el.type.toLowerCase() : ''
  const __textTypes = ['', 'text', 'search', 'email', 'password', 'tel', 'url', 'number', 'date', 'datetime-local', 'month', 'time', 'week']
  const __editable = __tag === 'textarea' || __el.isContentEditable === true || (__tag === 'input' && __textTypes.indexOf(__type) !== -1)
  if (__tag === 'input' || __tag === 'textarea') {
    try { __el.select() } catch (error) {}
  } else if (__el.isContentEditable === true) {
    try {
      const __range = document.createRange()
      __range.selectNodeContents(__el)
      const __selection = window.getSelection()
      __selection.removeAllRanges()
      __selection.addRange(__range)
    } catch (error) {}
  }
  ` + FOCUS_RESULT + `
`

/** Focus the resolved element and move the caret to the end (fill with clear:false). */
const FOCUS_APPEND_BODY = String.raw`
  if (!__el) return { found: false }
  try { __el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }) } catch (error) { __el.scrollIntoView() }
  if (typeof __el.focus === 'function') __el.focus()
  const __tag = __el.tagName.toLowerCase()
  const __type = typeof __el.type === 'string' ? __el.type.toLowerCase() : ''
  const __textTypes = ['', 'text', 'search', 'email', 'password', 'tel', 'url', 'number', 'date', 'datetime-local', 'month', 'time', 'week']
  const __editable = __tag === 'textarea' || __el.isContentEditable === true || (__tag === 'input' && __textTypes.indexOf(__type) !== -1)
  if (__tag === 'input' || __tag === 'textarea') {
    try {
      const __length = String(__el.value === undefined || __el.value === null ? '' : __el.value).length
      __el.setSelectionRange(__length, __length)
    } catch (error) {}
  } else if (__el.isContentEditable === true) {
    try {
      const __range = document.createRange()
      __range.selectNodeContents(__el)
      __range.collapse(false)
      const __selection = window.getSelection()
      __selection.removeAllRanges()
      __selection.addRange(__range)
    } catch (error) {}
  }
  ` + FOCUS_RESULT + `
`

const SNAPSHOT_JS = String.raw`
(() => {
  const MAX_ELEMENTS = __MAX_ELEMENTS__
  const MAX_TEXT = __MAX_TEXT__
  const visible = (el) => {
    if (!el || el.nodeType !== 1) return false
    const rect = el.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return false
    const style = window.getComputedStyle(el)
    if (!style) return false
    if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false
    if (Number.parseFloat(style.opacity || '1') === 0) return false
    return true
  }
  const textOf = (el) => ((el.innerText !== undefined && el.innerText !== null ? el.innerText : el.textContent) || '').replace(/\s+/g, ' ').trim()
  const cssEscape = (value) => (window.CSS && typeof CSS.escape === 'function') ? CSS.escape(value) : String(value).replace(/([^a-zA-Z0-9_-])/g, '\\$1')
  const attrEscape = (value) => String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')
  const unique = (selector) => {
    try { return document.querySelectorAll(selector).length === 1 } catch (error) { return false }
  }
  const selectorFor = (el) => {
    if (!(el instanceof Element)) return null
    const id = el.getAttribute('id')
    if (id && /^[A-Za-z][A-Za-z0-9_-]*$/.test(id) && unique('#' + cssEscape(id))) return '#' + cssEscape(id)
    const testId = el.getAttribute('data-testid') || el.getAttribute('data-test-id')
    if (testId) {
      const candidate = '[data-testid="' + attrEscape(testId) + '"]'
      if (unique(candidate)) return candidate
    }
    const name = el.getAttribute('name')
    const tag = el.tagName.toLowerCase()
    if (name && /^(input|select|textarea|button|form)$/.test(tag)) {
      const candidate = tag + '[name="' + attrEscape(name) + '"]'
      if (unique(candidate)) return candidate
    }
    let node = el
    const segments = []
    while (node && node.nodeType === 1 && node !== document.documentElement && segments.length < 12) {
      if (node.id && /^[A-Za-z][A-Za-z0-9_-]*$/.test(node.id) && unique('#' + cssEscape(node.id))) {
        segments.unshift('#' + cssEscape(node.id))
        break
      }
      let segment = node.tagName.toLowerCase()
      const parent = node.parentElement
      if (parent) {
        const sameTag = Array.prototype.filter.call(parent.children, (child) => child.tagName === node.tagName)
        if (sameTag.length > 1) segment += ':nth-of-type(' + (sameTag.indexOf(node) + 1) + ')'
      }
      segments.unshift(segment)
      const candidate = segments.join(' > ')
      if (unique(candidate)) return candidate
      node = node.parentElement
    }
    return segments.length > 0 ? segments.join(' > ') : null
  }
  const INTERACTIVE = 'a[href], area[href], button, input:not([type="hidden"]), select, textarea, summary, label, [role], [onclick], [tabindex]:not([tabindex="-1"]), [contenteditable]:not([contenteditable="false"]), [aria-label], h1, h2, h3, h4, h5, h6'
  const inferRole = (el) => {
    const explicit = el.getAttribute('role')
    if (explicit) return explicit.trim()
    const tag = el.tagName.toLowerCase()
    if (tag === 'a') return el.hasAttribute('href') ? 'link' : 'generic'
    if (tag === 'button') return 'button'
    if (tag === 'select') return el.multiple ? 'listbox' : 'combobox'
    if (tag === 'textarea') return 'textbox'
    if (tag === 'summary') return 'button'
    if (tag === 'label') return 'label'
    if (/^h[1-6]$/.test(tag)) return 'heading'
    if (tag === 'input') {
      const type = (el.getAttribute('type') || 'text').toLowerCase()
      const roles = {
        button: 'button', submit: 'button', reset: 'button', image: 'button',
        checkbox: 'checkbox', radio: 'radio', range: 'slider', file: 'button',
        search: 'searchbox', email: 'textbox', password: 'textbox', tel: 'textbox',
        url: 'textbox', number: 'spinbutton', text: 'textbox', color: 'button',
        date: 'textbox', datetime: 'textbox', 'datetime-local': 'textbox',
        month: 'textbox', time: 'textbox', week: 'textbox',
      }
      return roles[type] || 'textbox'
    }
    if (el.isContentEditable === true) return 'textbox'
    return 'generic'
  }
  const accessibleName = (el) => {
    const aria = el.getAttribute('aria-label')
    if (aria && aria.trim()) return aria.trim().slice(0, 120)
    const labelledBy = el.getAttribute('aria-labelledby')
    if (labelledBy) {
      const parts = labelledBy.split(/\s+/)
        .map((id) => document.getElementById(id))
        .filter(Boolean)
        .map((node) => textOf(node))
        .filter(Boolean)
      if (parts.length > 0) return parts.join(' ').slice(0, 120)
    }
    const tag = el.tagName.toLowerCase()
    if (tag === 'input' || tag === 'select' || tag === 'textarea') {
      const type = (el.getAttribute('type') || '').toLowerCase()
      if ((type === 'submit' || type === 'button' || type === 'reset') && el.value) return String(el.value).slice(0, 120)
      if (el.id) {
        const label = document.querySelector('label[for="' + cssEscape(el.id) + '"]')
        if (label) {
          const labelText = textOf(label)
          if (labelText) return labelText.slice(0, 120)
        }
      }
      const closestLabel = el.closest('label')
      if (closestLabel) {
        const labelText = textOf(closestLabel)
        if (labelText) return labelText.slice(0, 120)
      }
      const placeholder = el.getAttribute('placeholder')
      if (placeholder && placeholder.trim()) return placeholder.trim().slice(0, 120)
      const name = el.getAttribute('name')
      if (name && name.trim()) return name.trim().slice(0, 120)
      if (el.id) return el.id
      if (el.value) return String(el.value).slice(0, 120)
      return type || tag
    }
    const text = textOf(el)
    if (text) return text.slice(0, 120)
    const title = el.getAttribute('title')
    if (title && title.trim()) return title.trim().slice(0, 120)
    const alt = el.getAttribute('alt')
    if (alt && alt.trim()) return alt.trim().slice(0, 120)
    if (el.id) return el.id
    return ''
  }
  const elements = []
  const candidates = document.querySelectorAll(INTERACTIVE)
  for (const el of candidates) {
    if (elements.length >= MAX_ELEMENTS) break
    if (!visible(el)) continue
    if (el.closest('svg') && !el.getAttribute('role') && !el.getAttribute('aria-label')) continue
    const selector = selectorFor(el)
    if (!selector) continue
    const tag = el.tagName.toLowerCase()
    const item = { ref: 'e' + (elements.length + 1), role: inferRole(el), name: accessibleName(el), selector, tag }
    if (tag === 'input') {
      const type = (el.getAttribute('type') || 'text').toLowerCase()
      if (type === 'password') {
        if (el.value) item.value = '********'
      } else if (type !== 'checkbox' && type !== 'radio' && type !== 'file' && el.value) {
        item.value = String(el.value)
      }
      if (type === 'checkbox' || type === 'radio') item.checked = el.checked === true
    } else if (tag === 'select') {
      if (el.value) item.value = String(el.value)
    } else if (tag === 'textarea') {
      if (el.value) item.value = String(el.value)
    } else if (el.isContentEditable === true) {
      const editableText = textOf(el)
      if (editableText) item.value = editableText.slice(0, 200)
    }
    if (el.disabled === true || el.getAttribute('aria-disabled') === 'true') item.disabled = true
    elements.push(item)
  }
  let text = ''
  if (document.body) {
    text = (document.body.innerText || '')
      .replace(/\u00a0/g, ' ')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  }
  const total = text.length
  const truncated = total > MAX_TEXT
  if (truncated) text = text.slice(0, MAX_TEXT)
  return {
    url: window.location.href,
    title: document.title,
    elements,
    text,
    truncated,
    totalTextLength: total,
    totalElements: candidates.length,
  }
})()
`

/**
 * Compose an expression that resolves `selector` and then runs `body` with the
 * element bound to `__el`.
 * @param {string} selector
 * @param {string} body
 * @returns {string}
 */
function resolveExpression(selector, body) {
  return `(() => {${RESOLVE_HELPERS}const __el = __dshResolve(${JSON.stringify(selector)});${body}})()`
}

/**
 * Compose an expression that runs `body` without resolving an element.
 * @param {string} body
 * @returns {string}
 */
function plainExpression(body) {
  return `(() => {${RESOLVE_HELPERS}${body}})()`
}

// ---------------------------------------------------------------------------
// Key definitions
// ---------------------------------------------------------------------------

const NAMED_KEYS = {
  Enter: { key: 'Enter', code: 'Enter', vk: 13, text: '\r' },
  Tab: { key: 'Tab', code: 'Tab', vk: 9 },
  Escape: { key: 'Escape', code: 'Escape', vk: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', vk: 8 },
  Delete: { key: 'Delete', code: 'Delete', vk: 46 },
  Insert: { key: 'Insert', code: 'Insert', vk: 45 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', vk: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', vk: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', vk: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', vk: 39 },
  Home: { key: 'Home', code: 'Home', vk: 36 },
  End: { key: 'End', code: 'End', vk: 35 },
  PageUp: { key: 'PageUp', code: 'PageUp', vk: 33 },
  PageDown: { key: 'PageDown', code: 'PageDown', vk: 34 },
  Space: { key: ' ', code: 'Space', vk: 32, text: ' ' },
}
for (let index = 1; index <= 12; index += 1) {
  NAMED_KEYS[`F${index}`] = { key: `F${index}`, code: `F${index}`, vk: 111 + index }
}

const KEY_ALIASES = new Map([
  ['enter', 'Enter'], ['return', 'Enter'], ['tab', 'Tab'], ['escape', 'Escape'], ['esc', 'Escape'],
  ['backspace', 'Backspace'], ['delete', 'Delete'], ['del', 'Delete'], ['insert', 'Insert'],
  ['arrowup', 'ArrowUp'], ['up', 'ArrowUp'], ['arrowdown', 'ArrowDown'], ['down', 'ArrowDown'],
  ['arrowleft', 'ArrowLeft'], ['left', 'ArrowLeft'], ['arrowright', 'ArrowRight'], ['right', 'ArrowRight'],
  ['home', 'Home'], ['end', 'End'], ['pageup', 'PageUp'], ['pagedown', 'PageDown'],
  ['space', 'Space'], ['spacebar', 'Space'], [' ' , 'Space'],
  ...Array.from({ length: 12 }, (_, index) => [`f${index + 1}`, `F${index + 1}`]),
])

const PUNCTUATION_KEYS = {
  '`': { code: 'Backquote', vk: 192, shifted: '~' },
  '-': { code: 'Minus', vk: 189, shifted: '_' },
  '=': { code: 'Equal', vk: 187, shifted: '+' },
  '[': { code: 'BracketLeft', vk: 219, shifted: '{' },
  ']': { code: 'BracketRight', vk: 221, shifted: '}' },
  '\\': { code: 'Backslash', vk: 220, shifted: '|' },
  ';': { code: 'Semicolon', vk: 186, shifted: ':' },
  "'": { code: 'Quote', vk: 222, shifted: '"' },
  ',': { code: 'Comma', vk: 188, shifted: '<' },
  '.': { code: 'Period', vk: 190, shifted: '>' },
  '/': { code: 'Slash', vk: 191, shifted: '?' },
}

const SHIFTED_DIGITS = { '1': '!', '2': '@', '3': '#', '4': '$', '5': '%', '6': '^', '7': '&', '8': '*', '9': '(', '0': ')' }

/**
 * @param {string} character
 * @returns {{ key: string, code: string, vk: number, text?: string,
 *   shiftKey?: string, shiftText?: string }}
 */
function singleCharacterKey(character) {
  if (character === ' ') return NAMED_KEYS.Space
  if (/^[a-zA-Z]$/u.test(character)) {
    const upper = character.toUpperCase()
    return {
      key: character,
      code: `Key${upper}`,
      vk: upper.charCodeAt(0),
      text: character,
      shiftKey: upper,
      shiftText: upper,
    }
  }
  if (/^[0-9]$/u.test(character)) {
    return {
      key: character,
      code: `Digit${character}`,
      vk: '0123456789'.indexOf(character) + 48,
      text: character,
      shiftKey: SHIFTED_DIGITS[character],
      shiftText: SHIFTED_DIGITS[character],
    }
  }
  const punctuation = PUNCTUATION_KEYS[character]
  if (punctuation !== undefined) {
    return {
      key: character,
      code: punctuation.code,
      vk: punctuation.vk,
      text: character,
      shiftKey: punctuation.shifted,
      shiftText: punctuation.shifted,
    }
  }
  throw new AutomationError(`Unsupported key: ${JSON.stringify(character)}`, {
    code: 'UNSUPPORTED_KEY',
    hint: 'Use a single character, or one of Enter, Tab, Escape, Backspace, Delete, ArrowUp/Down/Left/Right, Home, End, PageUp, PageDown, Space, F1-F12.',
  })
}

/**
 * @param {unknown} value
 * @returns {{ key: string, code: string, vk: number, text?: string |
 *   undefined, shiftedKey?: string, shiftedText?: string }}
 */
function resolveKey(value) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new AutomationError('key must be a non-empty string', {
      code: 'MISSING_KEY',
      hint: 'Pass e.g. "Enter", "Tab", "Escape", "ArrowDown", "a", or "F5".',
    })
  }
  if (value.length === 1) return singleCharacterKey(value)
  const alias = KEY_ALIASES.get(value.toLowerCase())
  if (alias !== undefined) return { ...NAMED_KEYS[alias] }
  const direct = NAMED_KEYS[value]
  if (direct !== undefined) return { ...direct }
  const canonical = NAMED_KEYS[value.charAt(0).toUpperCase() + value.slice(1)]
  if (canonical !== undefined) return { ...canonical }
  throw new AutomationError(`Unsupported key: ${JSON.stringify(value)}`, {
    code: 'UNSUPPORTED_KEY',
    hint: 'Use Enter, Tab, Escape, Backspace, Delete, Arrow keys, Home, End, PageUp, PageDown, Space, F1-F12, letters, digits, or common punctuation.',
  })
}

/**
 * @param {unknown} value
 * @returns {number}
 */
function parseModifiers(value) {
  if (value === undefined || value === null) return 0
  if (!Array.isArray(value)) {
    throw new AutomationError('modifiers must be an array of strings', {
      code: 'INVALID_MODIFIERS',
      hint: 'Pass modifiers such as ["cmd", "shift"].',
    })
  }
  let bits = 0
  for (const entry of value) {
    const name = String(entry).toLowerCase()
    if (name === 'cmd' || name === 'command' || name === 'meta' || name === 'super') bits |= MODIFIER_META
    else if (name === 'ctrl' || name === 'control') bits |= MODIFIER_CTRL
    else if (name === 'alt' || name === 'option' || name === 'opt') bits |= MODIFIER_ALT
    else if (name === 'shift') bits |= MODIFIER_SHIFT
    else {
      throw new AutomationError(`Unknown modifier: ${JSON.stringify(entry)}`, {
        code: 'INVALID_MODIFIERS',
        hint: 'Supported modifiers: cmd, ctrl, alt, shift.',
      })
    }
  }
  return bits
}

/**
 * Editing commands Chrome should execute with a shortcut key event. CDP-delivered
 * Meta/Ctrl shortcuts are unreliable without these, so map the common ones.
 * @param {string} key
 * @param {number} modifiers
 * @returns {string[] | undefined}
 */
function shortcutCommands(key, modifiers) {
  const primary = (modifiers & (MODIFIER_META | MODIFIER_CTRL)) !== 0
  if (!primary) return undefined
  const lower = key.toLowerCase()
  const commands = []
  if (lower === 'a') commands.push('selectAll')
  else if (lower === 'c') commands.push('copy')
  else if (lower === 'x') commands.push('cut')
  else if (lower === 'v') commands.push('paste')
  else if (lower === 'z') commands.push((modifiers & MODIFIER_SHIFT) !== 0 ? 'redo' : 'undo')
  else if (key === 'Backspace') commands.push('deleteBackward')
  else if (key === 'Delete') commands.push('deleteForward')
  return commands.length > 0 ? commands : undefined
}

// ---------------------------------------------------------------------------
// Minimal CDP client (browser-level WebSocket + flattened sessions)
// ---------------------------------------------------------------------------

class DevToolsClient {
  /**
   * @param {{ timeoutMs?: number, log?: (level: string, message: string) => void }} [options]
   */
  constructor(options = {}) {
    this.timeoutMs = clampNumber(options.timeoutMs, 500, 180000, 15000)
    this.log = typeof options.log === 'function' ? options.log : null
    this.socket = null
    this.nextId = 1
    this.closed = false
    this.pending = new Map()
    this.handlers = new Map()
    this.hasOpened = false
    this.lastCloseReason = null
  }

  get connected() {
    return (
      this.socket !== null &&
      !this.closed &&
      this.socket.readyState === 1
    )
  }

  /**
   * @param {string} wsUrl
   * @param {number} [timeoutMs]
   * @returns {Promise<void>}
   */
  async connect(wsUrl, timeoutMs = 10000) {
    if (this.socket !== null) {
      throw new AutomationError('The DevTools client is already connected', { code: 'ALREADY_CONNECTED' })
    }
    let socket
    try {
      socket = new WebSocket(wsUrl)
    } catch (error) {
      throw new AutomationError(`Could not open the DevTools WebSocket at ${wsUrl}: ${errorTextOf(error)}`, {
        code: 'CDP_CONNECT_FAILED',
        hint: 'Verify the browser is still running and the port/wsUrl is correct, then call action "connect".',
      })
    }
    this.socket = socket
    socket.addEventListener('message', (event) => this._onMessage(event))
    socket.addEventListener('close', () => {
      this.lastCloseReason = 'The browser closed the DevTools connection'
      this._failAll(new AutomationError('The browser DevTools connection was closed', {
        code: 'BROWSER_DISCONNECTED',
        hint: 'The browser was closed or crashed. Call action "launch" to start a new one.',
      }))
      this.closed = true
    })
    socket.addEventListener('error', () => {
      if (!this.hasOpened) {
        this._failAll(new AutomationError(`Could not open the DevTools WebSocket at ${wsUrl}`, {
          code: 'CDP_CONNECT_FAILED',
          hint: 'Verify Chrome was started with --remote-debugging-port and no other process owns the port.',
        }))
      }
    })
    await new Promise((resolve, reject) => {
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        try { socket.close() } catch {}
        reject(new AutomationError(`Timed out after ${timeoutMs}ms connecting to the DevTools WebSocket`, {
          code: 'CDP_CONNECT_FAILED',
          hint: 'The DevTools endpoint did not accept a WebSocket connection; check the browser process and port.',
        }))
      }, Math.max(1000, timeoutMs))
      socket.addEventListener('open', () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this.hasOpened = true
        resolve()
      }, { once: true })
      socket.addEventListener('error', (event) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(new AutomationError(`The DevTools WebSocket reported an error: ${errorTextOf(event)}`, {
          code: 'CDP_CONNECT_FAILED',
          hint: 'The DevTools endpoint refused the connection; verify --remote-debugging-port and --remote-allow-origins=*.',
        }))
      }, { once: true })
    }).catch((error) => {
      this._failAll(error)
      this.closed = true
      throw error
    })
  }

  /**
   * @param {string} method CDP method name
   * @param {Record<string, unknown>} [params]
   * @param {{ sessionId?: string, timeoutMs?: number }} [options]
   * @returns {Promise<Record<string, any>>}
   */
  send(method, params = {}, options = {}) {
    const { sessionId, timeoutMs } = options
    if (!this.connected) {
      return Promise.reject(new AutomationError('The browser DevTools connection is not open', {
        code: 'BROWSER_DISCONNECTED',
        hint: 'Call action "launch" (or "connect") before other browser actions.',
      }))
    }
    const id = this.nextId
    this.nextId += 1
    const message = { id, method, params }
    if (typeof sessionId === 'string' && sessionId.length > 0) message.sessionId = sessionId
    const limitMs = clampNumber(timeoutMs, 100, 300000, this.timeoutMs)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) {
          reject(new AutomationError(`DevTools command ${method} timed out after ${limitMs}ms`, {
            code: 'CDP_TIMEOUT',
            hint: 'The page may be busy (long script, blocked dialog) or the browser is unresponsive. Try action "status" and then retry.',
          }))
        }
      }, limitMs)
      this.pending.set(id, { resolve, reject, timer, method })
      try {
        this.socket.send(JSON.stringify(message))
      } catch (error) {
        this.pending.delete(id)
        clearTimeout(timer)
        reject(new AutomationError(`Could not send DevTools command ${method}: ${errorTextOf(error)}`, {
          code: 'CDP_SEND_FAILED',
        }))
      }
    })
  }

  /**
   * Subscribe to one CDP event. Returns an unsubscribe function.
   * @param {string} method
   * @param {(params: Record<string, any>, sessionId?: string) => void} listener
   * @returns {() => void}
   */
  on(method, listener) {
    let set = this.handlers.get(method)
    if (set === undefined) {
      set = new Set()
      this.handlers.set(method, set)
    }
    set.add(listener)
    return () => {
      const current = this.handlers.get(method)
      if (current !== undefined) current.delete(listener)
    }
  }

  /**
   * Resolve on the next matching event.
   * @param {string} method
   * @param {{ sessionId?: string, timeoutMs?: number,
   *   predicate?: (params: Record<string, any>, sessionId?: string) => boolean }} [options]
   * @returns {Promise<{ params: Record<string, any>, sessionId?: string }>}
   */
  waitForEvent(method, options = {}) {
    const { sessionId, timeoutMs = 10000, predicate } = options
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer)
        unsubscribe()
      }
      const unsubscribe = this.on(method, (params, eventSessionId) => {
        if (sessionId !== undefined && eventSessionId !== sessionId) return
        if (predicate !== undefined && !predicate(params, eventSessionId)) return
        cleanup()
        resolve({ params, sessionId: eventSessionId })
      })
      const timer = setTimeout(() => {
        cleanup()
        reject(new AutomationError(`Timed out waiting for the browser event ${method}`, {
          code: 'CDP_EVENT_TIMEOUT',
          hint: 'The page may not have reached that state; retry with action "wait_for" or a longer timeout.',
        }))
      }, Math.max(100, timeoutMs))
    })
  }

  close() {
    if (this.closed) return
    this.closed = true
    this._failAll(new AutomationError('The DevTools client was closed', {
      code: 'BROWSER_DISCONNECTED',
      hint: 'Call action "launch" to start a new browser.',
    }))
    const socket = this.socket
    this.socket = null
    try {
      socket?.close()
    } catch {
      // ignore
    }
  }

  /** @param {any} error */
  _failAll(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
  }

  /** @param {MessageEvent} event */
  _onMessage(event) {
    let message
    try {
      message = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data))
    } catch {
      return
    }
    if (message === null || typeof message !== 'object') return
    if (typeof message.id === 'number') {
      const pending = this.pending.get(message.id)
      if (pending === undefined) return
      this.pending.delete(message.id)
      clearTimeout(pending.timer)
      if (message.error !== undefined && message.error !== null) {
        pending.reject(new AutomationError(
          `DevTools command ${pending.method} failed: ${message.error.message ?? 'unknown error'}`,
          {
            code: 'CDP_ERROR',
            hint: hintForCdpError(pending.method, message.error.message),
          },
        ))
      } else {
        pending.resolve(message.result ?? {})
      }
      return
    }
    if (typeof message.method === 'string') {
      const params = message.params ?? {}
      const sessionId = typeof message.sessionId === 'string' ? message.sessionId : undefined
      const listeners = this.handlers.get(message.method)
      if (listeners !== undefined) {
        for (const listener of [...listeners]) {
          try {
            listener(params, sessionId)
          } catch (error) {
            this.log?.('warn', `event handler for ${message.method} failed: ${errorTextOf(error)}`)
          }
        }
      }
    }
  }
}

/**
 * @param {string} method
 * @param {string | undefined} message
 * @returns {string}
 */
function hintForCdpError(method, message) {
  const text = String(message ?? '')
  if (/No target with given id|Session with given id not found|No session with given id/iu.test(text)) {
    return 'That page or session no longer exists (the tab was closed or navigated away). Call action "pages" then "select_page".'
  }
  if (/Cannot find context with specified id|Execution context was destroyed/iu.test(text)) {
    return 'The page navigated while the command was running. Wait for the page and retry.'
  }
  if (/Not attached to an active page/iu.test(text)) {
    return 'The page is not attached anymore; call action "pages" and select a live page.'
  }
  if (/Target closed|Browser closed/iu.test(text)) {
    return 'The browser is closed or crashed. Call action "launch".'
  }
  if (method.startsWith('Page.captureScreenshot') || method.startsWith('Page.printToPDF')) {
    return 'The page may be too large or still loading; retry, or reduce the viewport.'
  }
  return 'The Chrome DevTools Protocol rejected that command; check the page state with action "snapshot" or "status" and retry.'
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function errorTextOf(error) {
  if (error instanceof Error) return error.message
  if (error !== null && typeof error === 'object') {
    const object = /** @type {any} */ (error)
    if (typeof object.message === 'string') return object.message
    if (typeof object.error === 'string') return object.error
  }
  return String(error)
}

// ---------------------------------------------------------------------------
// BrowserManager
// ---------------------------------------------------------------------------

export class BrowserManager {
  /**
   * @param {{ artifacts: any, config?: Record<string, any>,
   *   log?: (level: string, message: string) => void }} options
   */
  constructor({ artifacts, config, log } = /** @type {any} */ ({})) {
    this.artifacts = artifacts
    this.config = config ?? {}
    this.logger = typeof log === 'function' ? log : null
    /** @type {DevToolsClient | null} */
    this.client = null
    /** @type {import('node:child_process').ChildProcess | null} */
    this.child = null
    /** @type {number | null} */
    this.childPid = null
    /** @type {number | null} */
    this.port = null
    /** @type {string | null} */
    this.wsUrl = null
    /** @type {string | null} */
    this.browser = null
    /** @type {boolean | null} */
    this.headless = null
    /** @type {string | null} */
    this.userDataDir = null
    /** @type {Map<string, any>} */
    this.pages = new Map()
    /** @type {string | null} */
    this.currentPageId = null
    /** @type {Map<string, Promise<any>>} */
    this._attaching = new Map()
    /** @type {Array<() => void>} */
    this._eventOffs = []
    /** @type {any} */
    this.recording = null
    /** @type {{ policy: 'accept' | 'dismiss', promptText?: string }} */
    this.dialogPolicy = { policy: 'accept' }
    /** @type {Map<string, any>} */
    this.downloads = new Map()
    /** @type {string | null} */
    this.downloadDir = null
    /** @type {Map<string, string>} */
    this.lastSnapshotRefs = new Map()
    /** @type {{ width: number, height: number, deviceScaleFactor: number, mobile: boolean } | null} */
    this.viewportState = null
    this._disposed = false
    this._closingChild = false
    /** @type {Record<string, any> | null} */
    this._exec = null
  }

  // -- public API ----------------------------------------------------------

  /**
   * Execute one browser action.
   * @param {Record<string, unknown>} args
   * @param {{ agent?: { id?: string }, signal?: AbortSignal } | undefined} [exec]
   * @returns {Promise<Record<string, any>>}
   */
  async run(args, exec) {
    const request = asObject(args, 'browser arguments')
    const action = request.action
    if (typeof action !== 'string' || action.trim() === '') {
      throw new AutomationError('browser action must be a non-empty string', {
        code: 'MISSING_ACTION',
        hint: `Supported actions: ${ACTIONS.join(', ')}.`,
      })
    }
    if (exec !== undefined && exec !== null) this._exec = exec
    const normalized = action.trim()
    try {
      return await this._dispatch(normalized, request, exec)
    } catch (error) {
      if (error instanceof AutomationError) throw error
      throw new AutomationError(`Browser action "${normalized}" failed: ${errorTextOf(error)}`, {
        code: 'BROWSER_FAILURE',
        hint: 'Call action "status" to inspect the browser connection, then retry. If the page is stuck, call action "close" and "launch" again.',
      })
    }
  }

  /** Stop any recording and the launched browser. Never throws. */
  async dispose() {
    if (this._disposed) return
    this._disposed = true
    if (this.recording !== null) {
      try {
        await this._recordStop({})
      } catch (error) {
        this._log('warn', `could not finish browser recording during dispose: ${errorTextOf(error)}`)
        this.recording = null
      }
    }
    try {
      await this._teardown()
    } catch (error) {
      this._log('warn', `browser teardown failed: ${errorTextOf(error)}`)
    }
  }

  // -- dispatch ------------------------------------------------------------

  /**
   * @param {string} action
   * @param {Record<string, any>} args
   * @param {any} exec
   * @returns {Promise<Record<string, any>>}
   */
  async _dispatch(action, args, exec) {
    const activeExec = exec ?? this._exec
    switch (action) {
      case 'launch':
        return await this._launch(args, activeExec)
      case 'connect':
        return await this._connect(args, activeExec)
      case 'close':
        return await this._close()
      case 'status':
        return await this._status()
      case 'pages':
        return { pages: await this._listPages() }
      case 'new_page':
        return await this._newPage(args)
      case 'select_page':
        return await this._selectPage(args)
      case 'goto':
        return await this._goto(args)
      case 'back':
        return await this._history(-1)
      case 'forward':
        return await this._history(1)
      case 'reload':
        return await this._reload(args)
      case 'click':
        return await this._clickLike(args, 'click')
      case 'dblclick':
      case 'double_click':
        return await this._clickLike(args, 'dblclick')
      case 'hover':
        return await this._clickLike(args, 'hover')
      case 'fill':
        return await this._fill(args)
      case 'type':
        return await this._type(args)
      case 'press':
        return await this._press(args)
      case 'select_option':
        return await this._selectOption(args)
      case 'check':
        return await this._check(args, true)
      case 'uncheck':
        return await this._check(args, false)
      case 'scroll':
        return await this._scroll(args)
      case 'wait_for':
        return await this._waitFor(args)
      case 'snapshot':
        return await this._snapshot(args)
      case 'eval':
        return await this._eval(args)
      case 'screenshot':
        return await this._screenshot(args, activeExec)
      case 'record_start':
        return await this._recordStart(args, activeExec)
      case 'record_stop':
        return await this._recordStop(args)
      case 'console':
        return await this._console(args)
      case 'network':
        return await this._network(args)
      case 'dialog':
        return this._dialog(args)
      case 'viewport':
        return await this._viewport(args)
      case 'download_list':
        return await this._downloadList(args, activeExec)
      case 'pdf':
        return await this._pdf(args, activeExec)
      default:
        throw new AutomationError(`Unknown browser action "${action}"`, {
          code: 'UNKNOWN_ACTION',
          hint: `Supported actions: ${ACTIONS.join(', ')}.`,
        })
    }
  }

  // -- logging -------------------------------------------------------------

  /**
   * @param {string} level
   * @param {string} message
   */
  _log(level, message) {
    if (this.logger === null) return
    try {
      this.logger(level, `[browser] ${message}`)
    } catch {
      // logging must never break automation
    }
  }

  // -- state helpers -------------------------------------------------------

  _isConnected() {
    return this.client !== null && this.client.connected
  }

  _commandTimeout() {
    return clampNumber(this.config.commandTimeoutMs, 500, 180000, 15000)
  }

  _notConnected() {
    return new AutomationError('No browser is connected', {
      code: 'BROWSER_NOT_CONNECTED',
      hint: 'Call this tool with action "launch" first, or "connect" with the port of a browser started with --remote-debugging-port.',
    })
  }

  /**
   * @param {any} exec
   * @param {string} subdir
   * @param {string} extension
   * @returns {Promise<string>}
   */
  async _artifactPath(exec, subdir, extension) {
    if (this.artifacts === null || this.artifacts === undefined || typeof this.artifacts.path !== 'function') {
      throw new AutomationError('The artifact writer is unavailable; cannot save browser output', {
        code: 'ARTIFACTS_UNAVAILABLE',
        hint: 'Pass a "path" argument to choose an explicit output location.',
      })
    }
    return await this.artifacts.path(exec, subdir, extension)
  }

  /**
   * @param {any} exec
   * @param {string} subdir
   * @returns {Promise<string>}
   */
  async _artifactDir(exec, subdir) {
    if (this.artifacts === null || this.artifacts === undefined || typeof this.artifacts.dir !== 'function') {
      throw new AutomationError('The artifact writer is unavailable; cannot create an artifact directory', {
        code: 'ARTIFACTS_UNAVAILABLE',
        hint: 'Pass an explicit "path" argument instead.',
      })
    }
    return await this.artifacts.dir(exec, subdir)
  }

  /**
   * Resolve a snapshot `ref` (e.g. "e12", "ref=e12", "@e12") to its CSS selector.
   * @param {string} selector
   * @returns {string}
   */
  _resolveSelectorRef(selector) {
    const trimmed = selector.trim()
    const prefixed = /^(?:ref=|@)(e\d+)$/iu.exec(trimmed)
    if (prefixed !== null) {
      const mapped = this.lastSnapshotRefs.get(prefixed[1].toLowerCase())
      if (mapped !== undefined) return mapped
      throw new AutomationError(`Unknown snapshot ref "${trimmed}"`, {
        code: 'UNKNOWN_REF',
        hint: 'Call action "snapshot" first; refs are only valid until the next snapshot.',
      })
    }
    if (/^e\d+$/u.test(trimmed)) {
      const mapped = this.lastSnapshotRefs.get(trimmed.toLowerCase())
      if (mapped !== undefined) return mapped
    }
    return trimmed
  }

  /**
   * @param {Record<string, any>} args
   * @returns {string}
   */
  _selectorArg(args) {
    const selector = args.selector
    if (typeof selector !== 'string' || selector.trim() === '') {
      throw new AutomationError('selector must be a non-empty string', {
        code: 'MISSING_SELECTOR',
        hint: 'Pass a CSS selector, "text=Visible text", "xpath=//button", or a snapshot ref such as "ref=e3".',
      })
    }
    return this._resolveSelectorRef(selector)
  }

  /**
   * @param {Record<string, any>} args
   * @param {number} fallback
   * @returns {number}
   */
  _timeoutArg(args, fallback) {
    return clampNumber(args.timeoutMs ?? args.timeout, 100, 180000, fallback)
  }

  // -- CDP plumbing --------------------------------------------------------

  /**
   * @param {DevToolsClient} client
   * @param {any} exec
   * @returns {Promise<void>}
   */
  async _installClient(client, exec) {
    this.client = client
    this._installEventHandlers()
    try {
      await client.send('Target.setDiscoverTargets', { discover: true }, { timeoutMs: 5000 })
    } catch (error) {
      this._log('warn', `Target.setDiscoverTargets failed: ${errorTextOf(error)}`)
    }
    await this._attachExistingPages()
    try {
      await this._ensureDownloads(exec)
    } catch (error) {
      this._log('debug', `could not enable download capture: ${errorTextOf(error)}`)
    }
  }

  /** @returns {Promise<void>} */
  async _attachExistingPages() {
    const client = this.client
    if (client === null) return
    let targetInfos = []
    try {
      const result = await client.send('Target.getTargets', {}, { timeoutMs: 5000 })
      targetInfos = Array.isArray(result.targetInfos) ? result.targetInfos : []
    } catch (error) {
      this._log('warn', `Target.getTargets failed: ${errorTextOf(error)}`)
    }
    for (const info of targetInfos) {
      if (info?.type !== 'page' || typeof info.targetId !== 'string') continue
      try {
        await this._attachPage(info.targetId)
      } catch (error) {
        this._log('debug', `could not attach to page ${info.targetId}: ${errorTextOf(error)}`)
      }
    }
    if (this.pages.size === 0) {
      try {
        const created = await client.send('Target.createTarget', { url: 'about:blank' }, { timeoutMs: 5000 })
        if (typeof created.targetId === 'string') await this._attachPage(created.targetId)
      } catch (error) {
        this._log('warn', `could not create the initial page: ${errorTextOf(error)}`)
      }
    }
    if (this.currentPageId === null && this.pages.size > 0) {
      this.currentPageId = this.pages.keys().next().value ?? null
    }
  }

  /**
   * @param {string} targetId
   * @returns {Promise<any>}
   */
  _attachPage(targetId) {
    const existing = this.pages.get(targetId)
    if (existing !== undefined) return Promise.resolve(existing)
    const inflight = this._attaching.get(targetId)
    if (inflight !== undefined) return inflight
    const promise = this._doAttachPage(targetId).finally(() => {
      this._attaching.delete(targetId)
    })
    this._attaching.set(targetId, promise)
    return promise
  }

  /**
   * @param {string} targetId
   * @returns {Promise<any>}
   */
  async _doAttachPage(targetId) {
    const client = this.client
    if (client === null) throw this._notConnected()
    const attached = await client.send('Target.attachToTarget', { targetId, flatten: true }, { timeoutMs: 5000 })
    const sessionId = attached.sessionId
    if (typeof sessionId !== 'string') {
      throw new AutomationError(`Could not attach to page ${targetId}`, { code: 'CDP_ATTACH_FAILED' })
    }
    const record = {
      id: targetId,
      sessionId,
      url: '',
      title: '',
      console: [],
      network: new Map(),
      pendingRequests: new Set(),
      createdAt: Date.now(),
    }
    this.pages.set(targetId, record)
    if (this.currentPageId === null) this.currentPageId = targetId
    const enables = ['Page.enable', 'Runtime.enable', 'Log.enable', 'Network.enable'].map((method) =>
      client.send(method, {}, { sessionId, timeoutMs: 5000 }).catch((error) => {
        this._log('debug', `${method} failed for ${targetId}: ${errorTextOf(error)}`)
      }),
    )
    await Promise.all(enables)
    await this._refreshTargetInfo(record)
    this._log('debug', `attached to page ${targetId} (session ${sessionId})`)
    return record
  }

  /** @returns {void} */
  _installEventHandlers() {
    const client = this.client
    if (client === null) return
    this._eventOffs = [
      client.on('Target.targetCreated', (params) => {
        const info = params.targetInfo
        if (info?.type !== 'page' || typeof info.targetId !== 'string') return
        this._attachPage(info.targetId).catch((error) => {
          this._log('debug', `auto-attach to new page ${info.targetId} failed: ${errorTextOf(error)}`)
        })
      }),
      client.on('Target.targetInfoChanged', (params) => {
        const info = params.targetInfo
        if (info === undefined || typeof info.targetId !== 'string') return
        const record = this.pages.get(info.targetId)
        if (record === undefined) return
        if (typeof info.url === 'string') record.url = info.url
        if (typeof info.title === 'string') record.title = info.title
      }),
      client.on('Target.targetDestroyed', (params) => {
        this._forgetPage(params.targetId)
      }),
      client.on('Target.targetCrashed', (params) => {
        this._log('warn', `page ${params.targetId} crashed`)
        this._forgetPage(params.targetId)
      }),
      client.on('Target.detachedFromTarget', (params) => {
        this._forgetPage(params.targetId, params.sessionId)
      }),
      client.on('Runtime.consoleAPICalled', (params, sessionId) => {
        this._recordConsoleEvent(params, sessionId)
      }),
      client.on('Runtime.executionContextDestroyed', (params, sessionId) => {
        const record = this._recordBySession(sessionId)
        if (record !== undefined) record.lastContextDestroyedAt = Date.now()
        void params
      }),
      client.on('Log.entryAdded', (params, sessionId) => {
        this._recordLogEvent(params, sessionId)
      }),
      client.on('Network.requestWillBeSent', (params, sessionId) => {
        this._recordRequestWillBeSent(params, sessionId)
      }),
      client.on('Network.responseReceived', (params, sessionId) => {
        this._recordResponseReceived(params, sessionId)
      }),
      client.on('Network.loadingFinished', (params, sessionId) => {
        this._recordLoadingFinished(params, sessionId)
      }),
      client.on('Network.loadingFailed', (params, sessionId) => {
        this._recordLoadingFailed(params, sessionId)
      }),
      client.on('Page.javascriptDialogOpening', (params, sessionId) => {
        this._handleJavaScriptDialog(params, sessionId)
      }),
      client.on('Page.screencastFrame', (params, sessionId) => {
        this._handleScreencastFrame(params, sessionId)
      }),
      client.on('Browser.downloadWillBegin', (params) => {
        this._recordDownloadBegin(params)
      }),
      client.on('Browser.downloadProgress', (params) => {
        this._recordDownloadProgress(params)
      }),
      client.on('Page.frameNavigated', (params, sessionId) => {
        const frame = params.frame
        if (frame === undefined || frame.parentId !== undefined) return
        const record = this._recordBySession(sessionId)
        if (record === undefined) return
        if (typeof frame.url === 'string' && frame.url !== '') record.url = frame.url
        this.lastSnapshotRefs.clear()
      }),
    ]
  }

  /** @returns {void} */
  _removeEventHandlers() {
    for (const off of this._eventOffs) {
      try {
        off()
      } catch {
        // ignore
      }
    }
    this._eventOffs = []
  }

  /**
   * @param {string} targetId
   * @param {string} [sessionId]
   */
  _forgetPage(targetId, sessionId) {
    for (const [id, record] of this.pages) {
      if (id !== targetId && (sessionId === undefined || record.sessionId !== sessionId)) continue
      this.pages.delete(id)
      if (this.currentPageId === id) {
        const next = this.pages.keys().next()
        this.currentPageId = next.done === true ? null : next.value
      }
    }
  }

  /**
   * @param {string | undefined} sessionId
   * @returns {any | undefined}
   */
  _recordBySession(sessionId) {
    if (typeof sessionId !== 'string') return undefined
    for (const record of this.pages.values()) {
      if (record.sessionId === sessionId) return record
    }
    return undefined
  }

  /**
   * Refresh url/title metadata from the target list.
   * @param {any} record
   * @returns {Promise<void>}
   */
  async _refreshTargetInfo(record) {
    const client = this.client
    if (client === null) return
    try {
      const result = await client.send('Target.getTargets', {}, { timeoutMs: 3000 })
      const infos = Array.isArray(result.targetInfos) ? result.targetInfos : []
      const info = infos.find((entry) => entry?.targetId === record.id)
      if (info === undefined) return
      if (typeof info.url === 'string') record.url = info.url
      if (typeof info.title === 'string') record.title = info.title
    } catch {
      // metadata is best effort
    }
  }

  /**
   * Choose the current page record, attaching one if needed.
   * @returns {Promise<any>}
   */
  async _currentRecord() {
    if (!this._isConnected()) throw this._notConnected()
    if (this.currentPageId !== null) {
      const record = this.pages.get(this.currentPageId)
      if (record !== undefined) return record
      this.currentPageId = null
    }
    const first = this.pages.values().next()
    if (first.done !== true) {
      this.currentPageId = first.value.id
      return first.value
    }
    const pages = await this._listPages()
    if (pages.length === 0) {
      throw new AutomationError('The browser has no open pages', {
        code: 'NO_PAGE',
        hint: 'Call action "new_page" to open a tab, then retry.',
      })
    }
    const record = await this._attachPage(pages[0].id)
    this.currentPageId = record.id
    return record
  }

  /**
   * @param {any} record
   * @returns {Promise<{ id: string, url: string, title: string }>}
   */
  async _pageInfo(record) {
    if (record === null || record === undefined) {
      return { id: '', url: '', title: '' }
    }
    try {
      const raw = await this._evalJson(
        'JSON.stringify({ url: window.location.href, title: document.title })',
        record,
        { timeoutMs: 2000 },
      )
      const parsed = typeof raw === 'string' ? parseJson(raw) : raw
      if (parsed !== null && typeof parsed === 'object') {
        if (typeof parsed.url === 'string' && parsed.url !== '') record.url = parsed.url
        if (typeof parsed.title === 'string') record.title = parsed.title
      }
    } catch {
      // fall back to cached target metadata
    }
    return { id: record.id, url: record.url, title: record.title }
  }

  /** @returns {Promise<Array<{ id: string, url: string, title: string, active: boolean }>>} */
  async _listPages() {
    if (!this._isConnected()) return []
    let targetInfos = []
    try {
      const result = await this.client.send('Target.getTargets', {}, { timeoutMs: 5000 })
      targetInfos = Array.isArray(result.targetInfos) ? result.targetInfos : []
    } catch (error) {
      this._log('warn', `Target.getTargets failed: ${errorTextOf(error)}`)
    }
    const pages = []
    const seen = new Set()
    for (const info of targetInfos) {
      if (info?.type !== 'page' || typeof info.targetId !== 'string') continue
      seen.add(info.targetId)
      pages.push({
        id: info.targetId,
        url: typeof info.url === 'string' ? info.url : '',
        title: typeof info.title === 'string' ? info.title : '',
        active: info.targetId === this.currentPageId,
      })
    }
    for (const [id, record] of this.pages) {
      if (seen.has(id)) continue
      pages.push({ id, url: record.url, title: record.title, active: id === this.currentPageId })
    }
    return pages
  }

  /**
   * @param {string} expression
   * @param {any} record
   * @param {{ timeoutMs?: number, awaitPromise?: boolean }} [options]
   * @returns {Promise<any>}
   */
  async _evalJson(expression, record, options = {}) {
    const client = this.client
    if (client === null) throw this._notConnected()
    const result = await client.send(
      'Runtime.evaluate',
      {
        expression,
        returnByValue: true,
        awaitPromise: options.awaitPromise === true,
        userGesture: true,
      },
      { sessionId: record.sessionId, timeoutMs: options.timeoutMs ?? this._commandTimeout() },
    )
    if (result.exceptionDetails !== undefined && result.exceptionDetails !== null) {
      throw this._exceptionError(result.exceptionDetails)
    }
    const remote = result.result
    if (remote === undefined || remote === null) return null
    if (remote.value !== undefined) return remote.value
    if (remote.type === 'undefined') return null
    return null
  }

  /**
   * @param {string} expression
   * @param {any} record
   * @param {{ timeoutMs?: number, awaitPromise?: boolean }} [options]
   * @returns {Promise<{ result: any, type: string, unserializable: boolean }>}
   */
  async _evaluateExpression(expression, record, options = {}) {
    const client = this.client
    if (client === null) throw this._notConnected()
    const result = await client.send(
      'Runtime.evaluate',
      {
        expression,
        returnByValue: true,
        awaitPromise: options.awaitPromise === true,
        userGesture: true,
      },
      { sessionId: record.sessionId, timeoutMs: options.timeoutMs ?? this._commandTimeout() },
    )
    if (result.exceptionDetails !== undefined && result.exceptionDetails !== null) {
      throw this._exceptionError(result.exceptionDetails)
    }
    const remote = result.result ?? {}
    if (remote.type === 'undefined') return { result: null, type: 'undefined', unserializable: false }
    if (remote.value !== undefined) return { result: remote.value, type: remote.type ?? 'unknown', unserializable: false }
    if (remote.type === 'object' && remote.subtype === 'null') {
      return { result: null, type: 'null', unserializable: false }
    }
    return {
      result: typeof remote.description === 'string' ? remote.description : null,
      type: remote.type ?? 'unknown',
      unserializable: true,
    }
  }

  /**
   * @param {any} details
   * @returns {AutomationError}
   */
  _exceptionError(details) {
    const exception = details?.exception
    let message = 'JavaScript exception'
    if (exception !== undefined && exception !== null) {
      if (typeof exception.description === 'string' && exception.description.trim() !== '') {
        message = exception.description
      } else if (exception.value !== undefined) {
        message = String(exception.value)
      }
    } else if (typeof details?.text === 'string') {
      message = details.text
    }
    const firstLine = message.split('\n')[0].slice(0, 500)
    return new AutomationError(`Page threw an exception: ${firstLine}`, {
      code: 'PAGE_EXCEPTION',
      hint: 'The evaluated expression raised inside the page. Use action "snapshot" to inspect the page, or adjust the expression.',
    })
  }

  /**
   * @param {string} expression
   * @param {any} record
   * @param {number} [timeoutMs]
   * @returns {Promise<string>}
   */
  async _readyState(record, timeoutMs = 2000) {
    try {
      const state = await this._evalJson('document.readyState', record, { timeoutMs })
      return typeof state === 'string' ? state : 'unknown'
    } catch {
      return 'unknown'
    }
  }

  // -- launch / connect / close -------------------------------------------

  /**
   * @param {string | undefined} value
   * @returns {string}
   */
  _browserKind(value) {
    const raw = typeof value === 'string' && value.trim() !== '' ? value.trim().toLowerCase() : undefined
    const fromConfig = typeof this.config.browserKind === 'string' ? this.config.browserKind.trim().toLowerCase() : undefined
    return raw ?? fromConfig ?? 'chrome'
  }

  /**
   * @param {Record<string, any>} args
   * @param {string} kind
   * @returns {string}
   */
  _resolveExecutable(args, kind) {
    const explicit = args.browserExecutable ?? this.config.browserExecutable
    if (typeof explicit === 'string' && explicit.trim() !== '') {
      const candidate = resolvePath(explicit.trim())
      if (which(candidate) !== null) return candidate
      throw new AutomationError(`Browser executable not found: ${candidate}`, {
        code: 'BROWSER_NOT_FOUND',
        hint: 'Install Chrome/Edge, or pass browserExecutable (and config.browserExecutable) with the correct path.',
      })
    }
    const candidate = BROWSER_EXECUTABLES[kind]
    if (candidate !== undefined && which(candidate) !== null) return candidate
    const fallbackNames = kind === 'edge' ? ['microsoft-edge', 'msedge'] : ['google-chrome', 'chromium', 'chrome']
    for (const name of fallbackNames) {
      const located = which(name)
      if (located !== null) return located
    }
    throw new AutomationError(`Could not find a Chromium browser for kind "${kind}"`, {
      code: 'BROWSER_NOT_FOUND',
      hint: 'Install Google Chrome or Microsoft Edge, or pass browserExecutable with the absolute path to the browser binary.',
    })
  }

  /**
   * Poll the DevTools HTTP endpoint until it answers.
   * @param {number} port
   * @param {number} timeoutMs
   * @returns {Promise<{ Browser?: string, webSocketDebuggerUrl?: string } | null>}
   */
  async _fetchVersion(port, timeoutMs = 20000) {
    const deadline = Date.now() + Math.max(100, timeoutMs)
    while (Date.now() < deadline) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
          signal: AbortSignal.timeout(Math.min(1500, Math.max(200, deadline - Date.now()))),
        })
        if (response.ok) {
          const payload = await response.json()
          if (payload !== null && typeof payload === 'object' && typeof payload.webSocketDebuggerUrl === 'string') {
            return payload
          }
        }
      } catch {
        // not ready yet
      }
      await sleep(150)
    }
    return null
  }

  /**
   * @param {Record<string, any>} args
   * @param {any} exec
   * @returns {Promise<Record<string, any>>}
   */
  async _launch(args, exec) {
    if (this._isConnected()) {
      if (typeof args.url === 'string' && args.url.trim() !== '') {
        await this._goto({ url: args.url, timeoutMs: args.timeoutMs })
      }
      return await this._result()
    }
    const kind = this._browserKind(args.browserKind)
    const executable = this._resolveExecutable(args, kind)
    const configuredPort = numberOr(args.port, numberOr(this.config.browserPort, null))
    if (configuredPort !== null && configuredPort > 0) {
      const existing = await this._fetchVersion(configuredPort, 900)
      if (existing !== null) {
        this._log('info', `reusing the browser already listening on port ${configuredPort}`)
        await this._connect({ port: configuredPort, viewport: args.viewport, url: args.url, timeoutMs: args.timeoutMs }, exec)
        return await this._result()
      }
    }
    const port = configuredPort !== null && configuredPort > 0 ? configuredPort : await findFreePort()
    if (!Number.isFinite(port) || port <= 0) {
      throw new AutomationError('Could not allocate a free port for the browser DevTools endpoint', {
        code: 'PORT_UNAVAILABLE',
        hint: 'Pass an explicit "port" argument that is not in use.',
      })
    }
    const headless = args.headless === undefined
      ? (this.config.browserHeadless === undefined ? true : this.config.browserHeadless !== false)
      : args.headless !== false
    const viewport = normalizeViewport(args.viewport)
    const noSandboxEnv = process.env.DSH_AUTOMATION_CHROME_NO_SANDBOX
    const noSandbox =
      args.noSandbox === true ||
      noSandboxEnv === '1' ||
      noSandboxEnv === 'true'
    let userDataDir
    if (typeof args.userDataDir === 'string' && args.userDataDir.trim() !== '') {
      userDataDir = resolvePath(args.userDataDir.trim())
    } else if (typeof this.config.browserUserDataDir === 'string' && this.config.browserUserDataDir.trim() !== '') {
      userDataDir = resolvePath(this.config.browserUserDataDir.trim())
    } else {
      userDataDir = resolvePath(await this._artifactDir(exec, 'browser-profile'))
    }
    await mkdir(userDataDir, { recursive: true })
    const extraArgs = Array.isArray(this.config.browserExtraArgs) ? this.config.browserExtraArgs : []
    const browserArgs = buildLaunchArgs({ port, userDataDir, headless, noSandbox, viewport, extraArgs })
    this._log('info', `launching ${executable} (port ${port}, headless=${headless})`)
    const child = spawn(executable, browserArgs, {
      stdio: ['ignore', 'ignore', 'pipe'],
      detached: true,
      env: { ...process.env },
    })
    this.child = child
    this.childPid = typeof child.pid === 'number' ? child.pid : null
    this.port = port
    this.userDataDir = userDataDir
    this.headless = headless
    this.browser = kind
    this.wsUrl = null
    let stderrTail = ''
    child.stderr?.on('data', (chunk) => {
      if (stderrTail.length < 8000) stderrTail += chunk.toString()
      else stderrTail = stderrTail.slice(-4000) + chunk.toString()
    })
    child.on('error', (error) => {
      this._log('warn', `browser process error: ${errorTextOf(error)}`)
    })
    child.once('exit', (code, signal) => {
      if (this._closingChild) return
      if (this.child !== child) return
      this._handleUnexpectedExit(code, signal)
    })
    let version = null
    try {
      const launchTimeout = clampNumber(this.config.browserLaunchTimeoutMs, 2000, 60000, 20000)
      version = await this._fetchVersion(port, launchTimeout)
    } catch (error) {
      this._log('warn', `failed while waiting for the browser: ${errorTextOf(error)}`)
    }
    if (version === null || typeof version.webSocketDebuggerUrl !== 'string') {
      this._closingChild = true
      await killProcessGroup(this.childPid ?? 0, 2000)
      await waitForChildExit(child, 3000)
      this._closingChild = false
      this.child = null
      this.childPid = null
      this.port = null
      this.userDataDir = null
      this.browser = null
      const detail = stderrTail.trim() === '' ? '' : `\nBrowser stderr:\n${stderrTail.trim().slice(-2000)}`
      const locked = /user data directory is already in use|ProcessSingleton|SingletonLock/iu.test(stderrTail)
      throw new AutomationError(`The browser did not expose a DevTools endpoint on port ${port}${detail}`, {
        code: 'BROWSER_LAUNCH_FAILED',
        hint: locked
          ? `Another browser instance is using ${userDataDir}. Call action "close" first, or pass a different userDataDir.`
          : 'Verify the browser binary runs from this shell (on macOS try launching Chrome once manually), and that the port is free.',
      })
    }
    this.wsUrl = version.webSocketDebuggerUrl
    if (typeof version.Browser === 'string') this.browser = version.Browser
    const client = new DevToolsClient({ timeoutMs: this._commandTimeout(), log: (level, message) => this._log(level, message) })
    try {
      await client.connect(version.webSocketDebuggerUrl, 10000)
    } catch (error) {
      this._closingChild = true
      await killProcessGroup(this.childPid ?? 0, 2000)
      await waitForChildExit(child, 3000)
      this._closingChild = false
      this._teardownState()
      throw error instanceof AutomationError
        ? error
        : new AutomationError(`Could not attach to the launched browser: ${errorTextOf(error)}`, {
          code: 'CDP_CONNECT_FAILED',
          hint: 'The browser started but its DevTools WebSocket refused the connection. Try action "close" then "launch" again.',
        })
    }
    await this._installClient(client, exec)
    if (viewport !== null) {
      try {
        await this._applyViewport(viewport)
      } catch (error) {
        this._log('warn', `could not apply the requested viewport: ${errorTextOf(error)}`)
      }
    }
    if (typeof args.url === 'string' && args.url.trim() !== '') {
      await this._goto({ url: args.url, timeoutMs: args.timeoutMs })
    }
    return await this._result()
  }

  /**
   * @param {Record<string, any>} args
   * @param {any} exec
   * @returns {Promise<Record<string, any>>}
   */
  async _connect(args, exec) {
    if (this._isConnected()) return await this._result()
    const port = numberOr(args.port, numberOr(this.config.browserPort, null))
    const requestedWsUrl = typeof args.wsUrl === 'string' && args.wsUrl.trim() !== '' ? args.wsUrl.trim() : null
    let wsUrl = requestedWsUrl
    if (wsUrl === null) {
      if (port === null || port <= 0) {
        throw new AutomationError('connect needs a "port" or "wsUrl"', {
          code: 'MISSING_PORT',
          hint: 'Start Chrome with --remote-debugging-port=<port> and pass that port, or pass the full wsUrl from /json/version.',
        })
      }
      const version = await this._fetchVersion(port, clampNumber(args.timeoutMs, 500, 30000, 5000))
      if (version === null) {
        throw new AutomationError(`No Chrome DevTools endpoint responded on http://127.0.0.1:${port}/json/version`, {
          code: 'CONNECT_FAILED',
          hint: 'Make sure the browser is running with --remote-debugging-port and --remote-allow-origins=*, or use action "launch".',
        })
      }
      wsUrl = version.webSocketDebuggerUrl
      if (typeof version.Browser === 'string') this.browser = version.Browser
      this.port = port
    } else {
      this.port = port !== null && port > 0 ? port : portFromWebSocketUrl(wsUrl)
      this.browser = this.browser ?? 'chromium (external)'
    }
    if (typeof wsUrl !== 'string' || wsUrl.length === 0) {
      throw new AutomationError('Could not determine the DevTools WebSocket URL', { code: 'CONNECT_FAILED' })
    }
    const client = new DevToolsClient({ timeoutMs: this._commandTimeout(), log: (level, message) => this._log(level, message) })
    await client.connect(wsUrl, 10000)
    this.wsUrl = wsUrl
    this.headless = null
    try {
      await this._installClient(client, exec)
      const viewport = normalizeViewport(args.viewport)
      if (viewport !== null) await this._applyViewport(viewport)
      if (typeof args.url === 'string' && args.url.trim() !== '') {
        await this._goto({ url: args.url, timeoutMs: args.timeoutMs })
      }
    } catch (error) {
      try {
        this.client?.close()
      } catch {
        // ignore
      }
      this.client = null
      this._removeEventHandlers()
      throw error
    }
    return await this._result()
  }

  /**
   * @param {number | null} code
   * @param {string | null} signal
   */
  _handleUnexpectedExit(code, signal) {
    this._log('warn', `browser process exited unexpectedly (code ${code}, signal ${signal})`)
    try {
      this.client?.close()
    } catch {
      // ignore
    }
    this._teardownState()
    this.downloads.clear()
    this.downloadDir = null
    this.lastSnapshotRefs.clear()
  }

  /** Reset connection state without killing anything. */
  _teardownState() {
    this._removeEventHandlers()
    this.client = null
    this.pages.clear()
    this._attaching.clear()
    this.currentPageId = null
    this.child = null
    this.childPid = null
    this.port = null
    this.wsUrl = null
    this.browser = null
    this.headless = null
    this.userDataDir = null
    this.recording = null
    this.downloads.clear()
    this.downloadDir = null
    this.lastSnapshotRefs.clear()
    this.viewportState = null
  }

  /**
   * @returns {Promise<Record<string, any>>}
   */
  async _close() {
    const hadChild = this.child !== null
    const hadClient = this._isConnected()
    if (this.recording !== null) {
      try {
        await this._recordStop({})
      } catch (error) {
        this._log('warn', `recording could not be finalized during close: ${errorTextOf(error)}`)
        this.recording = null
      }
    }
    await this._teardown()
    return { closed: true, killed: hadChild, disconnected: hadClient && !hadChild }
  }

  /** Stop the browser client and kill a launched browser process. */
  async _teardown() {
    this._removeEventHandlers()
    const client = this.client
    const child = this.child
    const pid = this.childPid
    this.client = null
    this.child = null
    this.childPid = null
    this._closingChild = true
    if (client !== null) {
      try {
        client.close()
      } catch {
        // ignore
      }
    }
    if (child !== null && pid !== null) {
      try {
        child.removeAllListeners('exit')
      } catch {
        // ignore
      }
      try {
        child.stderr?.removeAllListeners('data')
      } catch {
        // ignore
      }
      this._log('info', `closing browser process ${pid}`)
      await killProcessGroup(pid, 2500)
      await waitForChildExit(child, 3000)
      try {
        child.unref()
      } catch {
        // ignore
      }
    }
    this._closingChild = false
    this._teardownState()
  }

  /**
   * @returns {Promise<Record<string, any>>}
   */
  async _result() {
    const record = this.currentPageId === null ? undefined : this.pages.get(this.currentPageId)
    return {
      browser: this.browser,
      port: this.port,
      wsUrl: this.wsUrl,
      pid: this.childPid,
      userDataDir: this.userDataDir,
      headless: this.headless,
      page: record === undefined ? null : await this._pageInfo(record),
    }
  }

  /**
   * @returns {Promise<Record<string, any>>}
   */
  async _status() {
    const running = this._isConnected()
    const pages = running ? await this._listPages() : []
    let recording = null
    if (this.recording !== null) {
      recording = {
        frames: this.recording.frames.length,
        startedAt: this.recording.startedAt,
        elapsedMs: Date.now() - this.recording.startedAt,
        pageId: this.recording.pageId,
        path: this.recording.path,
      }
    }
    return {
      running,
      browser: this.browser,
      port: this.port,
      wsUrl: this.wsUrl,
      pid: this.childPid,
      headless: this.headless,
      userDataDir: this.userDataDir,
      pages,
      recording,
    }
  }

  /**
   * @param {Record<string, any>} args
   * @returns {Promise<Record<string, any>>}
   */
  async _newPage(args) {
    if (!this._isConnected()) throw this._notConnected()
    const client = this.client
    const created = await client.send('Target.createTarget', { url: 'about:blank' }, { timeoutMs: 10000 })
    const targetId = created.targetId
    if (typeof targetId !== 'string') {
      throw new AutomationError('The browser did not return a target id for the new page', { code: 'PAGE_CREATE_FAILED' })
    }
    const record = await this._attachPage(targetId)
    this.currentPageId = targetId
    try {
      await client.send('Page.bringToFront', {}, { sessionId: record.sessionId, timeoutMs: 5000 })
    } catch {
      // headed only convenience
    }
    if (typeof args.url === 'string' && args.url.trim() !== '') {
      await this._goto({ url: args.url, timeoutMs: args.timeoutMs, waitUntil: args.waitUntil })
    }
    await this._refreshTargetInfo(record)
    return { page: await this._pageInfo(record) }
  }

  /**
   * @param {Record<string, any>} args
   * @returns {Promise<Record<string, any>>}
   */
  async _selectPage(args) {
    if (!this._isConnected()) throw this._notConnected()
    const pageId = args.pageId
    if (typeof pageId !== 'string' || pageId.trim() === '') {
      throw new AutomationError('pageId must be a non-empty string', {
        code: 'MISSING_PAGE_ID',
        hint: 'Call action "pages" to list page ids, then pass one as pageId.',
      })
    }
    const id = pageId.trim()
    let record = this.pages.get(id)
    if (record === undefined) {
      const pages = await this._listPages()
      if (!pages.some((page) => page.id === id)) {
        throw new AutomationError(`No page with id "${id}"`, {
          code: 'PAGE_NOT_FOUND',
          hint: 'Call action "pages" to list the currently open page ids.',
        })
      }
      record = await this._attachPage(id)
    }
    this.currentPageId = id
    try {
      await this.client.send('Page.bringToFront', {}, { sessionId: record.sessionId, timeoutMs: 5000 })
    } catch {
      // headed only convenience
    }
    return { page: await this._pageInfo(record) }
  }

  // -- navigation ----------------------------------------------------------

  /**
   * @param {unknown} value
   * @returns {string}
   */
  _normalizeUrl(value) {
    let url = String(value).trim()
    if (url === '') {
      throw new AutomationError('url must be a non-empty string', { code: 'MISSING_URL' })
    }
    if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/u.test(url)) url = `https://${url}`
    return url
  }

  /**
   * @param {Record<string, any>} args
   * @returns {Promise<Record<string, any>>}
   */
  async _goto(args) {
    const record = await this._currentRecord()
    const client = this.client
    const url = this._normalizeUrl(args.url)
    const waitUntil = typeof args.waitUntil === 'string' ? args.waitUntil : 'load'
    if (!['load', 'domcontentloaded', 'networkidle', 'none'].includes(waitUntil)) {
      throw new AutomationError(`Unsupported waitUntil value: ${waitUntil}`, {
        code: 'INVALID_WAIT_UNTIL',
        hint: 'Use load, domcontentloaded, networkidle, or none.',
      })
    }
    const timeoutMs = this._timeoutArg(args, Math.max(this._commandTimeout(), 30000))
    let waiter = null
    if (waitUntil === 'load' || waitUntil === 'networkidle') {
      waiter = client
        .waitForEvent('Page.loadEventFired', { sessionId: record.sessionId, timeoutMs })
        .then(() => true)
        .catch(() => false)
    } else if (waitUntil === 'domcontentloaded') {
      waiter = client
        .waitForEvent('Page.domContentEventFired', { sessionId: record.sessionId, timeoutMs })
        .then(() => true)
        .catch(() => false)
    }
    const result = await client.send('Page.navigate', { url }, { sessionId: record.sessionId, timeoutMs })
    if (typeof result.errorText === 'string' && result.errorText !== '') {
      throw new AutomationError(`Navigation to ${url} failed: ${result.errorText}`, {
        code: 'NAVIGATION_FAILED',
        hint: 'Check the URL; for local files use a file:// URL, and for local servers make sure the server is running.',
      })
    }
    if (waiter !== null) {
      const loaded = await waiter
      if (!loaded) {
        const readyState = await this._readyState(record, 2000)
        if (waitUntil === 'load' && readyState !== 'complete') {
          throw new AutomationError(`Timed out after ${timeoutMs}ms waiting for the page to load: ${url}`, {
            code: 'NAVIGATION_TIMEOUT',
            hint: 'The page may still be loading (slow network or blocked resource). Retry, increase timeoutMs, or use waitUntil "domcontentloaded".',
          })
        }
        if (waitUntil === 'domcontentloaded' && readyState === 'loading') {
          throw new AutomationError(`Timed out after ${timeoutMs}ms waiting for DOMContentLoaded: ${url}`, {
            code: 'NAVIGATION_TIMEOUT',
            hint: 'Retry with a longer timeoutMs or waitUntil "load".',
          })
        }
      }
    }
    if (waitUntil === 'networkidle') {
      await this._waitNetworkIdle(record, Math.min(timeoutMs, 15000))
    }
    this.lastSnapshotRefs.clear()
    return {
      page: await this._pageInfo(record),
      status: this._documentStatus(record),
      waitUntil,
    }
  }

  /**
   * Main-document HTTP status from the buffered network log, when known.
   * @param {any} record
   * @returns {number | null}
   */
  _documentStatus(record) {
    let status = null
    for (const request of record.network.values()) {
      if (request.type === 'Document' && typeof request.status === 'number' && request.status > 0) {
        status = request.status
      }
    }
    return status
  }

  /**
   * @param {Record<string, any>} args
   * @returns {Promise<Record<string, any>>}
   */
  async _reload(args) {
    const record = await this._currentRecord()
    const client = this.client
    const timeoutMs = this._timeoutArg(args, 30000)
    const waiter = client
      .waitForEvent('Page.loadEventFired', { sessionId: record.sessionId, timeoutMs })
      .then(() => true)
      .catch(() => false)
    await client.send('Page.reload', { ignoreCache: args.ignoreCache === true }, { sessionId: record.sessionId, timeoutMs })
    await waiter
    await sleep(30)
    this.lastSnapshotRefs.clear()
    return { page: await this._pageInfo(record), reloaded: true }
  }

  /**
   * @param {number} delta
   * @returns {Promise<Record<string, any>>}
   */
  async _history(delta) {
    const record = await this._currentRecord()
    const client = this.client
    const history = await client.send('Page.getNavigationHistory', {}, { sessionId: record.sessionId, timeoutMs: 5000 })
    const entries = Array.isArray(history.entries) ? history.entries : []
    const index = numberOr(history.currentIndex, 0) + delta
    const entry = entries[index]
    if (entry === undefined) {
      return {
        page: await this._pageInfo(record),
        changed: false,
        historyIndex: numberOr(history.currentIndex, 0),
        note: delta < 0 ? 'There is no previous history entry' : 'There is no forward history entry',
      }
    }
    const loadWaiter = client
      .waitForEvent('Page.loadEventFired', { sessionId: record.sessionId, timeoutMs: 15000 })
      .then(() => true)
      .catch(() => false)
    const frameWaiter = client
      .waitForEvent('Page.frameNavigated', {
        sessionId: record.sessionId,
        timeoutMs: 15000,
        predicate: (params) => params.frame !== undefined && params.frame.parentId === undefined,
      })
      .then(() => true)
      .catch(() => false)
    await client.send('Page.navigateToHistoryEntry', { entryId: entry.id }, { sessionId: record.sessionId, timeoutMs: 10000 })
    const settled = await Promise.race([loadWaiter, frameWaiter])
    await sleep(settled ? 80 : 300)
    this.lastSnapshotRefs.clear()
    return { page: await this._pageInfo(record), changed: true, historyIndex: index }
  }

  // -- input ---------------------------------------------------------------

  /**
   * @param {any} record
   * @param {string} selector
   * @param {{ timeoutMs?: number, requireVisible?: boolean }} [options]
   * @returns {Promise<any>}
   */
  async _waitForElement(record, selector, options = {}) {
    const timeoutMs = Math.max(100, options.timeoutMs ?? 5000)
    const requireVisible = options.requireVisible !== false
    const startedAt = Date.now()
    let last = null
    while (true) {
      try {
        last = await this._evalJson(resolveExpression(selector, ELEMENT_BOX_BODY), record, { timeoutMs: 5000 })
      } catch (error) {
        if (Date.now() - startedAt >= timeoutMs) throw error
        last = null
      }
      if (last !== null && last.found === true) {
        if (!requireVisible || (numberOr(last.width, 0) > 0 && numberOr(last.height, 0) > 0)) return last
      }
      if (Date.now() - startedAt >= timeoutMs) {
        throw new AutomationError(
          `Element ${last !== null && last.found === true ? 'is not visible' : 'not found'} after ${timeoutMs}ms: ${selector}`,
          {
            code: 'SELECTOR_NOT_FOUND',
            hint: 'Call action "snapshot" to list visible interactive elements with their selectors and refs.',
          },
        )
      }
      await sleep(100)
    }
  }

  /**
   * @param {any} record
   * @param {string} type
   * @param {number} x
   * @param {number} y
   * @param {{ button?: string, buttons?: number, clickCount?: number, modifiers?: number }} [options]
   * @returns {Promise<void>}
   */
  async _dispatchMouse(record, type, x, y, options = {}) {
    const params = {
      type,
      x,
      y,
      button: options.button ?? 'none',
      buttons: options.buttons ?? 0,
      clickCount: options.clickCount ?? 0,
      modifiers: options.modifiers ?? 0,
    }
    await this.client.send('Input.dispatchMouseEvent', params, { sessionId: record.sessionId, timeoutMs: 5000 })
  }

  /**
   * @param {any} record
   * @param {{ key: string, code: string, vk: number, text?: string }} definition
   * @param {number} modifiers
   * @param {string[] | undefined} commands
   * @returns {Promise<void>}
   */
  async _dispatchKey(record, definition, modifiers = 0, commands = undefined) {
    const suppressText = (modifiers & (MODIFIER_ALT | MODIFIER_CTRL | MODIFIER_META)) !== 0
    const text = suppressText ? undefined : definition.text
    const down = {
      type: text === undefined ? 'rawKeyDown' : 'keyDown',
      key: definition.key,
      code: definition.code,
      windowsVirtualKeyCode: definition.vk,
      nativeVirtualKeyCode: 0,
      modifiers,
    }
    if (text !== undefined) down.text = text
    if (commands !== undefined) down.commands = commands
    await this.client.send('Input.dispatchKeyEvent', down, { sessionId: record.sessionId, timeoutMs: 5000 })
    await this.client.send(
      'Input.dispatchKeyEvent',
      {
        type: 'keyUp',
        key: definition.key,
        code: definition.code,
        windowsVirtualKeyCode: definition.vk,
        nativeVirtualKeyCode: 0,
        modifiers,
      },
      { sessionId: record.sessionId, timeoutMs: 5000 },
    )
  }

  /**
   * @param {any} record
   * @param {string} selector
   * @param {number} timeoutMs
   * @param {string} [body]
   * @returns {Promise<void>}
   */
  async _focusSelector(record, selector, timeoutMs, body = FOCUS_ONLY_BODY) {
    await this._waitForElement(record, selector, { timeoutMs })
    const focused = await this._evalJson(resolveExpression(selector, body), record)
    if (focused === null || focused.found !== true) {
      throw new AutomationError(`Could not focus the element: ${selector}`, { code: 'FOCUS_FAILED' })
    }
  }

  /**
   * Real mouse click / double click / hover at the element's viewport centre.
   * @param {Record<string, any>} args
   * @param {'click' | 'dblclick' | 'hover'} mode
   * @returns {Promise<Record<string, any>>}
   */
  async _clickLike(args, mode) {
    const record = await this._currentRecord()
    const selector = this._selectorArg(args)
    const timeoutMs = this._timeoutArg(args, 5000)
    const box = await this._waitForElement(record, selector, { timeoutMs })
    const x = numberOr(box.x, 0) + numberOr(box.width, 0) / 2
    const y = numberOr(box.y, 0) + numberOr(box.height, 0) / 2
    const button = args.button === 'right' || args.button === 'middle' ? args.button : 'left'
    const buttonBits = button === 'right' ? 2 : button === 'middle' ? 4 : 1
    const modifiers = parseModifiers(args.modifiers)
    await this._dispatchMouse(record, 'mouseMoved', x, y, { button: 'none', buttons: 0, modifiers })
    if (mode === 'hover') {
      return { hovered: true, selector, box: roundBox(box) }
    }
    const requested = clampInteger(args.clickCount, 1, 3, 1)
    const clicks = mode === 'dblclick' ? 2 : requested
    for (let index = 1; index <= clicks; index += 1) {
      await this._dispatchMouse(record, 'mousePressed', x, y, {
        button,
        buttons: buttonBits,
        clickCount: index,
        modifiers,
      })
      await this._dispatchMouse(record, 'mouseReleased', x, y, {
        button,
        buttons: 0,
        clickCount: index,
        modifiers,
      })
      if (index < clicks) await sleep(50)
    }
    return {
      clicked: true,
      selector,
      box: roundBox(box),
      button,
      clickCount: clicks,
      ...(mode === 'dblclick' ? { doubleClicked: true } : {}),
    }
  }

  /**
   * @param {Record<string, any>} args
   * @returns {Promise<Record<string, any>>}
   */
  async _fill(args) {
    const record = await this._currentRecord()
    const selector = this._selectorArg(args)
    const value = args.value === undefined || args.value === null ? '' : String(args.value)
    const clear = args.clear !== false
    const timeoutMs = this._timeoutArg(args, 5000)
    await this._waitForElement(record, selector, { timeoutMs })
    const focusBody = clear ? FOCUS_BODY : FOCUS_APPEND_BODY
    const focused = await this._evalJson(resolveExpression(selector, focusBody), record)
    if (focused === null || focused.found !== true) {
      throw new AutomationError(`Element not found for fill: ${selector}`, { code: 'SELECTOR_NOT_FOUND' })
    }
    if (focused.editable !== true) {
      throw new AutomationError(`Element is not an editable field: ${selector}`, {
        code: 'NOT_EDITABLE',
        hint: 'fill works on text inputs, textarea, and contenteditable elements only. Use click, type, check, or select_option for other controls.',
      })
    }
    if (focused.readonly === true) {
      throw new AutomationError(`Element is read-only: ${selector}`, {
        code: 'FIELD_READONLY',
        hint: 'The page marks this field readOnly; it cannot be filled directly.',
      })
    }
    if (focused.disabled === true) {
      throw new AutomationError(`Element is disabled: ${selector}`, {
        code: 'FIELD_DISABLED',
        hint: 'The page disables this field; wait for it to become enabled.',
      })
    }
    if (value === '') {
      if (clear) {
        await this._dispatchKey(record, resolveKey('Backspace'), 0)
      }
    } else {
      await this.client.send('Input.insertText', { text: value }, { sessionId: record.sessionId, timeoutMs: 5000 })
    }
    const state = await this._evalJson(
      resolveExpression(selector, String.raw`
        if (!__el) return null
        const __tag = __el.tagName.toLowerCase()
        if (__tag === 'input' || __tag === 'textarea') return { value: String(__el.value), tag: __tag }
        return { value: __dshText(__el).slice(0, 2000), tag: __tag }
      `),
      record,
    )
    const actual = state !== null && typeof state.value === 'string' ? state.value : null
    return {
      filled: true,
      selector,
      requested: value,
      value: actual,
      cleared: clear,
      verified: actual === value,
      box: roundBox(await this._waitForElement(record, selector, { timeoutMs: 2000 })),
    }
  }

  /**
   * @param {Record<string, any>} args
   * @returns {Promise<Record<string, any>>}
   */
  async _type(args) {
    const record = await this._currentRecord()
    const text = args.text
    if (typeof text !== 'string') {
      throw new AutomationError('text must be a string for action "type"', {
        code: 'INVALID_TEXT',
        hint: 'Pass e.g. {"action":"type","text":"hello"}.',
      })
    }
    const selector = typeof args.selector === 'string' && args.selector.trim() !== '' ? this._selectorArg(args) : null
    const timeoutMs = this._timeoutArg(args, 5000)
    if (selector !== null) await this._focusSelector(record, selector, timeoutMs)
    const delayMs = clampNumber(args.delayMs, 0, 1000, 0)
    if (text.length > 0) {
      if (delayMs <= 0) {
        await this.client.send('Input.insertText', { text }, { sessionId: record.sessionId, timeoutMs: 5000 })
      } else {
        for (const character of [...text]) {
          await this.client.send('Input.insertText', { text: character }, { sessionId: record.sessionId, timeoutMs: 5000 })
          await sleep(delayMs)
        }
      }
    }
    return { typed: true, text, selector, delayMs }
  }

  /**
   * @param {Record<string, any>} args
   * @returns {Promise<Record<string, any>>}
   */
  async _press(args) {
    const record = await this._currentRecord()
    const keyName = args.key ?? args.name
    const definition = resolveKey(keyName)
    const modifiers = parseModifiers(args.modifiers)
    const selector = typeof args.selector === 'string' && args.selector.trim() !== '' ? this._selectorArg(args) : null
    if (selector !== null) await this._focusSelector(record, selector, this._timeoutArg(args, 5000))
    const shift = (modifiers & MODIFIER_SHIFT) !== 0
    const finalDefinition = { ...definition }
    if (shift) {
      if (definition.shiftKey !== undefined) finalDefinition.key = definition.shiftKey
      if (definition.shiftText !== undefined) finalDefinition.text = definition.shiftText
    }
    if (definition.text === undefined) delete finalDefinition.text
    const commands = shortcutCommands(finalDefinition.key, modifiers)
    await this._dispatchKey(record, finalDefinition, modifiers, commands)
    const modifierNames = []
    if ((modifiers & MODIFIER_ALT) !== 0) modifierNames.push('alt')
    if ((modifiers & MODIFIER_CTRL) !== 0) modifierNames.push('ctrl')
    if ((modifiers & MODIFIER_META) !== 0) modifierNames.push('cmd')
    if ((modifiers & MODIFIER_SHIFT) !== 0) modifierNames.push('shift')
    return {
      pressed: true,
      key: finalDefinition.key,
      code: finalDefinition.code,
      modifiers: modifierNames,
      selector,
      commands: commands ?? [],
    }
  }

  /**
   * @param {Record<string, any>} args
   * @returns {Promise<Record<string, any>>}
   */
  async _selectOption(args) {
    const record = await this._currentRecord()
    const selector = this._selectorArg(args)
    const value = args.value === undefined || args.value === null ? '' : String(args.value)
    await this._waitForElement(record, selector, { timeoutMs: this._timeoutArg(args, 5000) })
    const result = await this._evalJson(
      resolveExpression(selector, String.raw`
        if (!__el) return { found: false }
        if (__el.tagName.toLowerCase() !== 'select') return { found: true, error: 'NOT_SELECT' }
        try { __el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }) } catch (error) {}
        const __value = ${JSON.stringify(value)}
        const __options = Array.prototype.slice.call(__el.options)
        let __option = __options.find((option) => option.value === __value)
        if (!__option) __option = __options.find((option) => String(option.label || option.text || '').trim() === __value)
        if (!__option) {
          return {
            found: true,
            error: 'OPTION_NOT_FOUND',
            options: __options.slice(0, 50).map((option) => ({ value: option.value, label: String(option.label || option.text || '').trim() })),
          }
        }
        const __descriptor = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')
        if (__descriptor && typeof __descriptor.set === 'function') __descriptor.set.call(__el, __option.value)
        else __el.value = __option.value
        __el.dispatchEvent(new Event('input', { bubbles: true }))
        __el.dispatchEvent(new Event('change', { bubbles: true }))
        return { found: true, value: __el.value, label: String(__option.label || __option.text || '').trim() }
      `),
      record,
    )
    if (result === null || result.found !== true) {
      throw new AutomationError(`Select element not found: ${selector}`, { code: 'SELECTOR_NOT_FOUND' })
    }
    if (result.error === 'NOT_SELECT') {
      throw new AutomationError(`Element is not a <select>: ${selector}`, {
        code: 'NOT_SELECT',
        hint: 'select_option only works on HTML select elements; use click or fill for other controls.',
      })
    }
    if (result.error === 'OPTION_NOT_FOUND') {
      const labels = Array.isArray(result.options)
        ? result.options.map((option) => `${option.value} (${option.label})`).join(', ')
        : ''
      throw new AutomationError(`No option with value or label "${value}" in ${selector}`, {
        code: 'OPTION_NOT_FOUND',
        hint: `Available options: ${labels}`,
      })
    }
    return { selected: true, selector, value: result.value, label: result.label }
  }

  /**
   * @param {Record<string, any>} args
   * @param {boolean} desired
   * @returns {Promise<Record<string, any>>}
   */
  async _check(args, desired) {
    const record = await this._currentRecord()
    const selector = this._selectorArg(args)
    const timeoutMs = this._timeoutArg(args, 5000)
    const box = await this._waitForElement(record, selector, { timeoutMs })
    const stateExpression = resolveExpression(selector, String.raw`
      if (!__el) return { found: false }
      const __tag = __el.tagName.toLowerCase()
      const __type = typeof __el.type === 'string' ? __el.type : ''
      let __checked
      if (__tag === 'input' && (__type === 'checkbox' || __type === 'radio')) __checked = __el.checked === true
      else __checked = __el.getAttribute('aria-checked') === 'true'
      return { found: true, checked: __checked, tag: __tag, type: __type, disabled: __el.disabled === true }
    `)
    const before = await this._evalJson(stateExpression, record)
    if (before === null || before.found !== true) {
      throw new AutomationError(`Element not found: ${selector}`, { code: 'SELECTOR_NOT_FOUND' })
    }
    if (before.disabled === true) {
      throw new AutomationError(`Element is disabled: ${selector}`, { code: 'FIELD_DISABLED' })
    }
    if (before.type === 'radio' && desired === false) {
      throw new AutomationError(`A radio button cannot be unchecked: ${selector}`, {
        code: 'RADIO_CANNOT_UNCHECK',
        hint: 'Select a different radio option instead.',
      })
    }
    if (before.checked === desired) {
      return { checked: desired, changed: false, selector, box: roundBox(box) }
    }
    const x = numberOr(box.x, 0) + numberOr(box.width, 0) / 2
    const y = numberOr(box.y, 0) + numberOr(box.height, 0) / 2
    const readCheckState = async () => {
      const state = await this._evalJson(stateExpression, record)
      return state !== null && state.found === true ? state : null
    }
    const waitForCheckState = async (waitMs) => {
      const deadline = Date.now() + waitMs
      while (true) {
        const state = await readCheckState()
        if (state !== null && state.checked === desired) return state
        if (Date.now() >= deadline) return state
        await sleep(80)
      }
    }
    await this._dispatchMouse(record, 'mouseMoved', x, y, { button: 'none', buttons: 0 })
    await this._dispatchMouse(record, 'mousePressed', x, y, { button: 'left', buttons: 1, clickCount: 1 })
    await this._dispatchMouse(record, 'mouseReleased', x, y, { button: 'left', buttons: 0, clickCount: 1 })
    let after = await waitForCheckState(700)
    if (after === null || after.checked !== desired) {
      // Page scripts sometimes react later or the control is covered; fall back to
      // the DOM click (still a real user activation) and give the page time to react.
      await this._evalJson(
        resolveExpression(selector, String.raw`
          if (!__el) return { found: false }
          if (typeof __el.click === 'function') __el.click()
          return { found: true }
        `),
        record,
      )
      after = await waitForCheckState(700)
    }
    const checked = after !== null && after.found === true ? after.checked === true : desired
    if (checked !== desired) {
      throw new AutomationError(`Could not ${desired ? 'check' : 'uncheck'} ${selector}`, {
        code: 'CHECK_FAILED',
        hint: 'The control may be covered by another element or controlled by page script; try action "snapshot" to inspect it.',
      })
    }
    return { checked: desired, changed: true, selector, box: roundBox(box) }
  }

  /**
   * @param {Record<string, any>} args
   * @returns {Promise<Record<string, any>>}
   */
  async _scroll(args) {
    const record = await this._currentRecord()
    const selector = typeof args.selector === 'string' && args.selector.trim() !== '' ? this._selectorArg(args) : null
    const deltaX = numberOr(args.deltaX, 0)
    const deltaY = numberOr(args.deltaY, 0)
    const wantsAbsolute = args.x !== undefined || args.y !== undefined
    const x = numberOr(args.x, null)
    const y = numberOr(args.y, null)
    if (selector !== null) {
      await this._waitForElement(record, selector, { timeoutMs: this._timeoutArg(args, 5000) })
    }
    const tail = String.raw`
      const __absolute = ${wantsAbsolute ? 'true' : 'false'}
      if (__absolute) {
        window.scrollTo({ left: ${x === null ? 'window.scrollX' : x}, top: ${y === null ? 'window.scrollY' : y}, behavior: 'instant' })
      }
      const __deltaX = ${deltaX}
      const __deltaY = ${deltaY}
      if (__deltaX !== 0 || __deltaY !== 0) window.scrollBy({ left: __deltaX, top: __deltaY, behavior: 'instant' })
      return { found: true, scrollX: window.scrollX, scrollY: window.scrollY }
    `
    const expression = selector !== null
      ? resolveExpression(selector, `if (!__el) return { found: false }; try { __el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }) } catch (error) {}${tail}`)
      : plainExpression(tail)
    const result = await this._evalJson(expression, record)
    if (selector !== null && (result === null || result === undefined || result.found === false)) {
      throw new AutomationError(`Element not found for scroll: ${selector}`, { code: 'SELECTOR_NOT_FOUND' })
    }
    return {
      scrolled: true,
      selector,
      scrollX: numberOr(result?.scrollX, 0),
      scrollY: numberOr(result?.scrollY, 0),
    }
  }

  // -- waiting / perception ------------------------------------------------

  /**
   * @param {Record<string, any>} args
   * @returns {Promise<Record<string, any>>}
   */
  async _waitFor(args) {
    const record = await this._currentRecord()
    const timeoutMs = this._timeoutArg(args, 10000)
    const startedAt = Date.now()
    const selector = typeof args.selector === 'string' && args.selector.trim() !== '' ? this._selectorArg(args) : null
    const text = typeof args.text === 'string' && args.text !== '' ? args.text : null
    const state = typeof args.state === 'string' ? args.state : 'visible'
    const networkIdle = args.networkIdle === true
    if (selector === null && text === null && !networkIdle) {
      throw new AutomationError('wait_for needs a selector, text, or networkIdle', {
        code: 'MISSING_WAIT_TARGET',
        hint: 'Pass e.g. {"action":"wait_for","selector":"#ready"} or {"action":"wait_for","text":"Done"}.',
      })
    }
    if (!['visible', 'hidden', 'attached', 'detached'].includes(state)) {
      throw new AutomationError(`Unsupported wait state: ${state}`, {
        code: 'INVALID_STATE',
        hint: 'Use visible, hidden, attached, or detached.',
      })
    }
    const stateExpression = selector === null
      ? null
      : resolveExpression(selector, String.raw`
          if (!__el) return { exists: false, visible: false }
          const __rect = __el.getBoundingClientRect()
          const __visible = __dshVisible(__el) && __rect.width > 0 && __rect.height > 0
          return { exists: true, visible: __visible }
        `)
    let idleSince = 0
    let lastDetail = ''
    while (true) {
      let matched = true
      if (stateExpression !== null) {
        let info = null
        try {
          info = await this._evalJson(stateExpression, record, { timeoutMs: 5000 })
        } catch (error) {
          if (!(error instanceof AutomationError) || error.code !== 'CDP_ERROR') throw error
        }
        const exists = info !== null && info.exists === true
        const visible = info !== null && info.visible === true
        lastDetail = `selector state: exists=${exists} visible=${visible}, wanted ${state}`
        if (state === 'visible') matched = visible
        else if (state === 'hidden') matched = !visible
        else if (state === 'attached') matched = exists
        else matched = !exists
      }
      if (matched && text !== null) {
        let bodyText = ''
        try {
          bodyText = await this._evalJson(
            '(() => (document.body && document.body.innerText) || "")()',
            record,
            { timeoutMs: 5000 },
          )
        } catch {
          bodyText = ''
        }
        const found = String(bodyText ?? '').toLowerCase().includes(text.toLowerCase())
        lastDetail = `page text ${found ? 'contains' : 'does not contain'} ${JSON.stringify(text)}`
        matched = matched && found
      }
      if (matched && networkIdle) {
        const pending = record.pendingRequests.size
        if (pending === 0) {
          if (idleSince === 0) idleSince = Date.now()
          if (Date.now() - idleSince >= 500) matched = true
          else matched = false
        } else {
          idleSince = 0
          matched = false
        }
        lastDetail = `${pending} request(s) in flight`
      }
      if (matched) {
        return { matched: true, elapsedMs: Date.now() - startedAt, selector, text, state, networkIdle }
      }
      if (Date.now() - startedAt >= timeoutMs) {
        throw new AutomationError(`Timed out after ${timeoutMs}ms waiting for the page`, {
          code: 'WAIT_TIMEOUT',
          hint: `Last observation: ${lastDetail || 'no state change'}. Call action "snapshot" to inspect the current page, or increase timeoutMs.`,
        })
      }
      await sleep(100)
    }
  }

  /**
   * One Runtime.evaluate that returns visible interactive elements plus bounded text.
   * @param {Record<string, any>} args
   * @returns {Promise<Record<string, any>>}
   */
  async _snapshot(args) {
    const record = await this._currentRecord()
    const maxText = clampInteger(args.maxText, 0, 100000, 4000)
    const maxElements = clampInteger(args.maxElements, 1, 500, 200)
    const expression = SNAPSHOT_JS
      .replace('__MAX_ELEMENTS__', String(maxElements))
      .replace('__MAX_TEXT__', String(maxText))
    const raw = await this._evalJson(expression, record, { timeoutMs: Math.max(this._commandTimeout(), 10000) })
    if (raw === null || typeof raw !== 'object') {
      throw new AutomationError('The page returned no snapshot payload', {
        code: 'SNAPSHOT_FAILED',
        hint: 'The page may be navigating or blocked. Retry, or call action "status".',
      })
    }
    const elements = Array.isArray(raw.elements) ? raw.elements : []
    this.lastSnapshotRefs = new Map()
    for (const element of elements) {
      if (typeof element.ref === 'string' && typeof element.selector === 'string') {
        this.lastSnapshotRefs.set(element.ref.toLowerCase(), element.selector)
      }
    }
    if (typeof raw.url === 'string') record.url = raw.url
    if (typeof raw.title === 'string') record.title = raw.title
    return {
      page: { id: record.id, url: record.url, title: record.title },
      elements,
      text: typeof raw.text === 'string' ? raw.text : '',
      truncated: raw.truncated === true,
      totalTextLength: numberOr(raw.totalTextLength, 0),
      totalElements: numberOr(raw.totalElements, elements.length),
    }
  }

  /**
   * @param {Record<string, any>} args
   * @returns {Promise<Record<string, any>>}
   */
  async _eval(args) {
    const record = await this._currentRecord()
    const expression = args.expression
    if (typeof expression !== 'string' || expression.trim() === '') {
      throw new AutomationError('expression must be a non-empty string for action "eval"', {
        code: 'MISSING_EXPRESSION',
        hint: 'Pass e.g. {"action":"eval","expression":"document.title"}.',
      })
    }
    const evaluated = await this._evaluateExpression(expression, record, {
      awaitPromise: args.awaitPromise === true,
      timeoutMs: this._timeoutArg(args, this._commandTimeout()),
    })
    return evaluated
  }

  // -- capture -------------------------------------------------------------

  /**
   * @param {Record<string, any>} args
   * @param {any} exec
   * @returns {Promise<Record<string, any>>}
   */
  async _screenshot(args, exec) {
    const record = await this._currentRecord()
    const format = args.format === 'jpeg' || args.format === 'jpg' ? 'jpeg' : 'png'
    const extension = format === 'jpeg' ? 'jpg' : 'png'
    const timeoutMs = this._timeoutArg(args, Math.max(this._commandTimeout(), 30000))
    let outputPath
    if (typeof args.path === 'string' && args.path.trim() !== '') {
      outputPath = resolvePath(args.path.trim())
    } else {
      outputPath = await this._artifactPath(exec, 'browser', extension)
    }
    await mkdir(dirname(outputPath), { recursive: true })
    const params = { format, fromSurface: true, captureBeyondViewport: false }
    if (format === 'jpeg') params.quality = clampInteger(args.quality, 1, 100, 80)
    if (args.fullPage === true) {
      const metrics = await this.client.send('Page.getLayoutMetrics', {}, { sessionId: record.sessionId, timeoutMs })
      const size = metrics.cssContentSize ?? metrics.contentSize ?? {}
      const width = Math.max(1, Math.ceil(numberOr(size.width, DEFAULT_VIEWPORT.width)))
      const height = Math.max(1, Math.ceil(numberOr(size.height, DEFAULT_VIEWPORT.height)))
      params.captureBeyondViewport = true
      params.clip = { x: 0, y: 0, width, height, scale: 1 }
    } else if (typeof args.selector === 'string' && args.selector.trim() !== '') {
      const selector = this._selectorArg(args)
      await this._waitForElement(record, selector, { timeoutMs: this._timeoutArg(args, 5000) })
      const box = await this._evalJson(
        resolveExpression(selector, String.raw`
          if (!__el) return { found: false }
          const __rect = __el.getBoundingClientRect()
          return {
            found: true,
            x: __rect.left + window.scrollX,
            y: __rect.top + window.scrollY,
            width: __rect.width,
            height: __rect.height,
          }
        `),
        record,
      )
      const width = Math.max(1, Math.ceil(numberOr(box?.width, 1)))
      const height = Math.max(1, Math.ceil(numberOr(box?.height, 1)))
      params.captureBeyondViewport = true
      params.clip = {
        x: Math.max(0, numberOr(box?.x, 0)),
        y: Math.max(0, numberOr(box?.y, 0)),
        width,
        height,
        scale: 1,
      }
    }
    const result = await this.client.send('Page.captureScreenshot', params, {
      sessionId: record.sessionId,
      timeoutMs,
    })
    const data = result.data
    if (typeof data !== 'string' || data.length === 0) {
      throw new AutomationError('Chrome returned an empty screenshot', { code: 'SCREENSHOT_FAILED' })
    }
    const buffer = Buffer.from(data, 'base64')
    if (buffer.length === 0) {
      throw new AutomationError('Chrome returned an empty screenshot buffer', { code: 'SCREENSHOT_FAILED' })
    }
    await writeFile(outputPath, buffer)
    const info = await stat(outputPath)
    const dimensions = imageDimensions(buffer)
    return {
      path: outputPath,
      width: numberOr(dimensions.width, Math.ceil(numberOr(params.clip?.width, 0))),
      height: numberOr(dimensions.height, Math.ceil(numberOr(params.clip?.height, 0))),
      bytes: info.size,
      format,
      page: { id: record.id, url: record.url, title: record.title },
    }
  }

  /**
   * @param {Record<string, any>} args
   * @param {any} exec
   * @returns {Promise<Record<string, any>>}
   */
  async _pdf(args, exec) {
    const record = await this._currentRecord()
    let outputPath
    if (typeof args.path === 'string' && args.path.trim() !== '') {
      outputPath = resolvePath(args.path.trim())
    } else {
      outputPath = await this._artifactPath(exec, 'browser', 'pdf')
    }
    await mkdir(dirname(outputPath), { recursive: true })
    const params = {
      printBackground: args.printBackground !== false,
      preferCSSPageSize: args.preferCSSPageSize === true,
      displayHeaderFooter: args.displayHeaderFooter === true,
    }
    if (args.landscape === true) params.landscape = true
    if (args.paperWidth !== undefined) params.paperWidth = numberOr(args.paperWidth, 8.5)
    if (args.paperHeight !== undefined) params.paperHeight = numberOr(args.paperHeight, 11)
    const result = await this.client.send('Page.printToPDF', params, {
      sessionId: record.sessionId,
      timeoutMs: Math.max(this._commandTimeout(), 45000),
    })
    const data = result.data
    if (typeof data !== 'string' || data.length === 0) {
      throw new AutomationError('Chrome returned an empty PDF', { code: 'PDF_FAILED' })
    }
    const buffer = Buffer.from(data, 'base64')
    await writeFile(outputPath, buffer)
    const info = await stat(outputPath)
    return { path: outputPath, bytes: info.size, format: 'pdf', page: { id: record.id, url: record.url } }
  }

  // -- recording -----------------------------------------------------------

  /**
   * @param {Record<string, any>} args
   * @param {any} exec
   * @returns {Promise<Record<string, any>>}
   */
  async _recordStart(args, exec) {
    const record = await this._currentRecord()
    if (this.recording !== null) {
      throw new AutomationError('A browser recording is already running', {
        code: 'RECORDING_ACTIVE',
        hint: 'Call action "record_stop" first, then start a new recording.',
      })
    }
    let outputPath
    if (typeof args.path === 'string' && args.path.trim() !== '') {
      outputPath = resolvePath(args.path.trim())
    } else {
      outputPath = await this._artifactPath(exec, 'browser', 'mp4')
    }
    const framesDir = join(
      dirname(outputPath),
      `${basename(outputPath).replace(/\.[^.]+$/u, '')}-frames-${stamp()}`,
    )
    await mkdir(framesDir, { recursive: true })
    const quality = clampInteger(args.quality, 1, 100, 80)
    const maxWidth = args.maxWidth === undefined ? undefined : clampInteger(args.maxWidth, 100, 4096, 1280)
    const fps = args.fps === undefined ? null : clampNumber(args.fps, 1, 60, 15)
    const params = { format: 'jpeg', quality, everyNthFrame: 1 }
    if (maxWidth !== undefined) params.maxWidth = maxWidth
    this.recording = {
      sessionId: record.sessionId,
      pageId: record.id,
      framesDir,
      path: outputPath,
      startedAt: Date.now(),
      frames: [],
      writes: [],
      stopRequested: false,
      quality,
      fps,
      lastAcceptedAt: 0,
      skippedFrames: 0,
    }
    try {
      await this.client.send('Page.startScreencast', params, { sessionId: record.sessionId, timeoutMs: 10000 })
    } catch (error) {
      this.recording = null
      throw new AutomationError(`Could not start the browser screencast: ${errorTextOf(error)}`, {
        code: 'RECORD_START_FAILED',
        hint: 'The page may be closed or the browser connection dropped. Check action "status" and retry.',
      })
    }
    return {
      recording: true,
      frames: 0,
      framesDir,
      path: outputPath,
      quality,
      maxWidth: maxWidth ?? null,
      fps,
      startedAt: this.recording.startedAt,
      pageId: record.id,
    }
  }

  /**
   * @param {Record<string, any>} params
   * @param {string | undefined} sessionId
   */
  _handleScreencastFrame(params, sessionId) {
    if (typeof sessionId !== 'string') return
    const client = this.client
    if (client === null) return
    // Ack immediately: the renderer waits for the ack before emitting the next frame.
    client
      .send('Page.screencastFrameAck', { sessionId: params.sessionId }, { sessionId, timeoutMs: 3000 })
      .catch(() => {})
    const recording = this.recording
    if (recording === null || recording.stopRequested) return
    if (recording.sessionId !== sessionId) return
    const now = Date.now()
    if (recording.fps !== null && recording.fps > 0) {
      const interval = 1000 / recording.fps
      if (now - recording.lastAcceptedAt < interval - 5) {
        recording.skippedFrames += 1
        return
      }
    }
    recording.lastAcceptedAt = now
    recording.frames.push({ file: '', t: now, bytes: 0, error: null })
    const entry = recording.frames[recording.frames.length - 1]
    const index = recording.frames.length
    const filename = `frame-${String(index).padStart(5, '0')}.jpg`
    entry.file = filename
    const filePath = join(recording.framesDir, filename)
    const data = typeof params.data === 'string' ? params.data : ''
    const write = writeFile(filePath, Buffer.from(data, 'base64'))
      .then(async () => {
        try {
          const info = await stat(filePath)
          entry.bytes = info.size
        } catch {
          entry.bytes = 0
        }
      })
      .catch((error) => {
        entry.error = errorTextOf(error)
      })
    recording.writes.push(write)
  }

  /**
   * @param {Record<string, any>} args
   * @returns {Promise<Record<string, any>>}
   */
  async _recordStop(args) {
    const recording = this.recording
    if (recording === null) {
      throw new AutomationError('No browser recording is running', {
        code: 'NO_RECORDING',
        hint: 'Call action "record_start" before "record_stop".',
      })
    }
    const client = this.client
    recording.stopRequested = true
    if (client !== null && client.connected) {
      try {
        await client.send('Page.stopScreencast', {}, { sessionId: recording.sessionId, timeoutMs: 5000 })
      } catch (error) {
        this._log('debug', `Page.stopScreencast failed: ${errorTextOf(error)}`)
      }
    }
    await Promise.race([Promise.allSettled(recording.writes.slice()), sleep(10000)])
    // If no frame arrived (static page, very short recording), nudge a repaint once.
    if (recording.frames.length === 0 && client !== null && client.connected) {
      recording.stopRequested = false
      try {
        await client.send('Page.startScreencast', { format: 'jpeg', quality: recording.quality, everyNthFrame: 1 }, { sessionId: recording.sessionId, timeoutMs: 5000 })
        await this._evalJson(
          '(() => { const d = document.createElement("div"); d.id = "__dsh_nudge"; d.style.cssText = "position:fixed;left:0;top:0;width:4px;height:4px;background:rgba(0,0,0,0.01);z-index:2147483647"; document.body.appendChild(d); requestAnimationFrame(() => { d.style.left = "6px" }); setTimeout(() => { d.remove() }, 900); return true })()',
          this._recordBySession(recording.sessionId) ?? { sessionId: recording.sessionId },
        ).catch(() => {})
        await sleep(900)
      } catch (error) {
        this._log('debug', `screencast repaint nudge failed: ${errorTextOf(error)}`)
      }
      if (client.connected) {
        try {
          await client.send('Page.stopScreencast', {}, { sessionId: recording.sessionId, timeoutMs: 5000 })
        } catch {
          // ignore
        }
      }
      await Promise.race([Promise.allSettled(recording.writes.slice()), sleep(5000)])
    }
    this.recording = null
    const frames = recording.frames
      .filter((frame) => frame.file !== '' && frame.error === null)
      .sort((left, right) => left.t - right.t)
    if (frames.length === 0) {
      throw new AutomationError('The recording captured no screencast frames', {
        code: 'NO_FRAMES',
        hint: 'The page did not paint during the recording. Headless Chrome only emits frames on visual updates; make sure the page changes while recording.',
      })
    }
    const durations = []
    let durationMs = 0
    for (let index = 0; index < frames.length; index += 1) {
      const next = frames[index + 1]
      const raw = next === undefined ? 100 : next.t - frames[index].t
      const clamped = Math.min(2000, Math.max(20, raw))
      durations.push(clamped)
      durationMs += clamped
    }
    const concatLines = []
    for (let index = 0; index < frames.length; index += 1) {
      concatLines.push(`file ${concatQuote(join(recording.framesDir, frames[index].file))}`)
      concatLines.push(`duration ${(durations[index] / 1000).toFixed(4)}`)
    }
    // The concat demuxer needs the final file repeated to materialise the last duration.
    concatLines.push(`file ${concatQuote(join(recording.framesDir, frames[frames.length - 1].file))}`)
    concatLines.push(`duration ${(durations[durations.length - 1] / 1000).toFixed(4)}`)
    const listPath = join(recording.framesDir, 'frames.txt')
    await writeFile(listPath, `${concatLines.join('\n')}\n`)
    const frameBytes = frames.reduce((total, frame) => total + numberOr(frame.bytes, 0), 0)
    const ffmpeg = which('ffmpeg')
    if (ffmpeg === null) {
      return {
        encoder: 'frames',
        path: recording.framesDir,
        framesDir: recording.framesDir,
        frames: frames.length,
        durationMs,
        bytes: frameBytes,
        framesList: listPath,
        note: 'ffmpeg was not found; the JPEG frames and frames.txt concat list were kept so the recording can be encoded later.',
      }
    }
    const baseArgs = (fpsModeFlag) => [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-f',
      'concat',
      '-safe',
      '0',
      '-i',
      listPath,
      '-vf',
      'scale=trunc(iw/2)*2:trunc(ih/2)*2',
      ...fpsModeFlag,
      '-pix_fmt',
      'yuv420p',
      '-movflags',
      '+faststart',
      recording.path,
    ]
    let encode = await run(ffmpeg, baseArgs(['-fps_mode', 'vfr']), { timeoutMs: 120000 })
    if (encode.code !== 0 && /unrecognized option .?fps_mode/iu.test(encode.stderr)) {
      encode = await run(ffmpeg, baseArgs(['-vsync', 'vfr']), { timeoutMs: 120000 })
    }
    let bytes = 0
    try {
      const info = await stat(recording.path)
      bytes = info.size
    } catch {
      bytes = 0
    }
    if (encode.code !== 0 || bytes <= 0) {
      this._log('warn', `ffmpeg encoding failed: ${encode.stderr.slice(-1000)}`)
      return {
        encoder: 'frames',
        path: recording.framesDir,
        framesDir: recording.framesDir,
        frames: frames.length,
        durationMs,
        bytes: frameBytes,
        framesList: listPath,
        note: `ffmpeg could not encode the recording (exit ${encode.code}); JPEG frames and frames.txt were kept. ${encode.stderr.trim().slice(-500)}`,
      }
    }
    return {
      encoder: 'ffmpeg',
      path: recording.path,
      framesDir: recording.framesDir,
      frames: frames.length,
      durationMs,
      bytes,
      quality: recording.quality,
      fps: recording.fps,
      skippedFrames: recording.skippedFrames,
    }
  }

  // -- observation ---------------------------------------------------------

  /**
   * @param {Record<string, any>} params
   * @param {string | undefined} sessionId
   */
  _recordConsoleEvent(params, sessionId) {
    const record = this._recordBySession(sessionId)
    if (record === undefined) return
    const args = Array.isArray(params.args) ? params.args : []
    const text = args.map((entry) => remoteObjectText(entry)).join(' ').slice(0, 4000)
    const timestampRaw = numberOr(params.timestamp, Date.now())
    const timestamp = timestampRaw > 1e12 ? Math.round(timestampRaw) : Math.round(timestampRaw * 1000)
    const level = CONSOLE_LEVELS[params.type] ?? 'log'
    record.console.push({ level, text, timestamp, source: 'console' })
    if (record.console.length > 200) record.console.splice(0, record.console.length - 200)
  }

  /**
   * @param {Record<string, any>} params
   * @param {string | undefined} sessionId
   */
  _recordLogEvent(params, sessionId) {
    const record = this._recordBySession(sessionId)
    if (record === undefined) return
    const entry = params.entry ?? {}
    const timestampRaw = numberOr(entry.timestamp, Date.now())
    const timestamp = timestampRaw > 1e12 ? Math.round(timestampRaw) : Math.round(timestampRaw * 1000)
    const level = CONSOLE_LEVELS[entry.level] ?? 'log'
    record.console.push({
      level,
      text: typeof entry.text === 'string' ? entry.text.slice(0, 4000) : `[${entry.level ?? 'log'}] ${entry.url ?? ''}`,
      timestamp,
      source: 'log',
    })
    if (record.console.length > 200) record.console.splice(0, record.console.length - 200)
  }

  /**
   * @param {Record<string, any>} params
   * @param {string | undefined} sessionId
   */
  _recordRequestWillBeSent(params, sessionId) {
    const record = this._recordBySession(sessionId)
    if (record === undefined) return
    const requestId = params.requestId
    if (typeof requestId !== 'string') return
    const request = params.request ?? {}
    const entry = {
      url: typeof request.url === 'string' ? request.url : '',
      method: typeof request.method === 'string' ? request.method : 'GET',
      status: null,
      failed: false,
      error: null,
      type: typeof params.type === 'string' ? params.type : null,
      timestamp: Date.now(),
    }
    record.network.set(requestId, entry)
    record.pendingRequests.add(requestId)
    if (record.network.size > 300) {
      const oldest = record.network.keys().next()
      if (oldest.done !== true) {
        record.network.delete(oldest.value)
        record.pendingRequests.delete(oldest.value)
      }
    }
  }

  /**
   * @param {Record<string, any>} params
   * @param {string | undefined} sessionId
   */
  _recordResponseReceived(params, sessionId) {
    const record = this._recordBySession(sessionId)
    if (record === undefined) return
    const entry = record.network.get(params.requestId)
    if (entry === undefined) return
    const response = params.response ?? {}
    if (typeof response.status === 'number') entry.status = response.status
    if (typeof params.type === 'string') entry.type = params.type
  }

  /**
   * @param {Record<string, any>} params
   * @param {string | undefined} sessionId
   */
  _recordLoadingFinished(params, sessionId) {
    const record = this._recordBySession(sessionId)
    if (record === undefined) return
    record.pendingRequests.delete(params.requestId)
  }

  /**
   * @param {Record<string, any>} params
   * @param {string | undefined} sessionId
   */
  _recordLoadingFailed(params, sessionId) {
    const record = this._recordBySession(sessionId)
    if (record === undefined) return
    record.pendingRequests.delete(params.requestId)
    const entry = record.network.get(params.requestId)
    if (entry === undefined) return
    entry.failed = true
    entry.error = typeof params.errorText === 'string' ? params.errorText : 'request failed'
    if (params.canceled === true) entry.error = 'request canceled'
  }

  /**
   * @param {Record<string, any>} params
   * @param {string | undefined} sessionId
   */
  _handleJavaScriptDialog(params, sessionId) {
    const record = this._recordBySession(sessionId)
    if (record !== undefined) {
      record.console.push({
        level: 'dialog',
        text: `${params.type ?? 'dialog'}: ${params.message ?? ''}`.trim(),
        timestamp: Date.now(),
        source: 'dialog',
      })
      if (record.console.length > 200) record.console.splice(0, record.console.length - 200)
    }
    const client = this.client
    if (client === null || typeof sessionId !== 'string') return
    const policy = this.dialogPolicy ?? { policy: 'accept' }
    const accept = policy.policy !== 'dismiss'
    const dialogArgs = { accept }
    if (accept && params.type === 'prompt' && typeof policy.promptText === 'string') {
      dialogArgs.promptText = policy.promptText
    }
    client.send('Page.handleJavaScriptDialog', dialogArgs, { sessionId, timeoutMs: 5000 }).catch((error) => {
      this._log('warn', `could not handle the javascript dialog: ${errorTextOf(error)}`)
    })
  }

  /**
   * @param {Record<string, any>} params
   */
  _recordDownloadBegin(params) {
    const guid = params.guid
    if (typeof guid !== 'string') return
    const filename = typeof params.suggestedFilename === 'string' ? params.suggestedFilename : 'download'
    this.downloads.set(guid, {
      filename,
      url: typeof params.url === 'string' ? params.url : '',
      state: 'inProgress',
      path: this.downloadDir === null ? null : join(this.downloadDir, filename),
      receivedBytes: 0,
      totalBytes: 0,
      startedAt: Date.now(),
    })
    if (this.downloads.size > 100) {
      const oldest = this.downloads.keys().next()
      if (oldest.done !== true) this.downloads.delete(oldest.value)
    }
  }

  /**
   * @param {Record<string, any>} params
   */
  _recordDownloadProgress(params) {
    const guid = params.guid
    if (typeof guid !== 'string') return
    const entry = this.downloads.get(guid)
    if (entry === undefined) return
    if (typeof params.state === 'string') entry.state = params.state
    if (typeof params.receivedBytes === 'number') entry.receivedBytes = params.receivedBytes
    if (typeof params.totalBytes === 'number') entry.totalBytes = params.totalBytes
  }

  /**
   * @param {any} exec
   * @returns {Promise<string>}
   */
  async _ensureDownloads(exec) {
    if (!this._isConnected()) throw this._notConnected()
    if (this.downloadDir !== null) return this.downloadDir
    const dir = await this._artifactDir(exec, 'downloads')
    this.downloadDir = dir
    try {
      await this.client.send('Browser.setDownloadBehavior', {
        behavior: 'allow',
        downloadPath: dir,
        eventsEnabled: true,
      }, { timeoutMs: 5000 })
    } catch (error) {
      const record = this.currentPageId === null ? undefined : this.pages.get(this.currentPageId)
      if (record !== undefined) {
        await this.client.send('Page.setDownloadBehavior', {
          behavior: 'allow',
          downloadPath: dir,
        }, { sessionId: record.sessionId, timeoutMs: 5000 }).catch(() => {
          this.downloadDir = null
          throw new AutomationError(`Could not enable browser download capture: ${errorTextOf(error)}`, {
            code: 'DOWNLOAD_SETUP_FAILED',
            hint: 'The browser build may not support Browser.setDownloadBehavior; downloads can still be inspected via action "network".',
          })
        })
      } else {
        this.downloadDir = null
        throw error
      }
    }
    return dir
  }

  /**
   * @param {Record<string, any>} args
   * @param {any} exec
   * @returns {Promise<Record<string, any>>}
   */
  async _downloadList(args, exec) {
    if (!this._isConnected()) throw this._notConnected()
    const directory = await this._ensureDownloads(exec)
    const limit = clampInteger(args.limit, 1, 200, 50)
    const downloads = [...this.downloads.values()].slice(-limit).map((entry) => ({
      filename: entry.filename,
      url: entry.url,
      state: entry.state,
      path: entry.path,
      receivedBytes: entry.receivedBytes,
      totalBytes: entry.totalBytes,
    }))
    return { downloads, downloadDir: directory }
  }

  /**
   * @param {Record<string, any>} args
   * @returns {Promise<Record<string, any>>}
   */
  async _console(args) {
    const record = await this._currentRecord()
    const limit = clampInteger(args.limit, 1, 200, 200)
    const messages = record.console.slice(-limit).map((entry) => ({
      level: entry.level,
      text: entry.text,
      timestamp: entry.timestamp,
    }))
    return { page: { id: record.id, url: record.url, title: record.title }, messages, count: record.console.length }
  }

  /**
   * @param {Record<string, any>} args
   * @returns {Promise<Record<string, any>>}
   */
  async _network(args) {
    const record = await this._currentRecord()
    const limit = clampInteger(args.limit, 1, 300, 100)
    const requests = [...record.network.values()].slice(-limit).map((entry) => ({
      url: entry.url,
      method: entry.method,
      status: entry.status,
      failed: entry.failed,
      ...(entry.error === null ? {} : { error: entry.error }),
      type: entry.type,
    }))
    return {
      page: { id: record.id, url: record.url, title: record.title },
      requests,
      count: record.network.size,
      pending: record.pendingRequests.size,
    }
  }

  /**
   * @param {Record<string, any>} args
   * @returns {Record<string, any>}
   */
  _dialog(args) {
    const policy = args.policy
    if (policy !== 'accept' && policy !== 'dismiss') {
      throw new AutomationError('dialog policy must be "accept" or "dismiss"', {
        code: 'INVALID_DIALOG_POLICY',
        hint: 'Pass {"action":"dialog","policy":"accept"} or "dismiss".',
      })
    }
    const promptText = typeof args.promptText === 'string' ? args.promptText : undefined
    this.dialogPolicy = { policy, ...(promptText === undefined ? {} : { promptText }) }
    return {
      policy,
      ...(promptText === undefined ? {} : { promptText }),
      note: 'Applies to subsequent JavaScript dialogs (alert, confirm, prompt) on all pages.',
    }
  }

  /**
   * @param {Record<string, any>} args
   * @returns {Promise<Record<string, any>>}
   */
  async _viewport(args) {
    const width = clampInteger(args.width, 100, 10000, DEFAULT_VIEWPORT.width)
    const height = clampInteger(args.height, 100, 10000, DEFAULT_VIEWPORT.height)
    const deviceScaleFactor = clampNumber(args.deviceScaleFactor, 0.1, 10, 1)
    const mobile = args.mobile === true
    await this._applyViewport({ width, height, deviceScaleFactor, mobile })
    return { width, height, deviceScaleFactor, mobile }
  }

  /**
   * @param {{ width: number, height: number, deviceScaleFactor: number, mobile: boolean }} viewport
   * @returns {Promise<void>}
   */
  async _applyViewport(viewport) {
    const record = await this._currentRecord()
    await this.client.send('Emulation.setDeviceMetricsOverride', {
      width: viewport.width,
      height: viewport.height,
      deviceScaleFactor: viewport.deviceScaleFactor,
      mobile: viewport.mobile,
      screenWidth: viewport.width,
      screenHeight: viewport.height,
    }, { sessionId: record.sessionId, timeoutMs: 5000 })
    this.viewportState = viewport
  }

  // -- misc ----------------------------------------------------------------

  /**
   * @param {any} record
   * @param {number} timeoutMs
   * @returns {Promise<boolean>}
   */
  async _waitNetworkIdle(record, timeoutMs = 10000) {
    const startedAt = Date.now()
    let idleSince = 0
    while (true) {
      const pending = record.pendingRequests.size
      if (pending === 0) {
        if (idleSince === 0) idleSince = Date.now()
        if (Date.now() - idleSince >= 500) return true
      } else {
        idleSince = 0
      }
      if (Date.now() - startedAt >= timeoutMs) return false
      await sleep(100)
    }
  }
}

export default BrowserManager
