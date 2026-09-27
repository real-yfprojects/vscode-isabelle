// Records the README demo: a fresh VS Code with the packaged extension proves two lemmas
// about binary trees, and the result is encoded as docs/demo.gif.
//
//   node scripts/demo/record.js                 # package, record, encode
//   node scripts/demo/record.js --reuse-vsix    # skip compiling and packaging
//   node scripts/demo/record.js --encode-only   # re-encode the last recording
//   node scripts/demo/record.js --help          # every option
//
// Everything is driven over the DevTools protocol of the VS Code window, and frames come
// from that window's own renderer (Page.startScreencast). Nothing photographs the desktop,
// so other windows can never end up in the recording -- but keep your mouse off the
// VS Code window while it records: a real pointer over it still triggers hovers.
//
// Each run starts from nothing: a new profile, the .vsix installed into a new extensions
// directory, and a copy of Tree.thy and Demo.thy. Every step waits for what the viewer is
// meant to see (a subgoal count in the infoview, an item in the suggestion list, the tab
// of the file jumped to) instead of sleeping, and the take fails loudly if it does not
// appear, so a recording that finishes is one that shows the storyboard.
//
// Needs: a stock Isabelle2025-2 with its HOL image, and ffmpeg on PATH or in $FFMPEG for
// the encoding step. The Isabelle fonts (README step 3) are used when installed.

const { spawn, spawnSync } = require('child_process')
const fs = require('fs')
const net = require('net')
const os = require('os')
const path = require('path')

// Inherited from an extension-host terminal, these make the spawned Code.exe run as
// plain Node instead of opening the workbench.
for (const k of Object.keys(process.env)) {
  if (k.startsWith('VSCODE_') || k.startsWith('ELECTRON_')) delete process.env[k]
}

const { REPO, findStockHome, ensureJar } = require('../server-jar')

const HERE = __dirname
const WORK = path.join(REPO, '.demo-recording')
const FRAMES = path.join(WORK, 'frames')

const HELP = `usage: node scripts/demo/record.js [options]

  --out FILE          GIF to write (default docs/demo.gif)
  --mp4 FILE          also write an MP4
  --width N           width of the workbench in pixels (default 1024)
  --height N          height (default 640)
  --gif-width N       scale the GIF to this width (default: as recorded)
  --theme NAME        colour theme (default "Default Dark Modern")
  --pace F            multiply every pause and typing delay by F (default 1)
  --vscode VERSION    VS Code to download and record with, or "installed" (default 1.139.1)
  --real-time         keep typing at the speed it happened, not at 55 ms a key
  --reuse-vsix        use the .vsix of the previous run instead of packaging again
  --encode-only       only re-encode the frames of the previous run
  --keep-open         leave VS Code open after the take, for looking around
`

function parseArgs(argv) {
  const opts = {
    out: path.join(REPO, 'docs', 'demo.gif'), mp4: undefined,
    width: 1024, height: 640, gifWidth: undefined,
    theme: 'Default Dark Modern', pace: 1, vscode: '1.139.1',
    realTime: false, reuseVsix: false, encodeOnly: false, keepOpen: false,
  }
  const value = i => {
    if (i >= argv.length) throw new Error(`${argv[i - 1]} needs a value`)
    return argv[i]
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    switch (a) {
      case '--help': case '-h': console.log(HELP); process.exit(0)
      case '--out': opts.out = path.resolve(value(++i)); break
      case '--mp4': opts.mp4 = path.resolve(value(++i)); break
      case '--width': opts.width = Number(value(++i)); break
      case '--height': opts.height = Number(value(++i)); break
      case '--gif-width': opts.gifWidth = Number(value(++i)); break
      case '--theme': opts.theme = value(++i); break
      case '--pace': opts.pace = Number(value(++i)); break
      case '--vscode': opts.vscode = value(++i); break
      case '--real-time': opts.realTime = true; break
      case '--reuse-vsix': opts.reuseVsix = true; break
      case '--encode-only': opts.encodeOnly = true; break
      case '--keep-open': opts.keepOpen = true; break
      default: throw new Error(`unknown option ${a}\n\n${HELP}`)
    }
  }
  return opts
}

