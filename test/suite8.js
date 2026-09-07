// Re-measure decoration cost with PIDE markup attached.
//
// The earlier benchmarks measured symbol rendering alone, with no language server.
// PIDE markup now adds its own decorations to the same editors, so the question is
// what the combined, shipped configuration actually costs on a large theory.
const vscode = require('vscode')
const fs = require('fs')
const path = require('path')

const wait = ms => new Promise(r => setTimeout(r, ms))
const now = () => Number(process.hrtime.bigint() / 1000n) / 1000
const sorted = a => [...a].sort((x, y) => x - y)
const median = a => sorted(a)[Math.floor(a.length / 2)]
const p95 = a => sorted(a)[Math.min(a.length - 1, Math.floor(a.length * 0.95))]
const f2 = x => +x.toFixed(2)

function bigTheory(lemmas) {
  const out = ['theory Big', '  imports Main', 'begin', '']
  for (let i = 0; i < lemmas; i++) {
    out.push(`lemma l${i}: "\\<forall>x::nat. x + ${i} = ${i} + x \\<and> x \\<le> x + ${i}"`)
    out.push('  by (simp add: add.commute)')
    out.push('')
    out.push(`lemma m${i}: "A \\<union> B \\<subseteq> A \\<union> B \\<union> C\\<^sub>${i % 10}"`)
    out.push('  by auto')
    out.push('')
  }
  out.push('end', '')
  return out.join('\n')
}

function nextVisibleChange(editor, timeoutMs) {
  return new Promise(resolve => {
    let done = false
    const d = vscode.window.onDidChangeTextEditorVisibleRanges(e => {
      if (e.textEditor === editor && !done) { done = true; d.dispose(); clearTimeout(t); resolve(true) }
    })
    const t = setTimeout(() => { if (!done) { done = true; d.dispose(); resolve(false) } }, timeoutMs)
  })
}

async function typingRun(editor, steps) {
  const line = Math.floor(editor.document.lineCount / 2)
  editor.revealRange(new vscode.Range(line, 0, line, 0), vscode.TextEditorRevealType.InCenter)
  await wait(400)
  const lats = []
  for (let i = 0; i < steps; i++) {
    const t0 = now()
    await editor.edit(b => b.insert(new vscode.Position(line, 0), 'x'),
      { undoStopBefore: false, undoStopAfter: false })
    lats.push(now() - t0)
  }
  return { median: f2(median(lats)), p95: f2(p95(lats)) }
}

async function scrollRun(editor, steps, stride) {
  const span = Math.max(1, editor.document.lineCount - 400)
  const lats = []
  for (let i = 0; i < steps; i++) {
    const line = 200 + ((i + 1) * stride) % span
    const t0 = now()
    const p = nextVisibleChange(editor, 400)
    editor.revealRange(new vscode.Range(line, 0, line, 0), vscode.TextEditorRevealType.InCenter)
    await p
    lats.push(now() - t0)
  }
  return { median: f2(median(lats)), p95: f2(p95(lats)) }
}

