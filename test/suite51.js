// Find references, end to end: textDocument/references on the extended server
// (vscode_entities.scala on the release branch), through VS Code's own reference command.
//
// The server finds occurrences by the serial of their entity markup, the same identity
// document highlights use, but across every loaded node rather than the one file. So this
// checks what a name-based search would get wrong: uses in an importing theory are found
// from the definition and the other way round, a fixed variable named like the constant is
// a different entity, and an entity of the session image is declared in its source file,
// which no loaded node contains. And one it would get right by accident: the defining
// equation's name is a different entity bound at the same place, which belongs to the set
// (renaming the constant has to change it). On the stock server there is no provider.
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

async function until(what, seconds, probe, interval = 3000) {
  const deadline = Date.now() + seconds * 1000
  while (Date.now() < deadline) {
    const value = await probe()
    if (value) return value
    console.log(`  ...${what} (${Math.round((deadline - Date.now()) / 1000)}s left)`)
    await wait(interval)
  }
  return undefined
}

const A = [
  'theory Refs_A',
  '  imports Main',
  'begin',
  '',
  'definition double :: "nat \\<Rightarrow> nat" where',
  '  "double n = n + n"',
  '',
  'lemma double_add: "double (m + n) = double m + double n"',
  '  unfolding double_def by simp',
  '',
  'end',
]

const B = [
  'theory Refs_B',
  '  imports Refs_A',
  'begin',
  '',
  'lemma double_suc: "double (Suc 0) = 2"',
  '  unfolding double_def by simp',
  '',
  'lemma "double (a + b) = double a + double b"',
  '  by (rule double_add)',
  '',
  'lemma fixes double :: nat shows "double = double"',
  '  by (rule refl)',
  '',
  'end',
]

/** The position of the nth `needle` on the line of `lines` starting with `prefix`. */
function at(lines, prefix, needle, nth = 0) {
  const line = lines.findIndex(l => l.startsWith(prefix))
  assert.ok(line >= 0, `no line starting with ${prefix}`)
  let char = -1
  for (let k = 0; k <= nth; k++) char = lines[line].indexOf(needle, char + 1)
  assert.ok(char >= 0, `${needle} not on line ${line}`)
  return new vscode.Position(line, char)
}

const references = (uri, pos) =>
  vscode.commands.executeCommand('vscode.executeReferenceProvider', uri, pos)

const show = locs => locs.map(l =>
  `${path.basename(l.uri.fsPath)}:${l.range.start.line}:${l.range.start.character}` +
  `-${l.range.end.character}`).sort()

/** Whether `locs` has exactly the expected occurrences of `needle`, each a whole word. */
function assertOccurrences(locs, expected, needle, what) {
  const key = (file, pos) => `${path.basename(file)}:${pos.line}:${pos.character}` +
    `-${pos.character + needle.length}`
  assert.deepStrictEqual(show(locs), expected.map(([file, pos]) => key(file, pos)).sort(), what)
}