// ---------------------------------------------------------------------------------------
// Preparation: fonts, the editor, the package, a fresh profile.

/** Whether Windows knows a font family, per-user or machine-wide. Elsewhere: fc-list. */
function fontInstalled(family) {
  if (process.platform === 'win32') {
    const keys = [
      'HKCU\\Software\\Microsoft\\Windows NT\\CurrentVersion\\Fonts',
      'HKLM\\Software\\Microsoft\\Windows NT\\CurrentVersion\\Fonts',
    ]
    return keys.some(key => {
      const r = spawnSync('reg', ['query', key], { encoding: 'utf8' })
      return r.status === 0 && r.stdout.toLowerCase().includes(family.toLowerCase())
    })
  }
  const r = spawnSync('fc-list', [':', 'family'], { encoding: 'utf8' })
  return r.status === 0 && r.stdout.toLowerCase().includes(family.toLowerCase())
}

async function resolveVSCode(version) {
  if (version === 'installed') {
    const candidates = [
      'C:\\Program Files\\Microsoft VS Code\\Code.exe',
      path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Microsoft VS Code', 'Code.exe'),
      '/Applications/Visual Studio Code.app/Contents/MacOS/Electron',
      '/usr/share/code/code',
    ]
    const found = candidates.find(p => fs.existsSync(p))
    if (!found) throw new Error('No installed VS Code found; pass --vscode <version>.')
    return found
  }
  // Pinned by default, so two runs a month apart record the same workbench.
  const { downloadAndUnzipVSCode } = require('@vscode/test-electron')
  return downloadAndUnzipVSCode(version)
}

/** VS Code's command-line entry point next to its binary, as bin/code.cmd finds it. */
function cliJs(codeExe) {
  const dir = path.dirname(codeExe)
  const direct = path.join(dir, 'resources', 'app', 'out', 'cli.js')
  if (fs.existsSync(direct)) return direct
  // Windows builds keep resources/ in a folder named after the commit.
  for (const entry of fs.readdirSync(dir)) {
    const nested = path.join(dir, entry, 'resources', 'app', 'out', 'cli.js')
    if (fs.existsSync(nested)) return nested
  }
  // macOS: Contents/MacOS/Electron next to Contents/Resources/app.
  const mac = path.join(dir, '..', 'Resources', 'app', 'out', 'cli.js')
  if (fs.existsSync(mac)) return mac
  throw new Error(`No cli.js found next to ${codeExe}`)
}

function run(cmd, args, options = {}) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', ...options })
  if (r.status !== 0) {
    throw new Error(`${path.basename(cmd)} ${args.join(' ')} failed (${r.status ?? r.error})`)
  }
  return r
}

