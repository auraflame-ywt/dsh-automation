// Standalone browser-layer self-test: launches real headless Chrome, drives every
// BrowserManager action over CDP, and asserts the observable results. Zero npm deps.
//
// Run from the plugin directory:  node test/browser-selftest.mjs
// Artifacts go to /tmp/dsh-auto-test/browser-selftest (never the workspace).
import { createServer } from 'node:http'
import { mkdir, readFile, readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { BrowserManager } from '../lib/browser.mjs'
import { AutomationError, run, sleep, which } from '../lib/util.mjs'

const BASE = '/tmp/dsh-auto-test/browser-selftest'
const ENV_BASE = '/tmp/dsh-auto-test/browser-selftest-env'
const EDGE_BASE = '/tmp/dsh-auto-test/browser-selftest-edge'
const VIEWPORT = { width: 1000, height: 700 }

let currentStep = 'startup'
let checks = 0
let failures = 0
/** @type {BrowserManager[]} */
const managers = []

function step(name) {
  currentStep = name
  console.log(`\n== ${name}`)
}

/**
 * @param {unknown} condition
 * @param {string} message
 */
function check(condition, message) {
  if (condition) {
    checks += 1
    console.log(`  ok  ${message}`)
    return
  }
  failures += 1
  throw new Error(`ASSERTION FAILED [${currentStep}]: ${message}`)
}

/**
 * @param {unknown} actual
 * @param {unknown} expected
 * @param {string} message
 */
function checkEqual(actual, expected, message) {
  check(
    actual === expected,
    `${message} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`,
  )
}

/**
 * Assert that `action()` rejects with the given AutomationError code.
 * @param {() => Promise<unknown>} action
 * @param {string} code
 * @param {string} message
 */
async function expectError(action, code, message) {
  try {
    await action()
  } catch (error) {
    if (error instanceof AutomationError && error.code === code) {
      check(true, `${message} (code ${code})`)
      return
    }
    check(false, `${message}: expected AutomationError code ${code}, got ${error?.code ?? error?.message ?? error}`)
    return
  }
  check(false, `${message}: expected a failure, but the action succeeded`)
}

/**
 * Poll until `probe()` returns something truthy, or the timeout expires.
 * @param {() => Promise<any>} probe
 * @param {number} timeoutMs
 * @param {number} [intervalMs]
 * @returns {Promise<any>}
 */
async function poll(probe, timeoutMs, intervalMs = 150) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const value = await probe()
      if (value !== null && value !== undefined && value !== false) return value
    } catch {
      // keep polling
    }
    await sleep(intervalMs)
  }
  return null
}

/**
 * @param {string} base
 */
function artifactsFor(base) {
  const writer = {
    async dir(exec, subdir) {
      const directory = join(base, subdir)
      await mkdir(directory, { recursive: true })
      return directory
    },
    async path(exec, subdir, extension) {
      const directory = await writer.dir(exec, subdir)
      const suffix = Math.random().toString(36).slice(2, 8)
      return join(directory, `selftest-${Date.now()}-${suffix}.${extension.replace(/^\./u, '')}`)
    },
  }
  return writer
}

const FIXTURE_HTML = String.raw`<!doctype html>
<html>
<head><meta charset="utf-8"><title>Browser Fixture</title></head>
<body>
<h1 id="title">Browser Fixture</h1>
<p id="intro">Self-test fixture page.</p>
<div id="out"></div>
<div id="ready" style="display:none"></div>
<label for="name">Name</label>
<input id="name" placeholder="type a name">
<textarea id="notes"></textarea>
<select id="color">
  <option value="red">Red</option>
  <option value="green">Green</option>
  <option value="blue">Blue</option>
</select>
<label><input id="agree" type="checkbox"> Agree</label>
<button id="btn">Click me</button>
<button id="hover">Hover me</button>
<button id="dbl">Double click me</button>
<button id="dialog">Alert</button>
<button id="confirm">Confirm</button>
<button id="prompt">Prompt</button>
<a id="download" href="/download.txt" download="download.txt">Download</a>
<a id="to-second" href="/second">Second page</a>
<div style="height:1800px"></div>
<script>
window.clicks = 0;
window.dblCount = 0;
window.hoverCount = 0;
window.selectChanges = 0;
window.lastKey = null;
window.confirmResult = null;
window.promptResult = null;
console.log('fixture:loaded');
document.getElementById('btn').addEventListener('click', function () {
  window.clicks += 1;
  document.getElementById('out').textContent = 'clicked';
  console.log('fixture:clicked');
});
document.getElementById('btn').addEventListener('dblclick', function () { window.dblCount += 1; });
document.getElementById('hover').addEventListener('mouseover', function () { window.hoverCount += 1; });
document.getElementById('color').addEventListener('change', function () { window.selectChanges += 1; });
document.addEventListener('keydown', function (event) { window.lastKey = event.key; });
document.getElementById('dialog').addEventListener('click', function () { alert('fixture-alert'); });
document.getElementById('confirm').addEventListener('click', function () { window.confirmResult = confirm('fixture-confirm'); });
document.getElementById('prompt').addEventListener('click', function () { window.promptResult = prompt('fixture-prompt', 'default'); });
window.startAnimation = function (durationMs) {
  var box = document.createElement('div');
  box.style.cssText = 'position:fixed;left:0;top:0;width:60px;height:60px;background:#e11;z-index:99';
  document.body.appendChild(box);
  var started = performance.now();
  var offset = 0;
  function tick() {
    offset = (offset + 7) % 700;
    box.style.transform = 'translateX(' + offset + 'px)';
    if (performance.now() - started < durationMs) requestAnimationFrame(tick);
    else box.remove();
  }
  requestAnimationFrame(tick);
};
setTimeout(function () {
  var ready = document.getElementById('ready');
  ready.style.display = 'block';
  ready.textContent = 'late text ready';
}, 300);
setTimeout(function () {
  fetch('/api/ping').then(function (response) { return response.json(); }).then(function () { console.log('fixture:ping-done'); });
}, 60);
</script>
<script src="/asset.js"></script>
</body>
</html>`