async function run() {
  const target = target_.resolve()
  if (!target) {
    console.log('SKIP: ' + target_.skipReason())
    console.log('SUITE51_SKIPPED')
    return
  }
  console.log(target.label)

  const ext = vscode.extensions.getExtension('yfprojects.vscode-isabelle')
  await ext.activate()

  const ws = vscode.workspace.workspaceFolders[0].uri.fsPath
  const fileA = path.join(ws, 'Refs_A.thy')
  const fileB = path.join(ws, 'Refs_B.thy')
  fs.writeFileSync(fileA, A.join('\n') + '\n', 'utf8')
  fs.writeFileSync(fileB, B.join('\n') + '\n', 'utf8')
  const uriA = vscode.Uri.file(fileA), uriB = vscode.Uri.file(fileB)

  await target_.apply(target)
  await vscode.commands.executeCommand('isabelle.restartServer')

  const docA = await vscode.workspace.openTextDocument(uriA)
  await vscode.window.showTextDocument(docA, { preview: false })
  const docB = await vscode.workspace.openTextDocument(uriB)
  await vscode.window.showTextDocument(docB, { preview: false })

  const server = await until('restarting against the extended server', 240, async () => {
    const s = await vscode.commands.executeCommand('isabelle.serverState')
    return s && s.state === 'Running' ? s : undefined
  })
  assert.ok(server, 'the server should start')
  assert.ok(target_.matches(server, target), 'must be talking to the extended server')
  pass('language server runs against the extended server')

  // The constant, everywhere it is used: from a use in the importing theory. Checked once
  // the whole of Refs_B has been, so that every occurrence has its markup.
  const useB = at(B, 'lemma double_suc', 'double', 1)  /*0 is within the fact's name*/
  const expectedDouble = [
    [fileA, at(A, 'definition double', 'double')],
    [fileA, at(A, '  "double n', 'double')],
    [fileA, at(A, 'lemma double_add', 'double', 1)],
    [fileA, at(A, 'lemma double_add', 'double', 2)],
    [fileA, at(A, 'lemma double_add', 'double', 3)],
    [fileB, useB],
    [fileB, at(B, 'lemma "double', 'double', 0)],
    [fileB, at(B, 'lemma "double', 'double', 1)],
    [fileB, at(B, 'lemma "double', 'double', 2)],
  ]
  const fromUse = await until('both theories to be checked', 240, async () => {
    const locs = await references(uriB, useB)
    return locs && locs.length >= expectedDouble.length ? locs : undefined
  })
  assert.ok(fromUse, `references should arrive: ${show(await references(uriB, useB) || [])}`)
  console.log('references of double: ' + show(fromUse).join(', '))
  assertOccurrences(fromUse, expectedDouble, 'double',
    'the definition and every use of double, in both theories, and nothing else')
  pass('from a use: the definition in the imported theory and the uses in both')

  // The same set from the definition, which finds uses in a theory that imports it.
  assertOccurrences(await references(uriA, at(A, 'definition double', 'double')),
    expectedDouble, 'double', 'the definition should find the same occurrences')
  pass('from the definition: the same occurrences, the importing theory included')

  // The defining equation names a fixed variable of the specification, bound at the very
  // same name as the constant: one name, so one set of occurrences from any of them.
  assertOccurrences(await references(uriA, at(A, '  "double n', 'double')),
    expectedDouble, 'double', 'the defining equation should find the same occurrences')
  pass('from the defining equation: the same occurrences')

  // VS Code asks with the caret where it is; just after a word, that is the word's end.
  const end = useB.translate(0, 'double'.length)
  assertOccurrences(await references(uriB, end), expectedDouble, 'double',
    'the caret at the end of the word should count as on it')
  pass('the caret just after a name finds the name')

  // A fixed variable spelled like the constant is another entity, and so is the fact
  // whose name merely starts with it.
  const fixed = await references(uriB, at(B, 'lemma fixes double', 'double'))
  assertOccurrences(fixed, [
    [fileB, at(B, 'lemma fixes double', 'double', 0)],
    [fileB, at(B, 'lemma fixes double', 'double', 1)],
    [fileB, at(B, 'lemma fixes double', 'double', 2)],
  ], 'double', 'only the fixed variable, not the constant of the same name')
  pass('a fixed variable named like the constant: only its own occurrences')

  // A fact, by its name in a proof.
  const fact = await references(uriB, at(B, '  by (rule double_add', 'double_add'))
  assertOccurrences(fact, [
    [fileA, at(A, 'lemma double_add', 'double_add')],
    [fileB, at(B, '  by (rule double_add', 'double_add')],
  ], 'double_add', 'the lemma and its use')
  pass('a fact: its statement in the imported theory and its use')

  // A constant of the session image is bound in no loaded node: its declaration is its
  // source in the distribution, beside the use here.
  const suc = await references(uriB, at(B, 'lemma double_suc', 'Suc'))
  console.log('references of Suc: ' + show(suc).join(', '))
  const external = suc.filter(l => !l.uri.fsPath.startsWith(ws))
  assert.strictEqual(external.length, 1, 'one declaration outside the workspace')
  assert.ok(/\.thy$/.test(external[0].uri.fsPath) && fs.existsSync(external[0].uri.fsPath),
    `the declaration should be a theory file that exists: ${external[0].uri.fsPath}`)
  const declared = fs.readFileSync(external[0].uri.fsPath, 'utf8').split(/\r?\n/)[
    external[0].range.start.line]
  assert.ok(declared && declared.includes('Suc'), `the declaration's line names Suc: ${declared}`)
  assert.ok(suc.some(l => l.uri.fsPath === fileB && l.range.start.isEqual(
    at(B, 'lemma double_suc', 'Suc'))), 'the use in Refs_B is listed')
  pass(`an entity of the image: declared in ${path.basename(external[0].uri.fsPath)}, used here`)

  if (target.extended) {
    await target_.reset(target)
    await vscode.commands.executeCommand('isabelle.restartServer')
    const plain = await until('the stock server', 240, async () => {
      const s = await vscode.commands.executeCommand('isabelle.serverState')
      return s && s.state === 'Running' && !s.extendedJar ? s : undefined
    })
    assert.ok(plain, 'the stock server should start')
    const none = await references(uriB, useB)
    assert.strictEqual((none || []).length, 0, 'a stock server provides no references')
    pass('the stock server provides no references')
  } else {
    await target_.reset(target)
  }

  await vscode.commands.executeCommand('workbench.action.closeAllEditors')
  fs.rmSync(fileA, { force: true })
  fs.rmSync(fileB, { force: true })

  console.log(`\n${passed} checks passed`)
  console.log('SUITE51_OK')
}

module.exports = { run }