/** Compile, bring the server jar up to date, and package exactly what a release ships. */
function packageExtension(home, vsix) {
  console.log('compiling...')
  run(process.execPath, [path.join(REPO, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', REPO])
  console.log(`server jar: ${ensureJar(home)}`)
  console.log('packaging...')
  // stdin is closed, so a vsce question fails the run instead of waiting for an answer.
  run(process.execPath, [path.join(REPO, 'node_modules', '@vscode', 'vsce', 'vsce'),
    'package', '--out', vsix], { cwd: REPO, stdio: ['ignore', 'inherit', 'inherit'] })
}

function settings(home, opts) {
  return {
    'isabelle.home': home,
    'isabelle.extendedServer': true,
    'editor.fontFamily': "'Isabelle DejaVu Sans Mono', monospace",
    'editor.fontSize': 15,
    'workbench.colorTheme': opts.theme,
    // Brackets do close themselves: the prover names completions only in a command that
    // parses, and `by (metis contents_mi` without its `)` does not. Quotes do not, so a
    // lemma statement is typed exactly as it lands. Enter always breaks the line,
    // whatever the suggestion list shows; Tab accepts.
    'editor.autoClosingQuotes': 'never',
    'editor.acceptSuggestionOnEnter': 'off',
    // A blinking caret doubles the frames of every pause and blurs the GIF palette.
    'editor.cursorBlinking': 'solid',
    'editor.minimap.enabled': false,
    // The breadcrumbs keep their symbols but not the file's path, which for a HOL theory
    // is the recording machine's Isabelle installation, user name included.
    'breadcrumbs.filePath': 'off',
    'editor.stickyScroll.enabled': false,
    // Only keys bound to a command, and without its name, which for the hover is a
    // sentence: the typed text is on screen already. Placed over the empty lines under
    // `end`, clear of the infoview.
    'screencastMode.keyboardOptions': {
      showKeys: false, showKeybindings: true, showCommands: false,
      showCommandGroups: false, showSingleEditorCursorMoves: false,
    },
    'screencastMode.fontSize': 24,
    'screencastMode.keyboardOverlayTimeout': 1800,
    'screencastMode.verticalOffset': 38,
    // Nothing that is not the extension: no chat, no tips, no update or trust prompts.
    'chat.disableAIFeatures': true,
    'workbench.secondarySideBar.defaultVisibility': 'hidden',
    'workbench.startupEditor': 'none',
    'workbench.tips.enabled': false,
    'workbench.enableExperiments': false,
    'security.workspace.trust.enabled': false,
    'telemetry.telemetryLevel': 'off',
    'update.mode': 'none',
    'extensions.autoUpdate': false,
    'extensions.autoCheckUpdates': false,
    'extensions.ignoreRecommendations': true,
    'git.enabled': false,
    'files.autoSave': 'off',
  }
}

function freshRun(home, opts) {
  const root = path.join(WORK, 'run')
  fs.rmSync(root, { recursive: true, force: true })
  const dirs = {
    user: path.join(root, 'user'),
    extensions: path.join(root, 'extensions'),
    // The folder name is what the title bar and the Explorer show.
    workspace: path.join(root, 'trees'),
  }
  for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true })
  fs.mkdirSync(path.join(dirs.user, 'User'), { recursive: true })
  fs.writeFileSync(path.join(dirs.user, 'User', 'settings.json'),
    JSON.stringify(settings(home, opts), null, 2) + '\n')
  for (const f of ['Tree.thy', 'Demo.thy']) {
    fs.copyFileSync(path.join(HERE, f), path.join(dirs.workspace, f))
  }
  return dirs
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address()
      srv.close(() => resolve(port))
    })
  })
}

function killTree(child) {
  if (!child || child.exitCode !== null) return
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
  } else {
    try { process.kill(-child.pid, 'SIGKILL') } catch { child.kill('SIGKILL') }
  }
}

// ---------------------------------------------------------------------------------------
// Looking at the workbench. Everything here reads the DOM; nothing clicks.

const sleep = ms => new Promise(r => setTimeout(r, ms))

/** Poll `probe` until it returns something truthy; fail with `what` after `timeout`. */
async function until(what, probe, timeout = 20000) {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    const got = await Promise.resolve().then(probe).catch(() => undefined)
    if (got) return got
    await sleep(100)
  }
  throw new Error(`timed out after ${timeout / 1000}s waiting for ${what}`)
}

class Director {
  constructor(page, cdp, pace) {
    this.page = page
    this.cdp = cdp
    this.pace = pace
    this.keyDelay = 55
    this.t0 = Date.now()
    this.timeline = []
    /** Wall-clock spans of typing, retimed by the encoder; see retime(). */
    this.typing = []
  }

  mark(label) {
    const t = (Date.now() - this.t0) / 1000
    this.timeline.push({ t, label })
    console.log(`  ${t.toFixed(1).padStart(5)}s  ${label}`)
  }

  pause(ms) { return sleep(ms * this.pace) }

  async type(text) {
    const start = Date.now() / 1000
    await this.page.keyboard.type(text, { delay: this.keyDelay * this.pace })
    this.typing.push({ start, end: Date.now() / 1000, target: text.length * this.keyDelay * this.pace / 1000 })
  }

  /** A key held down: `n` quick repeats, as the caret glides back over a line. */
  async hold(key, n) {
    for (let i = 0; i < n; i++) {
      await this.page.keyboard.press(key)
      await sleep(30 * this.pace)
    }
  }

  async press(...keys) {
    for (const k of keys) {
      await this.page.keyboard.press(k)
      await sleep(90 * this.pace)
    }
  }

  until(what, probe, timeout) { return until(what, probe, timeout) }