async function run() {
  const ext = vscode.extensions.getExtension('spike.isabelle-pide-stock')
  await ext.activate()

  const ws = vscode.workspace.workspaceFolders[0].uri.fsPath
  const file = path.join(ws, 'Big.thy')
  const text = bigTheory(1500)
  fs.writeFileSync(file, text, 'utf8')

  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file))
  const editor = await vscode.window.showTextDocument(doc, { preview: false })
  const lines = doc.lineCount
  const occurrences = (text.match(/\\<\^?[A-Za-z][A-Za-z0-9_']*>/g) || []).length
  console.log(`Big.thy: ${lines} lines, ${occurrences} symbol occurrences, ` +
              `${(Buffer.byteLength(text, 'utf8') / 1048576).toFixed(2)} MB`)

  const mid = Math.floor(lines / 2)
  editor.selection = new vscode.Selection(mid, 0, mid, 0)
  editor.revealRange(new vscode.Range(mid, 0, mid, 0), vscode.TextEditorRevealType.InCenter)

  // Wait until the amount of markup stops growing, so every configuration below is
  // measured against an identical range set. Without this the runs are incomparable:
  // two earlier runs differed by 51516 vs 9004 ranges purely on timing.
  console.log('\nwaiting for PIDE markup to stabilise...')
  let pideSummary
  let previous = -1
  let stable = 0
  const deadline = Date.now() + 300000
  while (Date.now() < deadline) {
    pideSummary = await vscode.commands.executeCommand('isabelle.pideDecorationSummary')
    const total = pideSummary ? Object.values(pideSummary).reduce((a, b) => a + b, 0) : 0
    if (total > 0 && total === previous) { if (++stable >= 3) break } else stable = 0
    previous = total
    await wait(4000)
  }
  const pideRanges = pideSummary ? Object.values(pideSummary).reduce((a, b) => a + b, 0) : 0
  const symbolRanges =
    (await vscode.commands.executeCommand('isabelle.decorationRanges'))?.hidden ?? 0

  console.log(`PIDE markup ranges   : ${pideRanges} across ${Object.keys(pideSummary || {}).length} types`)
  console.log(`symbol decoration ranges (viewport ±100): ${symbolRanges}`)

  const cfg = vscode.workspace.getConfiguration('isabelle')
  const results = {}

  // Configurations are interleaved across rounds rather than measured once each.
  // A single pass through them is not trustworthy: the language server keeps processing
  // in the background, so run-to-run drift exceeded the effects being compared and
  // produced impossible readings (a configuration "faster" than doing nothing, and a
  // negative cost for enabling a feature).
  const CONFIGS = [
    ['neither', false, true, false],
    ['symbols only', false, true, true],
    ['PIDE viewport only', true, true, false],
    ['PIDE viewport + symbols', true, true, true],
    ['PIDE whole-doc + symbols', true, false, true],
  ]
  const ROUNDS = 3
  const samples = new Map(CONFIGS.map(c => [c[0], { typing: [], scroll: [] }]))

  for (let round = 0; round < ROUNDS; round++) {
    console.log(`\nround ${round + 1}/${ROUNDS}`)
    for (const [label, pideMarkup, viewportScope, renderSymbols] of CONFIGS) {
      await cfg.update('pideMarkup', pideMarkup, vscode.ConfigurationTarget.Global)
      await cfg.update('pideViewportScope', viewportScope, vscode.ConfigurationTarget.Global)
      await cfg.update('renderSymbols', renderSymbols, vscode.ConfigurationTarget.Global)
      await wait(2000)
      const t = await typingRun(editor, 20)
      const s = await scrollRun(editor, 25, 40)
      samples.get(label).typing.push(t.median)
      samples.get(label).scroll.push(s.median)
      console.log(`  ${label.padEnd(28)} typing ${String(t.median).padStart(6)}   scroll ${String(s.median).padStart(6)}`)
    }
  }

  console.log(`\n=== median of ${ROUNDS} interleaved rounds (ms) ===`)
  for (const [label] of CONFIGS) {
    const s = samples.get(label)
    const typing = f2(median(s.typing))
    const scroll = f2(median(s.scroll))
    results[label] = { typing, scroll, typingSamples: s.typing, scrollSamples: s.scroll }
    console.log(`  ${label.padEnd(28)} typing ${String(typing).padStart(6)} ${JSON.stringify(s.typing)}` +
                `   scroll ${String(scroll).padStart(6)} ${JSON.stringify(s.scroll)}`)
  }

  const d = (a, b, k) => +(results[a][k] - results[b][k]).toFixed(2)
  console.log('\n=== marginal cost of symbol rendering ===')
  console.log(`  typing: ${d('symbols only', 'neither', 'typing')} ms alone,` +
              ` ${d('PIDE viewport + symbols', 'PIDE viewport only', 'typing')} ms alongside PIDE`)
  console.log(`  scroll: ${d('symbols only', 'neither', 'scroll')} ms alone,` +
              ` ${d('PIDE viewport + symbols', 'PIDE viewport only', 'scroll')} ms alongside PIDE`)
  console.log('\n=== marginal cost of PIDE markup (viewport-scoped) ===')
  console.log(`  typing: ${d('PIDE viewport only', 'neither', 'typing')} ms   ` +
              `scroll: ${d('PIDE viewport only', 'neither', 'scroll')} ms`)

  await cfg.update('pideMarkup', true, vscode.ConfigurationTarget.Global)
  await cfg.update('renderSymbols', true, vscode.ConfigurationTarget.Global)
  await cfg.update('pideViewportScope', true, vscode.ConfigurationTarget.Global)

  fs.writeFileSync(path.join(ws, '..', 'perf.json'),
    JSON.stringify({ lines, occurrences, pideRanges, pideSummary, symbolRanges, results }, null, 2))
  console.log('\nSUITE8_DONE')
}

module.exports = { run }
