// Code skeletons of the extended server (vscode_skeletons.ML on the vscode-skeletons branch
// of mirror-isabelle): an Isar sketch of a pending goal and subgoal blocks for a proof
// script, from the light bulb only; the rest of an instantiation, also as ghost text; a
// placeholder `sorry` replaced rather than kept; nothing where a proof follows already; and
// the caret after the keyword of a theory block template.
// Runs against a patched Isabelle or against the stock one with the extended server; see
// test/server_target.js. Skips itself when there is neither, so it is safe in any run.
const vscode = require('vscode')
const target_ = require('./server_target')
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
  return ((await vscode.commands.executeCommand('vscode.executeCodeActionProvider',
    doc.uri, new vscode.Range(end, end))) || [])
    .filter(a => a.kind && a.kind.value.includes('.isabelle.'))
}
const kinds = actions => actions.map(a => `${a.title} [${a.kind.value}]`)
const linesFrom = (doc, line, n) => doc.getText().split('\n').slice(line, line + n)

/* Takes the ghost text at the caret: by committing it, as Tab does, while the window has
   focus -- VS Code shows ghost text only in a focused editor, which a test window running
   beside others is not -- and otherwise by asking the provider what it would show
   (isabelle.skeletonProbe) and applying that. A focused window that never shows it fails. */
async function takeGhost(editor, line, done, seconds) {
  const deadline = Date.now() + seconds * 1000
  let unfocused = false
  while (Date.now() < deadline) {
    if (!vscode.window.state.focused) { unfocused = true; break }
    await vscode.commands.executeCommand('editor.action.inlineSuggest.trigger')
    await wait(1000)
    await vscode.commands.executeCommand('editor.action.inlineSuggest.commit')
    await wait(300)
    if (done()) return 'ghost text'
  }
  if (!unfocused) return undefined
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
  return undefined
}