  /** Whether an element matching `selector`, containing `text`, is on screen. */
  visible(selector, text = '') {
    return this.page.evaluate(([sel, text]) => [...document.querySelectorAll(sel)].some(el =>
      getComputedStyle(el).display !== 'none' && getComputedStyle(el).visibility !== 'hidden' &&
      el.getBoundingClientRect().height > 0 && el.textContent.includes(text)), [selector, text])
  }

  /** Text of every webview; the infoview is the only one open during the take. */
  async webviewText() {
    const texts = await Promise.all(this.page.frames()
      .filter(f => f !== this.page.mainFrame())
      .map(f => f.evaluate(() => document.body ? document.body.innerText : '').catch(() => '')))
    return texts.join('\n')
  }

  infoview(what, needle, timeout) {
    return this.until(`the infoview to show "${needle}"`,
      async () => (await this.webviewText()).includes(needle), timeout)
  }

  /** Label of the active tab in the active editor group. */
  activeTab() {
    return this.page.evaluate(() => {
      const tab = document.querySelector('.editor-group-container.active .tab.active')
      return tab ? tab.textContent.trim() : ''
    })
  }

  tab(name, timeout) {
    return this.until(`${name} to be the active tab`,
      async () => (await this.activeTab()).startsWith(name), timeout)
  }

  editorText() {
    return this.page.evaluate(() => {
      const lines = document.querySelector('.editor-group-container.active .view-lines')
      return lines ? lines.innerText.replace(/\u00a0/g, ' ') : ''
    })
  }

  errors() {
    return this.page.evaluate(() =>
      document.querySelectorAll('.editor-group-container.active .squiggly-error').length)
  }

  /**
   * The Isabelle status bar item: `idle` once the server runs and nothing is being
   * checked (library icon, no n/m count), `busy` while it starts or checks.
   */
  status() {
    return this.page.evaluate(() => {
      const item = [...document.querySelectorAll('.statusbar-item')]
        .find(e => /\bHOL\b/.test(e.textContent || ''))
      if (!item) return 'absent'
      const text = (item.textContent || '').trim()
      if (item.querySelector('[class*="spin"]')) return 'busy: ' + text
      if (item.querySelector('.codicon-library') && !/\d+\/\d+/.test(text)) return 'idle'
      return 'other: ' + text
    })
  }

  /** Rows of the visible list in `widget`, with which one is focused. */
  rows(widget) {
    return this.page.evaluate(sel => {
      const w = [...document.querySelectorAll(sel)].find(el =>
        getComputedStyle(el).display !== 'none' && el.getBoundingClientRect().height > 0)
      if (!w) return []
      return [...w.querySelectorAll('.monaco-list-row')].map(r => ({
        label: r.getAttribute('aria-label') || r.textContent || '',
        focused: r.classList.contains('focused'),
      }))
    }, widget)
  }

  /**
   * Wait until the list in `widget` offers an item matching `re`, then move the
   * selection onto it with the arrow keys, as a person would.
   */
  async choose(widget, re, what, timeout, retrigger) {
    let asked = Date.now()
    try {
      await this.until(`${what} to be offered`, async () => {
        if ((await this.rows(widget)).some(r => re.test(r.label))) return true
        // The server waits only briefly for the prover's names, and VS Code asks again
        // only on the next keystroke; a person who stopped typing presses Ctrl+Space.
        if (retrigger && Date.now() - asked > 2500) {
          await this.page.keyboard.press(retrigger)
          asked = Date.now()
        }
        return false
      }, timeout)
    } catch (err) {
      const input = await this.page.evaluate(() =>
        [...document.querySelectorAll('.quick-input-box input')].map(i => i.value).join(' | '))
      const offered = (await this.rows(widget)).map(r => r.label).join(' | ')
      throw new Error(`${err.message}
  input: ${input}
  offered: ${offered || '(nothing)'}`)
    }
    for (let i = 0; i < 20; i++) {
      const rows = await this.rows(widget)
      if (rows.find(r => r.focused && re.test(r.label))) return
      await this.page.keyboard.press('ArrowDown')
      await sleep(120 * this.pace)
    }
    throw new Error(`could not select ${what}; offered: ${(await this.rows(widget))
      .map(r => r.label).join(' | ')}`)
  }

