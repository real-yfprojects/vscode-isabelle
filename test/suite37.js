// Indentation end to end: the extended server's onTypeFormatting and rangeFormatting,
// which port Isabelle/jEdit's indentation rule (Text_Structure.Indent_Rule).
//
// Each case asks the provider directly and checks the edits it returns, since that is
// what the server decides; the last one types into the editor, to show the edits are
// applied at all -- VS Code only asks while editor.formatOnType is on, which this
// extension turns on for Isabelle by default.
//
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

async function until(what, seconds, probe, interval = 2000) {
  const deadline = Date.now() + seconds * 1000
  while (Date.now() < deadline) {
    const value = await probe()
    if (value) return value
    console.log(`  ...${what} (${Math.round((deadline - Date.now()) / 1000)}s left)`)
    await wait(interval)
  }
  return undefined
}

const OPTIONS = { tabSize: 2, insertSpaces: true }

const onType = (doc, line, column, ch) =>
  vscode.commands.executeCommand('vscode.executeFormatOnTypeProvider',
    doc.uri, new vscode.Position(line, column), ch, OPTIONS).then(edits => edits || [])

const onRange = (doc, first, last) =>
  vscode.commands.executeCommand('vscode.executeFormatRangeProvider',
    doc.uri, new vscode.Range(first, 0, last, doc.lineAt(last).text.length), OPTIONS)
    .then(edits => edits || [])

/** The document's lines as they would be with `edits` applied. */
function applied(doc, edits) {
  let text = doc.getText()
  const at = p => doc.offsetAt(p)
  for (const e of [...edits].sort((a, b) => at(b.range.start) - at(a.range.start))) {
    text = text.slice(0, at(e.range.start)) + e.newText + text.slice(at(e.range.end))
  }
  return text.split('\n')
}

const show = edits => JSON.stringify(edits.map(e =>
  [e.range.start.line, e.range.start.character, e.range.end.character, e.newText]))

const indentOf = line => line.length - line.trimStart().length

/* The fixture. Blank lines stand for the line ENTER has just opened, with the caret on
   it; each is found through the line before it, so the cases can move freely. */
const LINES = [
  'theory Indent',
  '  imports Main',
  'begin',
  '',
  'lemma a: "A \\<Longrightarrow> A"',
  '',
  '  by assumption',
  '',
  'lemma b: "A \\<longrightarrow> A"',
  'proof',
  '',
  '  assume A',
  '  then show A .',
  '    qed',
  '',
  'lemma c: "A \\<and> B \\<Longrightarrow> B \\<and> A"',
  '  apply (rule conjI)',
  '  apply (erule conjE)',
  '  apply assumption',
  '  apply (erule conjE)',
  '  apply assumption',
  '  done',
  '',
  '    lemma d: "True"',
  '  by simp',
  '',
  'lemma e:',
  '  "A \\<and>',
  '  ',
  '   B \\<longrightarrow> A"',
  '  by simp',
  '',
  'lemma g: "A \\<longrightarrow> A"',
  '    proof',
  'assume A',
  '      then show A .',
  '  qed',
  '',
  'lemma h: "A \\<longrightarrow> A"',
  'proof',
  '  assume A',
  '  show A',
  '    by (simp add:',
  '',
  '      conj_commute)',
  'qed',
  '',
  'lemma i: "A \\<longrightarrow> A"',
  'proof',
  '',
  'end',
  '',
]
const line = text => {
  const i = LINES.indexOf(text)
  assert.ok(i >= 0 && LINES.indexOf(text, i + 1) < 0, `fixture line not unique: ${text}`)
  return i
}

