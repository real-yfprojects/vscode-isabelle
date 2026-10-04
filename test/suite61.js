// Code skeletons end to end (src/skeleton_provider.ts), against whatever server runs --
// the outline is Isabelle's own, so the stock one serves it too.
//
// What is held down: the server's sendback code actions arrive titled and with a kind (an
// outline as "Insert proof outline (2 cases)", try0's proofs as "Insert proof: by simp",
// one of them preferred), and ENTER after `proof (induction xs)` brings the outline as
// ghost text that Tab-equivalent commit turns into a proof the prover accepts.
const vscode = require('vscode')
const assert = require('assert')
const fs = require('fs')
const path = require('path')

const wait = ms => new Promise(r => setTimeout(r, ms))
let passed = 0
const pass = m => { passed++; console.log('PASS: ' + m) }

async function until(what, seconds, probe) {
  const deadline = Date.now() + seconds * 1000
  while (Date.now() < deadline) {
    const value = await probe()
    if (value) return value
    console.log(`  ...${what} (${Math.round((deadline - Date.now()) / 1000)}s left)`)
    await wait(1000)
  }
  return undefined
}

const lineOf = (doc, text) => {
  for (let i = 0; i < doc.lineCount; i++) if (doc.lineAt(i).text === text) return i
  throw new Error(`no line ${JSON.stringify(text)}`)
}
const actionsAt = async (doc, line) => {
  const end = doc.lineAt(line).range.end
  return (await vscode.commands.executeCommand('vscode.executeCodeActionProvider',
    doc.uri, new vscode.Range(end, end))) || []
}
const ours = actions => actions.filter(a => a.kind && a.kind.value.includes('.isabelle.'))

/* Takes the ghost text at the caret: by committing it, as Tab does, while the window has
   focus -- VS Code shows ghost text only in a focused editor, which a test window running
   beside others is not -- and otherwise by asking the provider what it would show
   (isabelle.skeletonProbe) and applying that. A focused window that never shows it fails. */
/* Types text at a position, as the user would -- which is what makes VS Code ask for ghost
   text -- while the window has focus. Typing into an unfocused window may go nowhere, so
   there the text is inserted by an edit. */
async function typeAt(editor, pos, text) {
  const before = editor.document.getText()
  if (vscode.window.state.focused) {
    editor.selection = new vscode.Selection(pos, pos)
    await vscode.commands.executeCommand('type', { text })
    if (editor.document.getText() !== before) return
  }
  await editor.edit(b => b.insert(pos, text))
}

let ghostNote = ''
async function takeGhost(editor, line, done, seconds, trigger = false) {
  const deadline = Date.now() + seconds * 1000
  let unfocused = false
  while (Date.now() < deadline) {
    if (!vscode.window.state.focused) { unfocused = true; break }
    if (trigger) await vscode.commands.executeCommand('editor.action.inlineSuggest.trigger')
    await wait(trigger ? 1000 : 300)
    await vscode.commands.executeCommand('editor.action.inlineSuggest.commit')
    await wait(300)
    if (done()) return 'ghost text'
  }
  if (!unfocused) {
    const probe = await vscode.commands.executeCommand('isabelle.skeletonProbe', line)
    ghostNote = `focused, never committed; the provider would show: ${JSON.stringify(probe)}`
    return undefined
  }
  /* Each probe waits for the prover only as long as the provider does, which a prover
     shared with other suites can exceed: ask again until the test's own deadline. */
  while (Date.now() < deadline) {
    const item = await vscode.commands.executeCommand('isabelle.skeletonProbe', line)
    if (item) {
      await editor.edit(b => b.replace(new vscode.Range(...item.range), item.text))
      return done() ? 'the provider (window unfocused)' : undefined
    }
    await wait(500)
  }
  ghostNote = 'unfocused, and the provider shows nothing'
  return undefined
}