  /** Wait until keyboard focus is inside `selector`, so what is typed next lands there. */
  focusIn(selector, what) {
    return this.until(`${what} to take the keyboard focus`, () => this.page.evaluate(sel =>
      !!document.activeElement?.closest(sel), selector), 5000)
  }

  /**
   * Give the text editor the keyboard focus. Done through the DOM, because a key pressed
   * while a webview (the infoview) has the focus goes to that webview's own document and
   * never reaches the workbench's keybindings.
   */
  async focusEditor() {
    const editor = '.editor-group-container.active .monaco-editor'
    await this.until('the editor to take the keyboard focus', async () => {
      await this.page.evaluate(sel => {
        const input = document.querySelector(`${sel} .native-edit-context, ${sel} textarea`)
        input?.focus()
      }, editor)
      return this.page.evaluate(sel => !!document.activeElement?.closest(sel), editor)
    }, 5000)
  }

  /** Run a command through the palette; used before the take, never during it. */
  async command(title) {
    const widget = '.quick-input-widget'
    await this.focusEditor()
    // A key pressed while the workbench is still restoring is dropped; press again.
    for (let attempt = 1; ; attempt++) {
      await this.page.keyboard.press('Control+Shift+P')
      try { await this.focusIn(widget, 'the command palette'); break }
      catch (err) { if (attempt === 3) throw err }
      await this.page.keyboard.press('Escape')
    }
    await this.page.keyboard.type(title)
    const re = new RegExp(title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
    await this.choose(widget, re, `command "${title}"`, 10000)
    await this.page.keyboard.press('Enter')
    await sleep(400)
  }
}

// ---------------------------------------------------------------------------------------
// Recording: Page.startScreencast frames with their timestamps.

class Recorder {
  constructor(cdp) {
    this.cdp = cdp
    this.frames = []
    this.onFrame = async ({ data, sessionId }) => {
      // Arrival time, on the same clock as the typing spans it is retimed against.
      const t = Date.now() / 1000
      const file = `${String(this.frames.length).padStart(5, '0')}.png`
      fs.writeFileSync(path.join(FRAMES, file), Buffer.from(data, 'base64'))
      this.frames.push({ file, t })
      await this.cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {})
    }
  }

  async start() {
    fs.rmSync(FRAMES, { recursive: true, force: true })
    fs.mkdirSync(FRAMES, { recursive: true })
    this.cdp.on('Page.screencastFrame', this.onFrame)
    await this.cdp.send('Page.startScreencast', { format: 'png', everyNthFrame: 1 })
  }

  /** Stop; the last frame is held for `holdMs`. Writes what encode() needs. */
  async stop(holdMs, typing) {
    await this.cdp.send('Page.stopScreencast')
    this.cdp.off('Page.screencastFrame', this.onFrame)
    const last = this.frames[this.frames.length - 1]
    const recording = { frames: this.frames, end: (last ? last.t : 0) + holdMs / 1000, typing }
    fs.writeFileSync(path.join(WORK, 'frames.json'), JSON.stringify(recording, null, 1))
    return this.frames
  }
}

/**
 * Display time of each frame. Typing is retimed to its intended speed: every keystroke is
 * a round trip to a renderer that is also encoding frames, so on a busy machine it runs
 * at a fraction of that, and differently from run to run. Everything between keystrokes --
 * how long Isabelle takes to check, to complete, to jump -- keeps its real duration.
 */
function retime({ frames, end, typing }, realTime) {
  const spans = realTime ? [] : typing
    .filter(s => s.end - s.start > s.target).sort((a, b) => a.start - b.start)
  const map = t => {
    let shift = 0
    for (const s of spans) {
      if (t >= s.end) shift += (s.end - s.start) - s.target
      else if (t > s.start) { shift += (t - s.start) * (1 - s.target / (s.end - s.start)); break }
      else break
    }
    return t - shift
  }
  const out = []
  for (let i = 0; i < frames.length; i++) {
    const duration = map(i + 1 < frames.length ? frames[i + 1].t : end) - map(frames[i].t)
    // GIF delays are whole centiseconds, and browsers slow anything under 2 to 10. A frame
    // that short is dropped; the one before it stays up for its time instead.
    if (duration < 0.02 && out.length > 0) out[out.length - 1].duration += duration
    else out.push({ file: frames[i].file, duration })
  }
  return out
}