async function run() {
  const target = target_.resolve()
  if (!target) {
    console.log('SKIP: ' + target_.skipReason())
    console.log('SUITE37_SKIPPED')
    return
  }
  console.log(target.label)

  const ext = vscode.extensions.getExtension('yfprojects.vscode-isabelle')
  await ext.activate()

  const ws = vscode.workspace.workspaceFolders[0].uri.fsPath
  const file = path.join(ws, 'Indent.thy')
  fs.writeFileSync(file, LINES.join('\n'), 'utf8')

  await target_.apply(target)
  await vscode.commands.executeCommand('isabelle.restartServer')

  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file))
  const editor = await vscode.window.showTextDocument(doc, { preview: false })

  const server = await until('restarting against the patched build', 240, async () => {
    const s = await vscode.commands.executeCommand('isabelle.serverState')
    return s && s.state === 'Running' ? s : undefined
  })
  assert.ok(server, 'the patched Isabelle should start')
  assert.ok(target_.matches(server, target), 'must be talking to the patched build')
  pass('language server runs against the patched build')

  // The providers only exist once the server has said it has them.
  const first = await until('the server to answer onTypeFormatting', 60, async () => {
    const edits = await onType(doc, line('lemma a: "A \\<Longrightarrow> A"') + 1, 0, '\n')
    return edits.length > 0 ? edits : undefined
  })
  assert.ok(first, 'ENTER after a lemma statement should produce an edit')

  // ENTER after a statement: the new line goes where a proof command would.
  let n = line('lemma a: "A \\<Longrightarrow> A"') + 1
  let edits = await onType(doc, n, 0, '\n')
  assert.deepStrictEqual(applied(doc, edits)[n], '  ', `after lemma: ${show(edits)}`)
  assert.strictEqual(edits.length, 1, `only the new line changes: ${show(edits)}`)
  pass('ENTER after a lemma statement indents the new line by 2')

  n = line('lemma b: "A \\<longrightarrow> A"') + 2
  edits = await onType(doc, n, 0, '\n')
  assert.deepStrictEqual(applied(doc, edits)[n], '  ', `after proof: ${show(edits)}`)
  pass('ENTER after proof indents the new line into the proof')

  // ENTER after a keyword re-indents the line left behind, and a blank line after the
  // closing qed goes back to 0 -- not to a continuation of the qed.
  n = line('    qed') + 1
  edits = await onType(doc, n, 0, '\n')
  let after = applied(doc, edits)
  assert.strictEqual(after[n - 1], 'qed', `qed should align with proof: ${show(edits)}`)
  assert.strictEqual(after[n], '', `nothing to indent after the final qed: ${show(edits)}`)
  pass('ENTER after an over-indented qed aligns it with its proof, and the next line is at 0')

  // A space after a keyword at the start of a line, as jEdit does on input.
  n = line('    lemma d: "True"')
  edits = await onType(doc, n, 10, ' ')
  after = applied(doc, edits)
  assert.strictEqual(after[n], 'lemma d: "True"', `lemma belongs at 0: ${show(edits)}`)
  assert.strictEqual(edits.length, 1, `only that line changes: ${show(edits)}`)
  pass('a space after lemma moves it to column 0')

  n = line('lemma c: "A \\<and> B \\<Longrightarrow> B \\<and> A"')
  edits = await onType(doc, n, 12, ' ')
  assert.deepStrictEqual(edits, [], `a space inside a term changes nothing: ${show(edits)}`)
  pass('a space that does not follow a leading keyword changes nothing')

  // Inside a string that spans lines, the line keeps what the editor gave it.
  n = line('  "A \\<and>') + 1
  edits = await onType(doc, n, 2, '\n')
  assert.deepStrictEqual(edits, [], `inside a string: ${show(edits)}`)
  pass('ENTER inside a multi-line string leaves the indentation alone')

  // Within open brackets, the blank line continues the line before.
  n = line('    by (simp add:') + 1
  edits = await onType(doc, n, 0, '\n')
  after = applied(doc, edits)
  assert.ok(indentOf(after[n]) > 4 && after[n].trim() === '',
    `inside an open bracket, deeper than the by: ${show(edits)}`)
  pass(`ENTER inside an open bracket continues it (at ${indentOf(after[n])})`)

  // Format Selection re-indents a structured proof, each line after the ones before it.
  const g = line('lemma g: "A \\<longrightarrow> A"')
  edits = await onRange(doc, g, g + 4)
  after = applied(doc, edits)
  assert.deepStrictEqual(after.slice(g, g + 5), [
    'lemma g: "A \\<longrightarrow> A"',
    'proof',
    '  assume A',
    '  then show A .',
    'qed',
  ], `range formatting: ${show(edits)}`)
  pass('Format Selection re-indents a mis-indented proof')

  // Semantic indentation: apply is indented by the number of subgoals, once the prover
  // has reported it for the checked commands.
  const c = line('lemma c: "A \\<and> B \\<Longrightarrow> B \\<and> A"')
  const script = await until('the prover to report subgoals for lemma c', 180, async () => {
    const lines = applied(doc, await onRange(doc, c, c + 6)).slice(c, c + 7)
    return indentOf(lines[2]) === 3 ? lines : undefined
  }, 4000)
  assert.ok(script, 'apply after rule conjI (2 subgoals) should get one more space')
  assert.deepStrictEqual(script.map(indentOf), [0, 2, 3, 3, 2, 2, 2],
    `script indentation: ${JSON.stringify(script)}`)
  pass('apply lines are indented by the number of subgoals')

  // Typing: the edits above are also what the editor applies.
  const i = line('lemma i: "A \\<longrightarrow> A"') + 1
  const around = () => JSON.stringify(
    [doc.lineCount, doc.lineAt(i).text, doc.lineAt(i + 1).text, doc.lineAt(i + 2).text])
  await vscode.window.showTextDocument(doc, { preview: false })
  const linesBefore = doc.lineCount
  editor.selection = new vscode.Selection(i, 5, i, 5)
  await vscode.commands.executeCommand('type', { text: '\n' })
  assert.strictEqual(doc.lineCount, linesBefore + 1, `ENTER should add a line: ${around()}`)
  const typed = await until('the new line after proof to be indented', 15,
    async () => doc.lineAt(i + 1).text === '  ' || undefined, 500)
  if (!typed) {
    const direct = await onType(doc, i + 1, doc.lineAt(i + 1).text.length, '\n')
    assert.fail(`typing ENTER after proof: ${around()}; asked directly: ${show(direct)}`)
  }
  await vscode.commands.executeCommand('type', { text: 'qed' })
  await vscode.commands.executeCommand('hideSuggestWidget')
  await wait(300)
  await vscode.commands.executeCommand('type', { text: '\n' })
  const closed = await until('qed to move back to 0', 15,
    async () => doc.lineAt(i + 1).text === 'qed' || undefined, 500)
  assert.ok(closed, `typing qed and ENTER: ${JSON.stringify(doc.lineAt(i + 1).text)}`)
  assert.strictEqual(doc.lineAt(i + 2).text, '', 'and the line after it starts at 0')
  pass('typed ENTER indents, and typed qed + ENTER outdents: formatOnType is on')

  // The cost: every request scans the theory from the top to the line in question.
  const big = path.join(ws, 'Indent_Big.thy')
  const body = ['theory Indent_Big', '  imports Main', 'begin', '']
  for (let k = 0; k < 1000; k++) body.push(`lemma big_${k}: "True"`, '  by (rule TrueI)', '')
  body.push('lemma last: "True"', '', 'end', '')
  fs.writeFileSync(big, body.join('\n'), 'utf8')
  const bigDoc = await vscode.workspace.openTextDocument(vscode.Uri.file(big))
  await vscode.window.showTextDocument(bigDoc, { preview: false })
  const last = body.indexOf('lemma last: "True"') + 1
  await until('the server to know the large theory', 60,
    async () => (await onType(bigDoc, last, 0, '\n')).length > 0 || undefined)
  const times = []
  for (let k = 0; k < 5; k++) {
    const t0 = Date.now()
    await onType(bigDoc, last, 0, '\n')
    times.push(Date.now() - t0)
  }
  console.log(`ENTER at line ${last} of ${body.length}: ${JSON.stringify(times)} ms`)
  assert.ok(Math.min(...times) < 1000, `indenting near the end of a large theory: ${times}`)
  pass(`a request near the end of a ${body.length}-line theory takes ${Math.min(...times)} ms`)

  await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor')
  await vscode.window.showTextDocument(doc, { preview: false })
  await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor')

  console.log(`\n${passed} checks passed`)
  console.log('SUITE37_OK')
}

module.exports = { run }