async function run() {
  const ext = vscode.extensions.getExtension('yfprojects.vscode-isabelle')
  await ext.activate()

  const ws = vscode.workspace.workspaceFolders[0].uri.fsPath
  const file = path.join(ws, 'Outline.thy')
  fs.writeFileSync(file, [
    'theory Outline',
    '  imports Main',
    'begin',
    '',
    'lemma "rev (rev xs) = xs"',
    '  proof (induction xs)',
    '',
    'lemma "(n::nat) + 0 = n"',
    '  try0',
    '  oops',
    '',
    'end',
    '',
  ].join('\n'), 'utf8')
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file))
  const editor = await vscode.window.showTextDocument(doc, { preview: false })

  const server = await until('the server to start', 240, async () => {
    const s = await vscode.commands.executeCommand('isabelle.serverState')
    return s && s.state === 'Running' ? s : undefined
  })
  assert.ok(server, 'the server should start')
  pass('language server runs')

  // --- code actions ------------------------------------------------------------------------
  const proofLine = lineOf(doc, '  proof (induction xs)')
  const outlines = await until('the outline action', 180, async () => {
    const a = ours(await actionsAt(doc, proofLine))
    return a.length ? a : undefined
  })
  assert.ok(outlines, 'the outline should be offered on the proof line')
  assert.deepStrictEqual(outlines.map(a => a.title), ['Insert proof outline (2 cases)'])
  assert.strictEqual(outlines[0].kind.value, 'refactor.rewrite.isabelle.outline')
  const [[, [edit]]] = outlines[0].edit.entries()
  assert.ok(edit.newText.startsWith('proof (induction xs)\n    case Nil\n'),
    'the edit is still the server\'s: ' + JSON.stringify(edit.newText))
  pass('the outline is a titled refactoring')

  const try0Line = lineOf(doc, '  try0')
  const proofs = await until('try0\'s proofs', 180, async () => {
    const a = ours(await actionsAt(doc, try0Line))
    return a.length >= 2 ? a : undefined
  })
  assert.ok(proofs, 'try0 should find proofs for n + 0 = n')
  assert.ok(proofs.every(a => a.kind.value === 'quickfix.isabelle.proof'), 'all found proofs are quick fixes')
  assert.ok(proofs.some(a => a.title === 'Insert proof: by simp'), JSON.stringify(proofs.map(a => a.title)))
  assert.strictEqual(proofs.filter(a => a.isPreferred).length, 1, 'exactly one preferred proof')
  pass('found proofs are titled quick fixes, one preferred')

  // --- ghost text ----------------------------------------------------------------------------
  const end = doc.lineAt(proofLine).range.end
  await typeAt(editor, end, '\n')
  assert.ok(doc.lineAt(proofLine + 1).text.trim() === '', 'ENTER opened a blank line')

  /* No explicit trigger: VS Code asks on the edit itself, and the ghost text has to show
     up then, since that is when the user looks for it. The extended server re-indents the
     `proof` line on ENTER (under its `lemma`), a change of its own: what tells that the
     ghost text was taken is the outline below the proof, wherever that ended up. */
  const hasCase = line => /^ *case Nil$/.test(doc.lineAt(line + 1).text)
  const accepted = await takeGhost(editor, proofLine + 1, () => hasCase(proofLine), 15)
  assert.ok(accepted, ghostNote + '; committing should insert the outline: ' +
    JSON.stringify(doc.getText().split('\n').slice(proofLine, proofLine + 3)))
  console.log(`outline taken from ${accepted}`)
  const p = /^ */.exec(doc.lineAt(proofLine).text)[0]
  const lines = doc.getText().split('\n').slice(proofLine, proofLine + 7)
  assert.deepStrictEqual(lines, [
    'proof (induction xs)',
    '  case Nil',
    '  then show ?case sorry',
    'next',
    '  case (Cons a xs)',
    '  then show ?case sorry',
    'qed',
  ].map(l => p + l))
  pass('ENTER below the proof offers the outline as ghost text, and commit inserts it')

  /* The outline is a proof the prover takes: only the sorries are left to fill in. Before,
     the open proof made the next `lemma` an error; checked past it, try0 answers again. */
  const try0After = lineOf(doc, '  try0')
  const settled = await until('the outline to be checked', 120, async () => {
    const errors = vscode.languages.getDiagnostics(doc.uri)
      .filter(d => d.severity === vscode.DiagnosticSeverity.Error)
    return errors.length === 0 && ours(await actionsAt(doc, try0After)).length >= 2
  })
  assert.ok(settled, 'the inserted outline should check without errors: ' +
    JSON.stringify(vscode.languages.getDiagnostics(doc.uri).map(d => [d.range.start.line, d.message])))
  pass('the inserted outline checks without errors')

  // No second offer on top of the outline just written.
  const qedEnd = doc.lineAt(proofLine + 6).range.end
  await typeAt(editor, qedEnd, '\n')
  await wait(1500) // any re-indentation of the server first
  assert.strictEqual(await vscode.commands.executeCommand('isabelle.skeletonProbe', proofLine + 7), undefined,
    'below qed nothing is offered')
  pass('no ghost text below a finished outline')

  /* The usual way: type the method and ENTER at once, before the prover has run it. The
     provider waits for the outline rather than answering "nothing" right away. */
  const oopsLine = lineOf(doc, '  oops')
  await editor.edit(b => b.insert(doc.lineAt(oopsLine).range.end,
    '\n\nlemma "length (xs @ ys) = length xs + length ys"'))
  const lemmaEnd = doc.lineAt(oopsLine + 2).range.end
  await typeAt(editor, lemmaEnd, '\n  proof (induction xs)')
  await typeAt(editor, doc.lineAt(oopsLine + 3).range.end, '\n')
  const t0 = Date.now()
  const late = await takeGhost(editor, oopsLine + 4, () => hasCase(oopsLine + 3), 30)
  assert.ok(late, ghostNote + '; the outline should arrive once the prover has run the method: ' +
    JSON.stringify(doc.getText().split('\n').slice(oopsLine, oopsLine + 6)))
  const typedLines = doc.getText().split('\n').slice(oopsLine + 3, oopsLine + 5)
  assert.match(typedLines[0], /^ *proof \(induction xs\)$/)
  assert.match(typedLines[1], /^ +case Nil$/)
  pass(`a proof typed and ENTERed at once gets its outline (${Date.now() - t0} ms)`)

  await vscode.commands.executeCommand('workbench.action.files.revert')
  console.log(`${passed} checks passed`)
  console.log('SUITE61_OK')
}

module.exports = { run }