// ---------------------------------------------------------------------------------------
// The storyboard. Each beat names what it shows; `until` makes it wait for the evidence.

const SUGGEST = '.editor-widget.suggest-widget'
const QUICK = '.quick-input-widget'

async function take(d) {
  d.mark('find a symbol with Ctrl+T')
  await d.press('Control+T')
  await d.focusIn(QUICK, 'the symbol search')
  await d.pause(250)
  await d.type('mirror')
  await d.choose(QUICK, /^mirror\b/, 'the mirror function in the symbol search')
  await d.pause(700)
  await d.press('Enter')
  await d.tab('Tree.thy')
  await d.pause(1800)
  await d.press('Alt+ArrowLeft')
  await d.tab('Demo.thy')
  await d.pause(500)

  d.mark('state a lemma, checked as it is typed')
  await d.type('lemma contents_mirror: "contents (mirror t) = rev (contents t)"')
  await d.infoview('goal', 'goal (1 subgoal)', 30000)
  await d.pause(1200)

  d.mark('induction: two subgoals in the infoview')
  await d.press('Enter')
  await d.type('apply (induction t)')
  await d.infoview('two subgoals', 'goal (2 subgoals)', 30000)
  await d.pause(2000)
  // The new line is indented by the number of open subgoals.
  await d.press('Enter')
  await d.type('apply auto')
  await d.infoview('no subgoals', 'No subgoals!', 30000)
  await d.pause(1200)
  await d.press('Enter')
  await d.type('done')
  await d.pause(500)
  await d.press('Enter', 'Enter')

  d.mark('type \\==> and see the glyph, then hover it')
  await d.type('lemma "mirror t = mirror u \\==>')
  // The rest waits for the rewrite, which a keystroke racing it would cancel.
  await d.until('\\==> to become \\<Longrightarrow>',
    async () => (await d.editorText()).includes('\\<Longrightarrow>'), 5000)
  const rest = ' contents t = contents u"'
  await d.type(rest)
  await d.infoview('goal', 'contents t = contents u', 30000)
  await d.pause(600)
  // Hovered once the statement parses, so the hover holds the symbol and no syntax error:
  // back over the rest of the line, then one more step onto the glyph.
  await d.hold('ArrowLeft', rest.length + 1)
  await d.press('Control+K', 'Control+I')
  await d.until('the symbol hover', () => d.visible('.monaco-hover', 'Longrightarrow'), 5000)
  await d.pause(2600)
  await d.press('Escape', 'End')
  await d.pause(300)

  d.mark('complete a fact of our own, then one of HOL')
  await d.press('Enter')
  await d.type('by (metis contents_mi')
  await d.choose(SUGGEST, /contents_mirror/, 'contents_mirror in the completion list', 20000,
    'Control+Space')
  await d.pause(700)
  await d.press('Tab')
  await d.type(' rev_rev')
  await d.choose(SUGGEST, /rev_rev_ident/, 'rev_rev_ident in the completion list', 20000,
    'Control+Space')
  await d.pause(700)
  await d.press('Tab')
  // Past the `)` that typing `(` put there.
  await d.press('End')
  await d.until('the proof to be accepted', async () =>
    (await d.status()) === 'idle' && (await d.errors()) === 0, 30000)
  await d.pause(1500)

  d.mark('go to the definition of a HOL fact')
  await d.press('ArrowLeft', 'ArrowLeft')
  await d.pause(300)
  await d.press('F12')
  await d.tab('List.thy', 30000)
  // Until the key overlay has faded, so the frame held at the end is the lemma alone.
  await d.pause(2300)
  d.mark('end')
}

/** The theory the take must leave behind, compared with whitespace collapsed. */
const EXPECTED = `theory Demo imports Tree begin
lemma contents_mirror: "contents (mirror t) = rev (contents t)"
apply (induction t) apply auto done
lemma "mirror t = mirror u \\<Longrightarrow> contents t = contents u"
by (metis contents_mirror rev_rev_ident)
end`

const squash = s => s.replace(/\s+/g, ' ').trim()

