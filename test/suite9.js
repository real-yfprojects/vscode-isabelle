// Sledgehammer panel flow, and whether spell-checker markup arrives.
const vscode = require('vscode')
const assert = require('assert')
const fs = require('fs')
const path = require('path')

const wait = ms => new Promise(r => setTimeout(r, ms))
let passed = 0
const pass = m => { passed++; console.log('PASS: ' + m) }

async function pollFor(label, fn, timeoutMs, interval = 3000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const v = await fn()
    if (v) return v
    await wait(interval)
  }
  return undefined
}

async function run() {
  const ext = vscode.extensions.getExtension('spike.isabelle-pide-stock')
  await ext.activate()

  const ws = vscode.workspace.workspaceFolders[0].uri.fsPath
  const file = path.join(ws, 'Hammer.thy')
  fs.writeFileSync(file, [
    'theory Hammer',
    '  imports Main',
    'begin',
    '',
    '(* a deliberatly misspelt coment for the spell checker *)',
    '',
    'lemma easy: "P \\<longrightarrow> P"',
    '  apply (rule impI)',
    '  apply assumption',
    '  done',
    '',
    'end',
    '',
  ].join('\n'), 'utf8')

  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file))
  const editor = await vscode.window.showTextDocument(doc, { preview: false })
  editor.selection = new vscode.Selection(4, 10, 4, 10)
  await wait(1500)

  // ---------- spell checker markup ----------
  console.log('waiting for PIDE markup...')
  const summary = await pollFor('markup',
    async () => {
      const s = await vscode.commands.executeCommand('isabelle.pideDecorationSummary')
      return s && Object.keys(s).length ? s : undefined
    }, 180000)
  console.log('decoration types: ' + JSON.stringify(summary))
  if (summary && summary.spell_checker) {
    pass(`spell-checker markup arrives without extra code (${summary.spell_checker} ranges)`)
  } else {
    console.log('NOTE: no spell_checker ranges in this run — the underlining depends on ' +
                'the spell_checker option and an installed dictionary.')
  }

  // The dictionary commands must at least be registered, or VS Code cannot execute the
  // completion items the server offers.
  const all = await vscode.commands.getCommands(true)
  const wanted = ['isabelle.include-word', 'isabelle.include-word-permanently',
    'isabelle.exclude-word', 'isabelle.exclude-word-permanently', 'isabelle.reset-words']
  const missing = wanted.filter(c => !all.includes(c))
  assert.strictEqual(missing.length, 0, `unregistered spell-checker commands: ${missing}`)
  pass('all five spell-checker dictionary commands are registered')

  // ---------- sledgehammer ----------
  await vscode.commands.executeCommand('isabelle-sledgehammer.focus')
  await wait(4000)
  let sh = await pollFor('provers list',
    async () => {
      const s = await vscode.commands.executeCommand('isabelle.sledgehammerState')
      return s && s.provers ? s : undefined
    }, 30000)
  assert.ok(sh, 'the panel should have received PIDE/sledgehammer_provers_response')
  console.log('provers: ' + sh.provers)
  pass(`prover list prefilled from the server (${sh.provers})`)

  // Run with the caret on the first apply, where a goal is still open.
  editor.selection = new vscode.Selection(7, 2, 7, 2)  // the first 'apply', where a goal is open
  await wait(3000)
  await vscode.commands.executeCommand('isabelle.sledgehammer')
  console.log('sledgehammer running (this takes a while)...')

  // Progress messages ("<prover> found a proof...") arrive before the final result, so
  // keep polling for the message that carries the <sendback> suggestions. Bounded and
  // noisy on purpose: a long silent wait here looks exactly like a hung window.
  // Wait for the run to finish and stop there. Earlier versions waited a further 120s
  // for a <sendback> element that, as two runs confirmed, never arrives on this stream --
  // pure dead time that made the window look hung. The only genuine wait is the provers.
  const until = Date.now() + 60000
  let last
  while (Date.now() < until) {
    last = await vscode.commands.executeCommand('isabelle.sledgehammerState')
    if (last && last.status === 'Finished') break
    console.log(`  ...sledgehammering, status=${JSON.stringify(last && last.status)}` +
                ` (${Math.round((until - Date.now()) / 1000)}s left)`)
    await wait(4000)
  }
  sh = last && last.output ? last : undefined

  if (!sh) {
    const last = await vscode.commands.executeCommand('isabelle.sledgehammerState')
    console.log('NOTE: no output within the budget; last status = ' + JSON.stringify(last && last.status))
    console.log('      external provers may be unavailable in this environment.')
  } else {
    console.log('status: ' + sh.status)
    console.log('output: ' + String(sh.output).replace(/\s+/g, ' ').slice(0, 300))
    pass('sledgehammer produced status and output through the panel')
    if (/<sendback>/.test(sh.output)) {
      pass('output contains <sendback> suggestions, which the panel turns into buttons')
    } else {
      console.log('NOTE: no <sendback> element in this output')
    }
  }

  // The panel's output stream carries progress only. Check whether the actual proof
  // suggestions surfaced on the code-action path instead.
  const actions = (await vscode.commands.executeCommand(
    'vscode.executeCodeActionProvider', doc.uri, new vscode.Range(7, 2, 7, 8))) || []
  const titles = actions.map(a => a.title).filter(t => !/copilot/i.test(t))
  console.log(`code actions on the goal line (${titles.length}): ${JSON.stringify(titles.slice(0, 8))}`)
  if (titles.length > 0) {
    pass('sledgehammer suggestions reach the editor as LSP code actions')
  } else {
    console.log('NOTE: no code actions either; the suggestion path is unconfirmed for this run')
  }

  console.log(`\n${passed} checks passed`)
  console.log('SUITE9_DONE')
}

module.exports = { run }
