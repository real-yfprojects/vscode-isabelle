// Regenerate the walkthrough's images, media/walkthrough/{fonts,symbols}-{light,dark}.png.
//
//   node scripts/walkthrough-shots.js
//
// Drives VS Code through Playwright's Electron API and screenshots the editor's own page,
// never the screen, so nothing else on the desktop can end up in a picture. Each theme
// gets a fresh profile with the extension under development, the extended server (for
// its colours) and the Isabelle font. The font is loaded into the page from the
// distribution's contrib/isabelle_fonts, so it need not be installed. The crops are taken
// once the prover has checked the theory, because the colours come from its markup.

const { _electron: electron } = require('playwright-core')
const fs = require('fs')
const os = require('os')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const OUT = path.join(ROOT, 'media', 'walkthrough')
const FONT = 'Isabelle DejaVu Sans Mono'

function codeExecutable() {
  const candidates = [
    process.env.VSCODE_EXECUTABLE,
    'C:\\Program Files\\Microsoft VS Code\\Code.exe',
    path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Microsoft VS Code', 'Code.exe'),
    '/Applications/Visual Studio Code.app/Contents/MacOS/Electron',
    '/usr/share/code/code',
  ]
  const found = candidates.find(p => p && fs.existsSync(p))
  if (!found) throw new Error('VS Code not found; set VSCODE_EXECUTABLE')
  return found
}

function isabelleHome() {
  if (process.env.ISABELLE_HOME) return process.env.ISABELLE_HOME
  const parent = path.join(os.homedir(), 'Isabelle')
  const found = fs.readdirSync(parent).filter(n => /^Isabelle\d{4}(-\d+)?$/.test(n)).sort().pop()
  if (!found) throw new Error('no Isabelle in ~/Isabelle; set ISABELLE_HOME')
  return path.join(parent, found)
}

function fontFiles(home) {
  const contrib = path.join(home, 'contrib')
  const dir = fs.readdirSync(contrib).filter(n => n.startsWith('isabelle_fonts')).sort().pop()
  const ttf = path.join(contrib, dir, 'ttf')
  return {
    normal: path.join(ttf, 'IsabelleDejaVuSansMono.ttf'),
    bold: path.join(ttf, 'IsabelleDejaVuSansMono-Bold.ttf'),
  }
}

const FONTS_THY = [
  'theory Fonts',
  '  imports Main',
  'begin',
  '',
  'text \\<open>\\<A>\\<B>\\<C> \\<AA>\\<BB> \\<one>\\<two>\\<three> \\<alpha>\\<beta>\\<gamma>\\<close>',
  '',
  'lemma "\\<lbrakk>x\\<^sub>1 \\<in> A; A \\<subseteq> B\\<rbrakk> \\<Longrightarrow> x\\<^sub>1 \\<in> B"',
  '  by blast',
  '',
  'end',
  '',
].join('\n')

const wait = ms => new Promise(r => setTimeout(r, ms))

/** 1-based line numbers of the first line containing `from` and the line before `to`. */
function lineRange(text, from, to) {
  const lines = text.split('\n')
  const first = lines.findIndex(l => l.includes(from)) + 1
  const last = to === undefined ? first : lines.findIndex(l => l.includes(to))
  return [first, last]
}

/** Close the bottom panel until it is gone: something can reopen it after startup. */
async function closePanel(page) {
  for (let i = 0; i < 5; i++) {
    const open = await page.evaluate(() => {
      const panel = document.querySelector('.part.panel')
      return !!panel && panel.getBoundingClientRect().height > 0 && getComputedStyle(panel).display !== 'none'
    })
    if (!open) return
    await page.keyboard.press('Escape')
    await runCommand(page, 'View: Close Panel')
  }
  throw new Error('the panel does not close')
}

/** Screenshot editor lines first..last (1-based, as the gutter numbers them). */
async function shootLines(page, first, last, file) {
  await closePanel(page)
  await wait(500)
  const box = await page.evaluate(([first, last]) => {
    const editor = document.querySelector('.editor-instance .monaco-editor')
    const numbers = [...editor.querySelectorAll('.margin-view-overlays .line-numbers')]
    const row = n => numbers.find(e => e.textContent.trim() === String(n))
    const a = row(first), b = row(last)
    if (!a || !b) return undefined
    const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect()
    const re = editor.getBoundingClientRect()
    // As wide as the longest of these lines, not the whole editor.
    let right = 0
    for (const line of editor.querySelectorAll('.view-line')) {
      const r = line.getBoundingClientRect()
      if (r.top < ra.top - 1 || r.bottom > rb.bottom + 1) continue
      for (const span of line.querySelectorAll('span')) right = Math.max(right, span.getBoundingClientRect().right)
    }
    return { x: re.left, y: ra.top, width: Math.min(right + 24, re.right) - re.left, height: rb.bottom - ra.top }
  }, [first, last])
  if (!box) {
    const seen = await page.evaluate(() => ({
      editors: [...document.querySelectorAll('.editor-instance .monaco-editor')].length,
      tab: document.querySelector('.tab.active')?.textContent,
      numbers: [...document.querySelectorAll('.margin-view-overlays .line-numbers')]
        .map(e => e.textContent.trim()).join(','),
    }))
    if (process.env.SHOTS_DEBUG) await page.screenshot({ path: process.env.SHOTS_DEBUG })
    throw new Error(`lines ${first}..${last} are not on screen: ${JSON.stringify(seen)}`)
  }
  const pad = 2
  await page.screenshot({ path: file,
    clip: { x: box.x, y: box.y - pad, width: box.width, height: box.height + 2 * pad } })
  console.log(`saved ${path.relative(ROOT, file)}`)
}