// ---------------------------------------------------------------------------------------
// Encoding.

function ffmpeg() {
  const candidates = [process.env.FFMPEG, 'ffmpeg'].filter(Boolean)
  return candidates.find(c => spawnSync(c, ['-version'], { stdio: 'ignore' }).status === 0)
}

function encode(opts) {
  const listFile = path.join(WORK, 'frames.json')
  if (!fs.existsSync(listFile)) throw new Error('No recording to encode; run without --encode-only.')
  const list = retime(JSON.parse(fs.readFileSync(listFile, 'utf8')), opts.realTime)
  console.log(`${list.length} frames, ${list.reduce((a, f) => a + f.duration, 0).toFixed(1)}s`)
  // The concat demuxer takes each frame's display time; the last entry is repeated
  // because its duration is otherwise ignored.
  const lines = ['ffconcat version 1.0']
  for (const f of list) {
    lines.push(`file '${path.join(FRAMES, f.file).replace(/\\/g, '/')}'`, `duration ${f.duration.toFixed(3)}`)
  }
  lines.push(`file '${path.join(FRAMES, list[list.length - 1].file).replace(/\\/g, '/')}'`)
  const concat = path.join(WORK, 'frames.ffconcat')
  fs.writeFileSync(concat, lines.join('\n') + '\n')

  const bin = ffmpeg()
  if (!bin) {
    console.log(`\nffmpeg not found, so the frames were kept but not encoded:\n  ${FRAMES}\n` +
      'Install it (e.g. `winget install Gyan.FFmpeg`) or set $FFMPEG, then run\n' +
      '  node scripts/demo/record.js --encode-only')
    return false
  }
  fs.mkdirSync(path.dirname(opts.out), { recursive: true })
  // One palette for the whole clip, built from what changes between frames; no dithering,
  // which on flat UI colours only adds noise and bytes.
  const scale = opts.gifWidth ? `scale=${opts.gifWidth}:-1:flags=lanczos,` : ''
  const gifFilter = `${scale}split[a][b];` +
    '[a]palettegen=stats_mode=diff:max_colors=256[p];' +
    '[b][p]paletteuse=dither=none:diff_mode=rectangle'
  run(bin, ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', concat,
    '-filter_complex', gifFilter, '-fps_mode', 'vfr', opts.out])
  console.log(`wrote ${path.relative(REPO, opts.out)} (${(fs.statSync(opts.out).size / 1e6).toFixed(1)} MB)`)
  if (opts.mp4) {
    run(bin, ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', concat,
      '-vf', 'fps=30,format=yuv420p', '-c:v', 'libx264', '-crf', '18', opts.mp4])
    console.log(`wrote ${path.relative(REPO, opts.mp4)}`)
  }
  return true
}