const SECOND_HTML = String.raw`<!doctype html>
<html><head><meta charset="utf-8"><title>Second Page</title></head>
<body><h1 id="second">Second Page</h1><p>another document</p></body></html>`

/**
 * @param {import('node:http').ServerResponse} response
 * @param {number} status
 * @param {Record<string, string>} headers
 * @param {string} body
 */
function send(response, status, headers, body) {
  response.writeHead(status, headers)
  response.end(body)
}

function startFixtureServer() {
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    if (url.pathname === '/') {
      send(response, 200, { 'content-type': 'text/html; charset=utf-8' }, FIXTURE_HTML)
      return
    }
    if (url.pathname === '/second') {
      send(response, 200, { 'content-type': 'text/html; charset=utf-8' }, SECOND_HTML)
      return
    }
    if (url.pathname === '/asset.js') {
      send(response, 200, { 'content-type': 'text/javascript; charset=utf-8' }, 'window.assetLoaded = true;')
      return
    }
    if (url.pathname === '/api/ping') {
      send(response, 200, { 'content-type': 'application/json' }, '{"pong":true}')
      return
    }
    if (url.pathname === '/download.txt') {
      send(
        response,
        200,
        {
          'content-type': 'text/plain; charset=utf-8',
          'content-disposition': 'attachment; filename="download.txt"',
        },
        'download-payload-123',
      )
      return
    }
    if (url.pathname === '/favicon.ico') {
      send(response, 204, {}, '')
      return
    }
    send(response, 404, { 'content-type': 'text/plain' }, 'not found')
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      resolve({
        server,
        port: address !== null && typeof address === 'object' ? address.port : 0,
      })
    })
  })
}

/** @param {Buffer} buffer */
function isPng(buffer) {
  return (
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer.subarray(1, 4).toString('ascii') === 'PNG'
  )
}

/** @param {Buffer} buffer */
function isJpeg(buffer) {
  return buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xd8
}

/** @param {Buffer} buffer */
function isPdf(buffer) {
  return buffer.length >= 5 && buffer.subarray(0, 5).toString('ascii') === '%PDF-'
}

/** @param {Buffer} buffer */
function pngDimensions(buffer) {
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
}

/**
 * Find process ids whose full command line matches a pattern. `/bin/ps` is blocked
 * by the bash tool's seatbelt sandbox on this machine, but `pgrep -f` works.
 * @param {string} pattern
 * @returns {Promise<number[]>}
 */
async function pidsMatching(pattern) {
  const result = await run('/usr/bin/pgrep', ['-f', pattern], { timeoutMs: 10000 })
  if (result.code === 1 && result.stdout.trim() === '') return []
  if (result.code !== 0) {
    throw new Error(`pgrep failed for ${pattern}: code ${result.code} ${result.stderr}`)
  }
  return result.stdout
    .split('\n')
    .map((line) => Number.parseInt(line.trim(), 10))
    .filter((pid) => Number.isFinite(pid) && pid > 0)
}

/**
 * @param {string[]} patterns
 * @returns {Promise<Array<{ pattern: string, pids: number[] }>>}
 */
async function liveBrowserProcesses(patterns) {
  const matches = []
  for (const pattern of patterns) {
    const pids = await pidsMatching(pattern)
    if (pids.length > 0) matches.push({ pattern, pids })
  }
  return matches
}

/**
 * @param {number} pid
 * @returns {Promise<boolean>} true when the process is gone
 */
async function waitForPidExit(pid, timeoutMs = 8000) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    try {
      process.kill(pid, 0)
    } catch {
      return true
    }
    await sleep(100)
  }
  return false
}

/**
 * @param {string[]} patterns
 * @returns {Promise<Array<{ pattern: string, pids: number[] }>>}
 */
async function waitForNoChrome(patterns) {
  const startedAt = Date.now()
  let matches = await liveBrowserProcesses(patterns)
  while (matches.length > 0 && Date.now() - startedAt < 8000) {
    await sleep(150)
    matches = await liveBrowserProcesses(patterns)
  }
  return matches
}

/**
 * @param {string} base
 * @returns {Promise<string[]>}
 */
async function listArtifactFiles(base) {
  const entries = []
  const queue = [base]
  while (queue.length > 0) {
    const directory = queue.shift()
    let listing
    try {
      listing = await readdir(directory, { withFileTypes: true })
    } catch {
      continue
    }
    for (const item of listing) {
      const absolute = join(directory, item.name)
      if (item.isDirectory()) queue.push(absolute)
      else entries.push(absolute)
    }
  }
  return entries.sort()
}