async function runCommand(page, title) {
  await page.keyboard.press('F1')
  await page.keyboard.type(title)
  await wait(600)
  await page.keyboard.press('Enter')
  await wait(600)
}

/** Wait until the status bar item names the session and no longer spins. */
async function waitForChecking(page, timeoutMs = 240000) {
  const deadline = Date.now() + timeoutMs
  let quiet = 0
  while (Date.now() < deadline) {
    const state = await page.evaluate(() => {
      const items = [...document.querySelectorAll('.statusbar-item')]
      const isabelle = items.find(i => /\bHOL\b/.test(i.textContent))
      return {
        found: !!isabelle,
        spinning: !!isabelle?.querySelector('.codicon-modifier-spin, .codicon-sync~spin'),
        text: isabelle?.textContent.trim(),
      }
    })
    quiet = state.found && !state.spinning ? quiet + 1 : 0
    if (quiet >= 5) return
    await wait(1000)
  }
  throw new Error('the prover did not settle')
}

async function shoot(theme, fonts) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `isa-shots-${theme}-`))
  const ws = path.join(tmp, 'ws')
  const user = path.join(tmp, 'user')
  fs.mkdirSync(path.join(user, 'User'), { recursive: true })
  fs.mkdirSync(ws)
  const tutorial = fs.readFileSync(path.join(OUT, 'Tutorial.thy'), 'utf8')
  fs.writeFileSync(path.join(ws, 'Tutorial.thy'), tutorial)
  fs.writeFileSync(path.join(ws, 'Fonts.thy'), FONTS_THY)
  fs.writeFileSync(path.join(user, 'User', 'settings.json'), JSON.stringify({
    'workbench.colorTheme': theme === 'light' ? 'Default Light Modern' : 'Default Dark Modern',
    'workbench.startupEditor': 'none',
    'workbench.tips.enabled': false,
    'workbench.activityBar.location': 'hidden',
    'workbench.layoutControl.enabled': false,
    'window.commandCenter': false,
    'security.workspace.trust.enabled': false,
    'extensions.ignoreRecommendations': true,
    'telemetry.telemetryLevel': 'off',
    'update.mode': 'none',
    'chat.disableAIFeatures': true,
    'editor.minimap.enabled': false,
    'editor.stickyScroll.enabled': false,
    'editor.glyphMargin': false,
    'editor.folding': false,
    'editor.guides.indentation': false,
    'editor.cursorBlinking': 'solid',
    'editor.fontSize': 15,
    'breadcrumbs.enabled': false,
    '[isabelle]': { 'editor.fontFamily': `'${FONT}', monospace` },
    'isabelle.extendedServer': true,
  }, null, 2))

  // The same scrubbing as test/runTest.js: inherited, these make Code.exe run as Node.
  const env = { ...process.env }
  for (const k of Object.keys(env)) {
    if (k.startsWith('VSCODE_') || k.startsWith('ELECTRON_')) delete env[k]
  }
  const [first] = lineRange(tutorial, 'lemma "\\<forall>x::nat')
  const app = await electron.launch({
    executablePath: codeExecutable(),
    env,
    args: [
      ws,
      `--extensionDevelopmentPath=${ROOT}`,
      `--user-data-dir=${user}`,
      `--extensions-dir=${path.join(tmp, 'extensions')}`,
      '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust',
      // Inside the \<forall> escape, which shows what the file stores.
      '--goto', `${path.join(ws, 'Tutorial.thy')}:${first}:${'lemma "'.length + 4}`,
    ],
  })
  try {
    const page = await app.firstWindow()
    await (await app.browserWindow(page)).evaluate(w => w.setSize(1000, 720))
    await page.waitForSelector('.editor-instance .monaco-editor', { timeout: 60000 })
    // FontFace from bytes is not a fetch, so the workbench's CSP does not apply to it.
    await page.evaluate(async ([family, normal, bold]) => {
      const bytes = b64 => Uint8Array.from(atob(b64), c => c.charCodeAt(0)).buffer
      for (const [data, weight] of [[normal, 'normal'], [bold, 'bold']]) {
        const face = new FontFace(family, bytes(data), { weight })
        await face.load()
        document.fonts.add(face)
      }
    }, [FONT, fs.readFileSync(fonts.normal).toString('base64'), fs.readFileSync(fonts.bold).toString('base64')])
    // Everything but the editor closed, by command rather than by toggling shortcut: what
    // a fresh profile shows at start differs between VS Code versions.
    for (const command of ['View: Close Primary Side Bar', 'View: Close Secondary Side Bar',
                           'View: Close Panel']) {
      await runCommand(page, command)
    }
    await waitForChecking(page)
    await wait(2000)

    const [symFirst, symLast] = lineRange(tutorial, 'section \\<open>Symbols', 'section \\<open>Goals')
    await shootLines(page, symFirst, symLast - 1, path.join(OUT, `symbols-${theme}.png`))

    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+P' : 'Control+P')
    await page.keyboard.type('Fonts.thy')
    await wait(800)
    await page.keyboard.press('Enter')
    await wait(1500)
    await waitForChecking(page)
    await wait(2000)
    await shootLines(page, 5, 8, path.join(OUT, `fonts-${theme}.png`))
  } finally {
    await app.close()
    try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }) } catch { /* EBUSY on Windows */ }
  }
}

async function main() {
  const fonts = fontFiles(isabelleHome())
  for (const theme of process.argv.slice(2).length ? process.argv.slice(2) : ['light', 'dark']) {
    await shoot(theme, fonts)
  }
}

main().catch(err => { console.error(err); process.exit(1) })