// ---------------------------------------------------------------------------------------

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  fs.mkdirSync(WORK, { recursive: true })
  if (opts.encodeOnly) { encode(opts); return }

  // Not fatal: the storyboard's symbols (⟹, ⇒, ⋀) exist in common fonts. Without
  // Isabelle's font the editor is set in the system's monospace font, and Windows takes
  // just those symbols from another font; only symbols such as script letters or bold
  // digits would show as boxes.
  if (!fontInstalled('Isabelle DejaVu Sans Mono')) {
    console.warn('warning: the Isabelle fonts are not installed (README step 3); the ' +
      'recording uses the system monospace font instead.')
  }
  const home = findStockHome()
  if (!home) throw new Error('No Isabelle found. Set ISABELLE_HOME, or install one under ~/Isabelle.')

  const vsix = path.join(WORK, 'demo.vsix')
  if (!opts.reuseVsix || !fs.existsSync(vsix)) packageExtension(home, vsix)

  const code = await resolveVSCode(opts.vscode)
  console.log(`VS Code: ${code}`)
  const dirs = freshRun(home, opts)
  run(code, [cliJs(code), '--install-extension', vsix, '--force',
    `--user-data-dir=${dirs.user}`, `--extensions-dir=${dirs.extensions}`],
  { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } })

  const port = await freePort()
  const demo = path.join(dirs.workspace, 'Demo.thy')
  const child = spawn(code, [
    dirs.workspace, '--goto', `${demo}:5:1`,
    `--user-data-dir=${dirs.user}`, `--extensions-dir=${dirs.extensions}`,
    `--remote-debugging-port=${port}`,
    '--password-store=basic', '--skip-welcome', '--skip-release-notes',
    '--disable-workspace-trust', '--new-window',
    // Frames at exactly the emulated size, and rendered even when the window is covered.
    '--force-device-scale-factor=1',
    '--disable-features=CalculateNativeWinOcclusion',
    '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
  ], { stdio: 'ignore', detached: process.platform !== 'win32' })

  let browser
  try {
    const { chromium } = require('playwright-core')
    const endpoint = `http://127.0.0.1:${port}`
    browser = await until('VS Code to accept DevTools connections',
      () => chromium.connectOverCDP(endpoint).catch(() => undefined), 60000)
    const context = browser.contexts()[0]
    const page = await until('the workbench window', async () =>
      context.pages().find(p => p.url().includes('workbench')), 60000)
    const cdp = await context.newCDPSession(page)
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true })
    // The workbench laid out at exactly width x height, whatever the real window and
    // display are. The frames come at this size: a larger deviceScaleFactor here would
    // lose to --force-device-scale-factor, which keeps the display's own scale out.
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: opts.width, height: opts.height, deviceScaleFactor: 1, mobile: false,
    })
    // VS Code lays out on resize events only, and the override does not always send one.
    await page.evaluate(() => window.dispatchEvent(new Event('resize')))

    const d = new Director(page, cdp, opts.pace)
    await d.tab('Demo.thy', 60000)
    // The extension's status item exists once it has activated.
    await d.until('the Isabelle item in the status bar',
      async () => (await d.status()) !== 'absent', 120000)
    await sleep(1500)
    await d.command('Isabelle: Show Infoview')
    console.log('waiting for Isabelle to start and check Tree.thy...')
    let seenBusy = false, idleSince = 0
    await d.until('Isabelle to finish checking (see the status bar)', async () => {
      const s = await d.status()
      if (s.startsWith('busy')) seenBusy = true
      if (s !== 'idle' || (await d.errors()) > 0) { idleSince = 0; return false }
      idleSince ||= Date.now()
      // Before the first progress report the item is idle too; wait that out.
      return Date.now() - idleSince > (seenBusy ? 3000 : 20000)
    }, 15 * 60000)
    await d.command('Notifications: Clear All Notifications')
    await d.command('Developer: Toggle Screencast Mode')
    await d.focusEditor()
    // Let the overlay forget the palette keys before the first frame.
    await sleep(2500)

    const rec = new Recorder(cdp)
    console.log('recording:')
    d.t0 = Date.now()
    await rec.start()
    try {
      await take(d)
    } finally {
      const frames = await rec.stop(3500, d.typing)
      fs.writeFileSync(path.join(WORK, 'timeline.json'), JSON.stringify(d.timeline, null, 1))
      console.log(`${frames.length} frames in ${path.relative(REPO, FRAMES)}`)
    }

    await page.keyboard.press('Alt+ArrowLeft')
    await d.tab('Demo.thy')
    await page.keyboard.press('Control+S')
    await sleep(500)
    const written = fs.readFileSync(demo, 'utf8')
    if (squash(written) !== squash(EXPECTED)) {
      throw new Error(`Demo.thy is not what the storyboard types:\n${written}`)
    }
    if (opts.keepOpen) {
      console.log('--keep-open: close VS Code to finish.')
      await new Promise(r => child.once('exit', r))
    }
  } catch (err) {
    // The VS Code page as it was when the step failed; only this window's renderer.
    const page = browser?.contexts()[0]?.pages().find(p => p.url().includes('workbench'))
    if (page) {
      await page.screenshot({ path: path.join(WORK, 'failure.png') }).catch(() => {})
      console.error(`page at the failure: ${path.relative(REPO, path.join(WORK, 'failure.png'))}`)
    }
    throw err
  } finally {
    if (browser) await browser.close().catch(() => {})
    if (!opts.keepOpen) killTree(child)
  }
  encode(opts)
}

main().catch(err => {
  console.error(`\n${err.message || err}`)
  process.exit(1)
})