async function main() {
  console.log('dsh-automation browser self-test')
  console.log(`node ${process.version} on ${process.platform}/${process.arch}`)

  await rm(BASE, { recursive: true, force: true })
  await rm(ENV_BASE, { recursive: true, force: true })
  await rm(EDGE_BASE, { recursive: true, force: true })
  await mkdir(BASE, { recursive: true })
  const artifacts = artifactsFor(BASE)
  const { server, port: fixturePort } = await startFixtureServer()
  const fixtureUrl = `http://127.0.0.1:${fixturePort}/`
  const secondUrl = `http://127.0.0.1:${fixturePort}/second`
  console.log(`fixture server: ${fixtureUrl}`)

  const manager = new BrowserManager({
    artifacts,
    config: {
      browserKind: 'chrome',
      browserHeadless: true,
      commandTimeoutMs: 20000,
    },
    log: (level, message) => {
      if (level === 'warn' || level === 'error') console.log(`  log ${level}: ${message}`)
    },
  })
  managers.push(manager)
  /** @type {BrowserManager | null} */
  let externalManager = null
  /** @type {BrowserManager | null} */
  let envManager = null
  /** @type {BrowserManager | null} */
  let edgeManager = null
  /** @type {Record<string, any> | null} */
  let launched = null

  try {
    step('no browser yet: actions fail with a clear error')
    await expectError(() => manager.run({ action: 'snapshot' }), 'BROWSER_NOT_CONNECTED', 'snapshot without launch')
    await expectError(() => manager.run({ action: 'goto', url: fixtureUrl }), 'BROWSER_NOT_CONNECTED', 'goto without launch')
    await expectError(() => manager.run({ action: 'definitely_not_an_action' }), 'UNKNOWN_ACTION', 'unknown action rejected')
    const idleStatus = await manager.run({ action: 'status' })
    checkEqual(idleStatus.running, false, 'status.running is false before launch')
    check(Array.isArray(idleStatus.pages) && idleStatus.pages.length === 0, 'status.pages is empty before launch')

    step('launch headless Chrome')
    launched = await manager.run({
      action: 'launch',
      headless: true,
      noSandbox: true, // required: the bash tool's seatbelt sandbox blocks Chrome's own sandbox
      viewport: VIEWPORT,
    })
    check(typeof launched.browser === 'string' && launched.browser.includes('Chrome'), `browser reports Chrome (${launched.browser})`)
    check(typeof launched.port === 'number' && launched.port > 0, `free DevTools port allocated (${launched.port})`)
    check(typeof launched.wsUrl === 'string' && launched.wsUrl.startsWith('ws://'), 'wsUrl is a browser-level WebSocket URL')
    check(typeof launched.pid === 'number' && launched.pid > 0, `launched pid reported (${launched.pid})`)
    check(launched.userDataDir.startsWith(BASE), 'user data dir lives under the test artifact dir')
    check(launched.headless === true, 'headless flag reported')
    check(launched.page !== null && typeof launched.page.id === 'string', 'launch returns the initial page')
    const pageId = launched.page.id
    const launchedPid = launched.pid
    const profileDir = launched.userDataDir

    const reused = await manager.run({ action: 'launch', noSandbox: true })
    checkEqual(reused.port, launched.port, 'second launch reuses the running browser')

    step('goto + wait_for')
    const navigated = await manager.run({ action: 'goto', url: fixtureUrl })
    checkEqual(navigated.status, 200, 'goto reports the main document HTTP status')
    check(navigated.page.url.startsWith(fixtureUrl), `goto updated the page url (${navigated.page.url})`)
    const readyWait = await manager.run({ action: 'wait_for', selector: '#ready', state: 'visible', timeoutMs: 4000 })
    check(readyWait.matched === true, 'wait_for selector visible matched')
    check(readyWait.elapsedMs >= 100, `wait_for waited for the delayed element (${readyWait.elapsedMs}ms)`)
    const textWait = await manager.run({ action: 'wait_for', text: 'late text ready', timeoutMs: 4000 })
    check(textWait.matched === true, 'wait_for text matched')
    const idleWait = await manager.run({ action: 'wait_for', networkIdle: true, timeoutMs: 6000 })
    check(idleWait.matched === true, 'wait_for networkIdle matched')
    await expectError(
      () => manager.run({ action: 'wait_for', selector: '#does-not-exist', timeoutMs: 500 }),
      'WAIT_TIMEOUT',
      'wait_for times out with WAIT_TIMEOUT',
    )
    await expectError(
      () => manager.run({ action: 'wait_for', text: 'never appears', timeoutMs: 500 }),
      'WAIT_TIMEOUT',
      'wait_for text times out with WAIT_TIMEOUT',
    )

    step('snapshot')
    const snapshot = await manager.run({ action: 'snapshot' })
    check(Array.isArray(snapshot.elements) && snapshot.elements.length >= 8, `snapshot lists interactive elements (${snapshot.elements.length})`)
    check(snapshot.text.includes('Browser Fixture'), 'snapshot includes bounded body text')
    check(snapshot.page.url.startsWith(fixtureUrl), 'snapshot carries page info')
    const buttonElement = snapshot.elements.find((element) => element.tag === 'button' && element.name === 'Click me')
    check(buttonElement !== undefined, 'snapshot finds the Click me button by accessible name')
    checkEqual(buttonElement.selector, '#btn', 'snapshot produces a stable CSS selector')
    check(typeof buttonElement.ref === 'string' && buttonElement.ref.length > 0, 'snapshot assigns a ref')
    const headingElement = snapshot.elements.find((element) => element.role === 'heading')
    check(headingElement !== undefined, 'snapshot includes headings')
    const nameInput = snapshot.elements.find((element) => element.tag === 'input' && element.selector === '#name')
    check(nameInput !== undefined, 'snapshot includes the text input')
    const checkbox = snapshot.elements.find((element) => element.tag === 'input' && element.selector === '#agree')
    check(checkbox !== undefined && checkbox.checked === false, 'snapshot reports checkbox state')
    const colorSelect = snapshot.elements.find((element) => element.selector === '#color')
    check(colorSelect !== undefined && colorSelect.role === 'combobox', 'snapshot reports select role/value')
    const smallText = await manager.run({ action: 'snapshot', maxText: 40 })
    check(smallText.text.length <= 40 && smallText.truncated === true, 'snapshot maxText bounds and flags truncation')

    step('console + network capture')
    const consoleInitial = await manager.run({ action: 'console' })
    check(consoleInitial.messages.some((message) => message.text.includes('fixture:loaded')), 'console captured page console.log')
    const networkInitial = await manager.run({ action: 'network', limit: 50 })
    check(
      networkInitial.requests.some((request) => request.url.endsWith('/asset.js') && request.status === 200),
      'network captured an easy-to-miss subresource with status 200',
    )
    check(
      networkInitial.requests.some((request) => request.url.includes('/api/ping') && request.status === 200),
      'network captured a fetch() request',
    )
    check(
      networkInitial.requests.some((request) => request.type === 'Document' && request.status === 200),
      'network captured the main document',
    )

    step('click variants dispatch real mouse events')
    const clicked = await manager.run({ action: 'click', selector: '#btn' })
    check(clicked.clicked === true, 'click reports clicked')
    check(clicked.box.width > 0 && clicked.box.height > 0, 'click reports the element box')
    await sleep(80)
    checkEqual((await manager.run({ action: 'eval', expression: 'window.clicks' })).result, 1, 'real mouse click reached the page listener')
    checkEqual((await manager.run({ action: 'eval', expression: 'document.getElementById("out").textContent' })).result, 'clicked', 'click effect visible in the DOM')
    const clickedText = await manager.run({ action: 'click', selector: 'text=Click me' })
    check(clickedText.clicked === true, 'text= selector click works')
    const clickedXpath = await manager.run({ action: 'click', selector: 'xpath=//button[@id="btn"]' })
    check(clickedXpath.clicked === true, 'xpath= selector click works')
    const freshSnapshot = await manager.run({ action: 'snapshot' })
    const freshButton = freshSnapshot.elements.find((element) => element.selector === '#btn')
    check(freshButton !== undefined, 'snapshot ref available for ref click')
    const clickedRef = await manager.run({ action: 'click', selector: `ref=${freshButton.ref}` })
    check(clickedRef.clicked === true, 'snapshot ref click works')
    checkEqual((await manager.run({ action: 'eval', expression: 'window.clicks' })).result, 4, 'each click incremented the page counter')
    await expectError(
      () => manager.run({ action: 'click', selector: '#no-such-button', timeoutMs: 400 }),
      'SELECTOR_NOT_FOUND',
      'click on a missing selector fails with SELECTOR_NOT_FOUND',
    )
    const consoleAfterClick = await manager.run({ action: 'console' })
    check(consoleAfterClick.messages.some((message) => message.text.includes('fixture:clicked')), 'console buffer gained the click log')

    step('fill / type / press')
    const filled = await manager.run({ action: 'fill', selector: '#name', value: 'Ada Lovelace' })
    checkEqual(filled.verified, true, 'fill verified the input value')
    checkEqual(filled.value, 'Ada Lovelace', 'fill set the value')
    const cleared = await manager.run({ action: 'fill', selector: '#name', value: '' })
    checkEqual(cleared.value, '', 'fill with an empty value clears the input')
    await manager.run({ action: 'fill', selector: '#name', value: 'abc' })
    const appended = await manager.run({ action: 'fill', selector: '#name', value: 'def', clear: false })
    checkEqual(appended.value, 'abcdef', 'fill with clear:false appends at the end')
    await manager.run({ action: 'fill', selector: '#name', value: 'Ada Lovelace' })
    const typed = await manager.run({ action: 'type', selector: '#name', text: ' II' })
    check(typed.typed === true, 'type reports typed')
    checkEqual(
      (await manager.run({ action: 'eval', expression: 'document.querySelector("#name").value' })).result,
      'Ada Lovelace II',
      'type appended text at the caret',
    )
    await manager.run({ action: 'press', key: 'Enter', selector: '#name' })
    checkEqual(
      (await manager.run({ action: 'eval', expression: 'window.lastKey' })).result,
      'Enter',
      'press dispatched a real Enter keydown',
    )
    await manager.run({ action: 'press', key: 'a', modifiers: ['shift'], selector: '#name' })
    checkEqual(
      (await manager.run({ action: 'eval', expression: 'document.querySelector("#name").value' })).result,
      'Ada Lovelace IIA',
      'press with shift typed an uppercase character',
    )
    await manager.run({ action: 'press', key: 'a', modifiers: ['cmd'], selector: '#name' })
    await manager.run({ action: 'type', text: 'Z' })
    checkEqual(
      (await manager.run({ action: 'eval', expression: 'document.querySelector("#name").value' })).result,
      'Z',
      'cmd+a select-all + type replaced the field contents',
    )
    await expectError(
      () => manager.run({ action: 'press', key: 'NotAKey' }),
      'UNSUPPORTED_KEY',
      'unknown key is rejected',
    )
    await expectError(
      () => manager.run({ action: 'fill', selector: '#intro', value: 'x', timeoutMs: 500 }),
      'NOT_EDITABLE',
      'fill refuses a non-editable element',
    )
    await expectError(
      () => manager.run({ action: 'fill', selector: '#agree', value: 'x', timeoutMs: 500 }),
      'NOT_EDITABLE',
      'fill refuses a checkbox',
    )

    step('select_option / check / hover / dblclick')
    const selected = await manager.run({ action: 'select_option', selector: '#color', value: 'green' })
    checkEqual(selected.value, 'green', 'select_option set the value')
    checkEqual(selected.label, 'Green', 'select_option reports the label')
    checkEqual((await manager.run({ action: 'eval', expression: 'window.selectChanges' })).result, 1, 'select_option fired a change event')
    await expectError(
      () => manager.run({ action: 'select_option', selector: '#color', value: 'purple' }),
      'OPTION_NOT_FOUND',
      'select_option rejects an unknown option',
    )
    await expectError(
      () => manager.run({ action: 'select_option', selector: '#name', value: 'x' }),
      'NOT_SELECT',
      'select_option rejects a non-select element',
    )
    const checked = await manager.run({ action: 'check', selector: '#agree' })
    checkEqual(checked.checked, true, 'check reports the desired state')
    checkEqual((await manager.run({ action: 'eval', expression: 'document.querySelector("#agree").checked' })).result, true, 'check ticked the box')
    const unchecked = await manager.run({ action: 'uncheck', selector: '#agree' })
    checkEqual(unchecked.checked, false, 'uncheck reports the desired state')
    checkEqual((await manager.run({ action: 'eval', expression: 'document.querySelector("#agree").checked' })).result, false, 'uncheck cleared the box')
    await manager.run({ action: 'check', selector: '#agree' })
    await manager.run({ action: 'hover', selector: '#hover' })
    await sleep(120)
    check((await manager.run({ action: 'eval', expression: 'window.hoverCount' })).result >= 1, 'hover triggered a real mouseover')
    await manager.run({ action: 'dblclick', selector: '#btn' })
    await sleep(120)
    checkEqual((await manager.run({ action: 'eval', expression: 'window.dblCount' })).result, 1, 'dblclick triggered one dblclick event')

    step('scroll')
    const scrolled = await manager.run({ action: 'scroll', y: 600 })
    check(scrolled.scrollY >= 500, `scroll moved the window (${scrolled.scrollY})`)
    const scrolledBack = await manager.run({ action: 'scroll', y: 0, x: 0 })
    checkEqual(scrolledBack.scrollY, 0, 'scroll to absolute position works')
    const scrolledIntoView = await manager.run({ action: 'scroll', selector: '#notes' })
    check(scrolledIntoView.scrolled === true, 'scroll with selector works')

    step('dialog policy (default auto-accept, dismiss, prompt text)')
    await manager.run({ action: 'click', selector: '#confirm' })
    await sleep(200)
    checkEqual((await manager.run({ action: 'eval', expression: 'window.confirmResult' })).result, true, 'confirm auto-accepted by default')
    const dismissPolicy = await manager.run({ action: 'dialog', policy: 'dismiss' })
    checkEqual(dismissPolicy.policy, 'dismiss', 'dialog policy stored')
    await manager.run({ action: 'click', selector: '#confirm' })
    await sleep(200)
    checkEqual((await manager.run({ action: 'eval', expression: 'window.confirmResult' })).result, false, 'confirm dismissed after policy change')
    const promptPolicy = await manager.run({ action: 'dialog', policy: 'accept', promptText: 'typed-answer' })
    checkEqual(promptPolicy.promptText, 'typed-answer', 'prompt text stored')
    await manager.run({ action: 'click', selector: '#prompt' })
    await sleep(200)
    checkEqual((await manager.run({ action: 'eval', expression: 'window.promptResult' })).result, 'typed-answer', 'prompt answered with promptText')
    await manager.run({ action: 'click', selector: '#dialog' })
    await sleep(200)
    checkEqual((await manager.run({ action: 'eval', expression: '1 + 1' })).result, 2, 'page still responsive after an alert')
    await manager.run({ action: 'dialog', policy: 'accept' })

    step('eval')
    checkEqual((await manager.run({ action: 'eval', expression: '1 + 1' })).result, 2, 'eval returns a primitive')
    const objectEval = await manager.run({ action: 'eval', expression: '({ a: 1, b: ["x"] })' })
    checkEqual(JSON.stringify(objectEval.result), JSON.stringify({ a: 1, b: ['x'] }), 'eval returns JSON-serialisable objects')
    const promised = await manager.run({
      action: 'eval',
      expression: 'new Promise(function (resolve) { setTimeout(function () { resolve(42); }, 50); })',
      awaitPromise: true,
    })
    checkEqual(promised.result, 42, 'eval awaitPromise resolves promises')
    await expectError(
      () => manager.run({ action: 'eval', expression: 'throw new Error("fixture-boom")' }),
      'PAGE_EXCEPTION',
      'eval throws PAGE_EXCEPTION for page errors',
    )

    step('screenshot')
    const screenshot = await manager.run({ action: 'screenshot' })
    check(screenshot.path.startsWith(BASE), 'screenshot path is under the test artifact dir')
    const screenshotBuffer = await readFile(screenshot.path)
    check(isPng(screenshotBuffer), 'screenshot file has a PNG signature')
    const viewportDimensions = pngDimensions(screenshotBuffer)
    checkEqual(viewportDimensions.width, VIEWPORT.width, 'viewport screenshot width matches')
    checkEqual(viewportDimensions.height, VIEWPORT.height, 'viewport screenshot height matches')
    check(screenshotBuffer.length > 1000 && screenshot.bytes === screenshotBuffer.length, 'screenshot is non-trivial and byte size matches')
    await manager.run({ action: 'scroll', y: 0, x: 0 })
    const fullPage = await manager.run({ action: 'screenshot', fullPage: true })
    const fullPageBuffer = await readFile(fullPage.path)
    check(isPng(fullPageBuffer), 'full-page screenshot is a PNG')
    check(fullPage.height > VIEWPORT.height + 500, `full-page screenshot is taller than the viewport (${fullPage.height})`)
    const selectorShot = await manager.run({ action: 'screenshot', selector: '#btn' })
    const selectorBuffer = await readFile(selectorShot.path)
    check(isPng(selectorBuffer), 'selector screenshot is a PNG')
    check(selectorShot.width > 0 && selectorShot.width < VIEWPORT.width, `selector screenshot is cropped (${selectorShot.width}x${selectorShot.height})`)
    const jpegShot = await manager.run({ action: 'screenshot', format: 'jpeg', quality: 70, path: join(BASE, 'selftest-explicit.jpg') })
    checkEqual(jpegShot.path, join(BASE, 'selftest-explicit.jpg'), 'explicit screenshot path is honored')
    const jpegBuffer = await readFile(jpegShot.path)
    check(isJpeg(jpegBuffer), 'jpeg screenshot has a JPEG signature')

    step('viewport')
    const resized = await manager.run({ action: 'viewport', width: 800, height: 600, deviceScaleFactor: 1 })
    checkEqual(resized.width, 800, 'viewport reports width')
    const innerSize = await manager.run({ action: 'eval', expression: '({ w: window.innerWidth, h: window.innerHeight })' })
    checkEqual(innerSize.result.w, 800, 'page innerWidth matches the viewport override')
    checkEqual(innerSize.result.h, 600, 'page innerHeight matches the viewport override')
    const resizedShot = await manager.run({ action: 'screenshot' })
    const resizedBuffer = await readFile(resizedShot.path)
    checkEqual(pngDimensions(resizedBuffer).width, 800, 'screenshot honors the emulated viewport')

    step('pdf')
    const pdf = await manager.run({ action: 'pdf' })
    const pdfBuffer = await readFile(pdf.path)
    check(isPdf(pdfBuffer), 'pdf output starts with the PDF magic bytes')
    check(pdfBuffer.length > 1000 && pdf.bytes === pdfBuffer.length, 'pdf output is non-trivial')

    step('downloads')
    await manager.run({ action: 'click', selector: '#download' })
    const download = await poll(async () => {
      const listing = await manager.run({ action: 'download_list' })
      return listing.downloads.find((entry) => entry.filename === 'download.txt' && entry.state === 'completed') ?? null
    }, 8000)
    check(download !== null, 'download_list reports a completed download')
    check(download.path !== null && download.path.startsWith(BASE), 'download path is under the artifact dir')
    const downloadBytes = await readFile(download.path)
    check(downloadBytes.toString('utf8').includes('download-payload-123'), 'downloaded file contents are correct')
    const downloadListing = await manager.run({ action: 'download_list' })
    check(downloadListing.downloadDir.startsWith(BASE), 'download_list reports the download directory')

    step('new_page / select_page')
    const newPage = await manager.run({ action: 'new_page', url: secondUrl })
    check(typeof newPage.page.id === 'string' && newPage.page.id !== pageId, 'new_page created a distinct page')
    check(newPage.page.url.startsWith(secondUrl), 'new_page navigated to the requested url')
    const pagesListing = await manager.run({ action: 'pages' })
    check(pagesListing.pages.length >= 2, `pages lists both tabs (${pagesListing.pages.length})`)
    check(pagesListing.pages.some((entry) => entry.active === true), 'pages marks the active page')
    const selectedPage = await manager.run({ action: 'select_page', pageId })
    checkEqual(selectedPage.page.id, pageId, 'select_page switches back to the first page')
    check(selectedPage.page.url.startsWith(fixtureUrl), 'select_page reports the first page url')
    checkEqual(
      (await manager.run({ action: 'eval', expression: 'document.title' })).result,
      'Browser Fixture',
      'commands target the selected page',
    )
    await expectError(
      () => manager.run({ action: 'select_page', pageId: 'no-such-page' }),
      'PAGE_NOT_FOUND',
      'select_page rejects an unknown page id',
    )

    step('connect to a running browser and disconnect without killing it')
    externalManager = new BrowserManager({
      artifacts: artifactsFor(BASE),
      config: { browserKind: 'chrome', browserHeadless: true, commandTimeoutMs: 20000 },
    })
    managers.push(externalManager)
    const connected = await externalManager.run({ action: 'connect', port: launched.port, viewport: VIEWPORT })
    checkEqual(connected.port, launched.port, 'connect reuses the running DevTools port')
    check(connected.page !== null, 'connect attaches to an existing page')
    const connectedPages = await externalManager.run({ action: 'pages' })
    checkEqual(connectedPages.pages.length, 2, 'connected manager sees both pages')
    await externalManager.run({ action: 'select_page', pageId })
    checkEqual(
      (await externalManager.run({ action: 'eval', expression: 'document.title' })).result,
      'Browser Fixture',
      'connected manager can evaluate on the selected page',
    )
    const disconnected = await externalManager.run({ action: 'close' })
    checkEqual(disconnected.closed, true, 'close reports closed')
    checkEqual(disconnected.killed, false, 'closing an external connection does not kill the browser')
    const reconnected = await externalManager.run({ action: 'connect', wsUrl: launched.wsUrl, viewport: VIEWPORT })
    checkEqual(reconnected.wsUrl, launched.wsUrl, 'connect accepts a browser-level wsUrl')
    checkEqual(reconnected.port, launched.port, 'connect derives the port from the wsUrl')
    checkEqual(
      (await externalManager.run({ action: 'eval', expression: '1 + 1' })).result,
      2,
      'wsUrl-connected manager drives the page',
    )
    await externalManager.run({ action: 'close' })
    externalManager = null
    const stillRunning = await manager.run({ action: 'status' })
    checkEqual(stillRunning.running, true, 'launched browser survived the external disconnect')
    checkEqual((await manager.run({ action: 'eval', expression: '2 + 2' })).result, 4, 'launched browser still evaluates after the external disconnect')

    step('launch reuses a browser already listening on the configured port')
    const portManager = new BrowserManager({
      artifacts: artifactsFor(BASE),
      config: {
        browserKind: 'chrome',
        browserHeadless: true,
        browserPort: launched.port,
        commandTimeoutMs: 20000,
      },
    })
    managers.push(portManager)
    const portLaunched = await portManager.run({ action: 'launch', noSandbox: true })
    checkEqual(portLaunched.port, launched.port, 'launch reused the configured DevTools port')
    checkEqual(portLaunched.pid, null, 'reused browser is not a child process of this manager')
    checkEqual(
      (await portManager.run({ action: 'eval', expression: '2 + 2' })).result,
      4,
      'manager reusing the port drives the page',
    )
    const portClosed = await portManager.run({ action: 'close' })
    checkEqual(portClosed.killed, false, 'closing a reused browser does not kill it')
    checkEqual((await manager.run({ action: 'status' })).running, true, 'the launched browser survives the reuse disconnect')

    step('reload / back / forward / goto waitUntil')
    const reloaded = await manager.run({ action: 'reload' })
    checkEqual(reloaded.reloaded, true, 'reload reports reloaded')
    check(reloaded.page.url.startsWith(fixtureUrl), 'reload kept the page url')
    const navigatedSecond = await manager.run({ action: 'goto', url: secondUrl, waitUntil: 'domcontentloaded' })
    checkEqual(navigatedSecond.waitUntil, 'domcontentloaded', 'goto honors waitUntil domcontentloaded')
    check(navigatedSecond.page.url.startsWith(secondUrl), 'goto navigated to the second page')
    const wentBack = await manager.run({ action: 'back' })
    checkEqual(wentBack.changed, true, 'back reports a history change')
    check(wentBack.page.url.startsWith(fixtureUrl), 'back returned to the fixture page')
    const wentForward = await manager.run({ action: 'forward' })
    checkEqual(wentForward.changed, true, 'forward reports a history change')
    check(wentForward.page.url.startsWith(secondUrl), 'forward returned to the second page')
    const idleGoto = await manager.run({ action: 'goto', url: fixtureUrl, waitUntil: 'networkidle' })
    checkEqual(idleGoto.waitUntil, 'networkidle', 'goto honors waitUntil networkidle')
    await manager.run({ action: 'viewport', width: VIEWPORT.width, height: VIEWPORT.height })

    step('record_start / record_stop (screencast -> mp4)')
    await expectError(() => manager.run({ action: 'record_stop' }), 'NO_RECORDING', 'record_stop without a recording fails')
    const recording = await manager.run({ action: 'record_start', quality: 80, maxWidth: 800 })
    checkEqual(recording.recording, true, 'record_start reports recording')
    checkEqual(recording.frames, 0, 'record_start starts with zero frames')
    check(recording.framesDir.startsWith(BASE), 'recording frames dir is under the artifact dir')
    await manager.run({ action: 'eval', expression: 'window.startAnimation(1500)' })
    await sleep(400)
    const midRecording = await manager.run({ action: 'eval', expression: '1 + 1' })
    checkEqual(midRecording.result, 2, 'page stays responsive during screencast capture')
    await sleep(1300)
    const recordingResult = await manager.run({ action: 'record_stop' })
    check(recordingResult.frames > 10, `recording captured frames (${recordingResult.frames})`)
    check(recordingResult.durationMs >= 500, `recording duration is plausible (${recordingResult.durationMs}ms)`)
    check(recordingResult.path.startsWith(BASE), 'recording output is under the artifact dir')
    const frameFiles = (await readdir(recordingResult.framesDir)).filter((name) => name.endsWith('.jpg'))
    check(frameFiles.length > 10, `frames directory contains jpgs (${frameFiles.length})`)
    const ffmpeg = which('ffmpeg')
    if (ffmpeg === null) {
      checkEqual(recordingResult.encoder, 'frames', 'without ffmpeg the frames fallback is reported')
    } else {
      checkEqual(recordingResult.encoder, 'ffmpeg', 'ffmpeg encoded the recording')
      check(recordingResult.path.endsWith('.mp4'), 'recording output is an mp4')
      const mp4Info = await stat(recordingResult.path)
      check(mp4Info.size > 3000, `mp4 is non-trivial (${mp4Info.size} bytes)`)
      checkEqual(recordingResult.bytes, mp4Info.size, 'record_stop reports the mp4 byte size')
      const ffprobe = which('ffprobe')
      if (ffprobe !== null) {
        const probed = await run(ffprobe, [
          '-v', 'error',
          '-show_entries', 'format=duration,size',
          '-show_entries', 'stream=codec_name,width,height',
          '-of', 'json',
          recordingResult.path,
        ], { timeoutMs: 20000 })
        checkEqual(probed.code, 0, 'ffprobe can read the mp4')
        const metadata = JSON.parse(probed.stdout)
        check(Number(metadata.format.duration) >= 0.4, `mp4 duration is plausible (${metadata.format.duration}s)`)
        checkEqual(metadata.streams[0].codec_name, 'h264', 'mp4 stream is h264')
        check(metadata.streams[0].width % 2 === 0 && metadata.streams[0].height % 2 === 0, 'mp4 dimensions are even (yuv420p safe)')
      }
    }
    await expectError(() => manager.run({ action: 'record_stop' }), 'NO_RECORDING', 'record_stop is not repeatable')

    step('status')
    const finalStatus = await manager.run({ action: 'status' })
    checkEqual(finalStatus.running, true, 'status.running is true')
    checkEqual(finalStatus.pid, launchedPid, 'status reports the launched pid')
    check(finalStatus.pages.length >= 2, 'status lists both pages')
    checkEqual(finalStatus.recording, null, 'status reports no active recording')
    const listedPages = await manager.run({ action: 'pages' })
    checkEqual(listedPages.pages.length, finalStatus.pages.length, 'pages and status agree on the page count')

    step('dispose: browser process is gone and no orphan Chrome remains')
    await manager.run({ action: 'close' })
    const closedStatus = await manager.run({ action: 'status' })
    checkEqual(closedStatus.running, false, 'status.running is false after close')
    await manager.dispose()
    check(await waitForPidExit(launchedPid, 8000), 'launched Chrome pid exited')
    const leftovers = await waitForNoChrome([
      profileDir,
      `remote-debugging-port=${launched.port}`,
    ])
    checkEqual(
      leftovers.length,
      0,
      `no process references the test profile/port${leftovers.length > 0 ? `: ${JSON.stringify(leftovers)}` : ''}`,
    )
    const artifactsAfterRun = await listArtifactFiles(BASE)
    check(artifactsAfterRun.length > 0, `artifacts were written under ${BASE} (${artifactsAfterRun.length} files)`)

    step('DSH_AUTOMATION_CHROME_NO_SANDBOX=1 launch path')
    process.env.DSH_AUTOMATION_CHROME_NO_SANDBOX = '1'
    try {
      envManager = new BrowserManager({
        artifacts: artifactsFor(ENV_BASE),
        config: { browserKind: 'chrome', browserHeadless: true, commandTimeoutMs: 20000 },
      })
      managers.push(envManager)
      const envLaunched = await envManager.run({ action: 'launch', headless: true, viewport: { width: 640, height: 480 } })
      check(typeof envLaunched.pid === 'number' && envLaunched.pid > 0, 'env-var no-sandbox launch started Chrome')
      await envManager.run({ action: 'goto', url: fixtureUrl })
      checkEqual(
        (await envManager.run({ action: 'eval', expression: 'document.title' })).result,
        'Browser Fixture',
        'env-var launched browser drives a page',
      )
      const envPid = envLaunched.pid
      const envProfile = envLaunched.userDataDir
      await envManager.dispose()
      envManager = null
      check(await waitForPidExit(envPid, 8000), 'env-var launched Chrome pid exited')
      const envLeftovers = await waitForNoChrome([
        envProfile,
        `remote-debugging-port=${envLaunched.port}`,
      ])
      checkEqual(envLeftovers.length, 0, 'no orphan process from the env-var launch')
    } finally {
      delete process.env.DSH_AUTOMATION_CHROME_NO_SANDBOX
    }

    step('browserKind edge')
    edgeManager = new BrowserManager({
      artifacts: artifactsFor(EDGE_BASE),
      config: { browserKind: 'edge', browserHeadless: true, browserLaunchTimeoutMs: 20000, commandTimeoutMs: 20000 },
    })
    managers.push(edgeManager)
    const edgeLaunched = await edgeManager.run({
      action: 'launch',
      headless: true,
      noSandbox: true,
      viewport: { width: 800, height: 600 },
    })
    check(typeof edgeLaunched.browser === 'string' && edgeLaunched.browser.includes('Edg'), `edge browser reports its product (${edgeLaunched.browser})`)
    check(edgeLaunched.userDataDir.startsWith(EDGE_BASE), 'edge profile is under the edge test dir')
    await edgeManager.run({ action: 'goto', url: fixtureUrl })
    checkEqual(
      (await edgeManager.run({ action: 'eval', expression: 'document.title' })).result,
      'Browser Fixture',
      'edge drives a page over the same CDP client',
    )
    const edgePid = edgeLaunched.pid
    const edgeProfile = edgeLaunched.userDataDir
    const edgePort = edgeLaunched.port
    await edgeManager.dispose()
    edgeManager = null
    check(await waitForPidExit(edgePid, 8000), 'edge pid exited')
    checkEqual(
      (await waitForNoChrome([edgeProfile, `remote-debugging-port=${edgePort}`])).length,
      0,
      'no orphan Edge process',
    )

    console.log(`\nRESULT: ${checks} checks passed, 0 failed`)
    console.log(`artifacts: ${BASE}`)
    return true
  } catch (error) {
    console.error(`\nRESULT: FAILED during "${currentStep}" after ${checks} passed checks`)
    console.error(error instanceof Error ? error.stack ?? error.message : error)
    return false
  } finally {
    for (const instance of managers) {
      try {
        await instance.dispose()
      } catch {
        // ignore
      }
    }
    server.close()
    await sleep(200)
  }
}

const succeeded = await main()
process.exitCode = succeeded ? 0 : 1