async function run() {
  const target = target_.resolve()
  if (!target) {
    console.log('SKIP: ' + target_.skipReason())
    console.log('SUITE62_SKIPPED')
    return
  }
  console.log(target.label)

  const ext = vscode.extensions.getExtension('yfprojects.vscode-isabelle')
  await ext.activate()

  const ws = vscode.workspace.workspaceFolders[0].uri.fsPath
  const file = path.join(ws, 'Skel.thy')
  fs.writeFileSync(file, [
    'theory Skel',
    '  imports Main',
    'begin',
    '',
    'class foo = fixes foo_op :: "\'a \\<Rightarrow> \'a \\<Rightarrow> \'a" and foo_z :: \'a',
    '  assumes foo_comm: "foo_op x y = foo_op y x"',
    '',
    'lemma conj_swap: "A \\<and> B \\<longrightarrow> B \\<and> A"',
    '  sorry',
    '',
    'lemma three: "A \\<and> B \\<and> C"',
    '  apply (intro conjI)',
    '  sorry',
    '',
    'lemma closed: "A \\<longrightarrow> A"',
    '  by simp',
    '',
    'instantiation nat :: foo',
    'begin',
    '',
    'end',
    '',
    // checked last: once try0 has answered here, the prover is through the theory
    'lemma sentinel: "(n::nat) + 0 = n"',
    '  try0',
    '  oops',
    '',
    'end',
    '',
  ].join('\n'), 'utf8')

  await target_.apply(target)
  await vscode.commands.executeCommand('isabelle.restartServer')
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file))
  const editor = await vscode.window.showTextDocument(doc, { preview: false })

  const server = await until('restarting against the extended server', 240, async () => {
    const s = await vscode.commands.executeCommand('isabelle.serverState')
    return s && s.state === 'Running' ? s : undefined
  })
  assert.ok(server, 'the extended server should start')
  assert.ok(target_.matches(server, target), 'must be talking to the extended server')
  pass('language server runs against the extended server')

  // --- an Isar sketch, in place of the placeholder ------------------------------------------
  const swap = lineOf(doc, 'lemma conj_swap: "A \\<and> B \\<longrightarrow> B \\<and> A"')
  const sketch = await until('the sketch of conj_swap', 180, async () => {
    const a = await actionsAt(doc, swap)
    return a.length ? a : undefined
  })
  assert.ok(sketch, 'a pending goal should have a sketch')
  assert.deepStrictEqual(kinds(sketch), ['Insert Isar sketch [refactor.rewrite.isabelle.suggestion]'])
  assert.ok(await vscode.workspace.applyEdit(sketch[0].edit))
  assert.deepStrictEqual(linesFrom(doc, swap, 7), [
    'lemma conj_swap: "A \\<and> B \\<longrightarrow> B \\<and> A"',
    'proof',
    '  assume "A \\<and> B"',
    '  show "B \\<and> A"',
    '    sorry',
    'qed',
    '',
  ], 'the sketch replaces the sorry')
  pass('a pending goal gets an Isar sketch, which replaces a placeholder sorry')

  // --- subgoal blocks for a proof script -----------------------------------------------------
  const apply = lineOf(doc, '  apply (intro conjI)')
  const blocks = await until('the subgoal skeleton', 120, async () => {
    const a = await actionsAt(doc, apply)
    return a.length ? a : undefined
  })
  assert.ok(blocks, 'a proof script with subgoals should have a skeleton')
  assert.deepStrictEqual(kinds(blocks),
    ['Insert subgoal skeleton (3 subgoals) [refactor.rewrite.isabelle.suggestion]'])
  assert.ok(await vscode.workspace.applyEdit(blocks[0].edit))
  assert.deepStrictEqual(linesFrom(doc, apply, 8), [
    '  apply (intro conjI)',
    '  subgoal',
    '    sorry',
    '  subgoal',
    '    sorry',
    '  subgoal',
    '    sorry',
    '  done',
  ])
  pass('a proof script gets subgoal blocks, at its indentation')

  // --- nothing where a proof follows -------------------------------------------------------------
  const closed = lineOf(doc, 'lemma closed: "A \\<longrightarrow> A"')
  await wait(3000)
  assert.deepStrictEqual(kinds(await actionsAt(doc, closed)), [], 'by simp continues the proof')
  pass('no skeleton for a goal whose proof is written')

  // --- the instantiation, as ghost text ----------------------------------------------------------
  const inst = lineOf(doc, 'instantiation nat :: foo')
  const offered = await until('the instantiation skeleton', 120, async () => {
    const a = await actionsAt(doc, inst + 1)
    return a.length ? a : undefined
  })
  assert.ok(offered, 'an instantiation with nothing defined should have a skeleton')
  assert.deepStrictEqual(kinds(offered),
    ['Insert instantiation skeleton [refactor.rewrite.isabelle.skeleton]'])

  const blank = inst + 2
  assert.strictEqual(doc.lineAt(blank).text, '')
  editor.selection = new vscode.Selection(blank, 0, blank, 0)
  const accepted = await takeGhost(editor, blank,
    () => doc.lineAt(blank).text.startsWith('definition foo_op_nat'), 30)
  assert.ok(accepted, 'the instantiation skeleton should come as ghost text')
  console.log(`instantiation taken from ${accepted}`)
  assert.deepStrictEqual(linesFrom(doc, inst, 16), [
    'instantiation nat :: foo',
    'begin',
    'definition foo_op_nat :: "nat \\<Rightarrow> nat \\<Rightarrow> nat" where',
    '  "foo_op_nat = undefined"',
    '',
    'definition foo_z_nat :: nat where',
    '  "foo_z_nat = undefined"',
    '',
    'instance proof',
    '  fix x :: nat',
    '    and y :: nat',
    '  show "foo_op x y = foo_op y x"',
    '    sorry',
    'qed',
    'end',
    '',
  ])
  pass('an instantiation gets its definitions and instance proof as ghost text')

  // Everything inserted is accepted by the prover: only sorries remain to fill in.
  const errors = () => vscode.languages.getDiagnostics(doc.uri)
    .filter(d => d.severity === vscode.DiagnosticSeverity.Error)
  const through = await until('the prover to get through the theory', 180, async () =>
    (await actionsAt(doc, lineOf(doc, '  try0'))).length > 0)
  assert.ok(through, 'try0 at the end should answer')
  await wait(3000) // proofs run in parallel: let their messages arrive
  assert.deepStrictEqual(errors().map(d => [d.range.start.line, d.message]), [],
    'the skeletons should check')
  pass('the inserted skeletons check without errors')

  // --- theory block templates ---------------------------------------------------------------------
  const probe = doc.lineCount - 1
  await editor.edit(b => b.insert(new vscode.Position(probe, 0), 'instantiatio'))
  const list = await vscode.commands.executeCommand('vscode.executeCompletionItemProvider',
    doc.uri, new vscode.Position(probe, 'instantiatio'.length))
  const item = list.items.find(i =>
    (typeof i.label === 'string' ? i.label : i.label.label).startsWith('instantiation\n'))
  assert.ok(item, 'the instantiation template is offered')
  assert.strictEqual(item.insertText.value, 'instantiation$0\nbegin\n\nend',
    'the caret goes after the keyword, where the arity is written')
  pass('a theory block template puts the caret after its keyword')

  await vscode.commands.executeCommand('workbench.action.files.revert')
  await target_.reset(target)
  console.log(`${passed} checks passed`)
  console.log('SUITE62_OK')
}

module.exports = { run }
