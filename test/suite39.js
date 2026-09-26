// Inner syntax coloured by category, end to end: the extended server's semantic_* markup
// (vscode_rendering.scala on the release branch) arriving as semantic tokens.
//
// Isabelle's own palette colours only the variables of a term; constants, type names,
// classes, operators and numerals are painted like the text around them. The extended
// server sends those categories as well, and src/semantic_tokens.ts maps them onto the
// theme. This checks each one at a known position of a checked theory, that a variable
// keeps its own category, and -- on the stock server -- that none of it arrives while
// the variables still do.
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

const LINES = [
  'theory Semantic',
  '  imports Main',
  'begin',
  '',
  'definition twice :: "nat \\<Rightarrow> nat" where',
  '  "twice n = n + n"',
  '',
  'lemma twice_zero: "twice 0 = 0 \\<and> (x::int) \\<le> x + 2"',
  '  unfolding twice_def by simp',
  '',
  'lemma sorted: "(y::\'a::order) \\<le> y"',
  '  by simp',
  '',
  'end',
]

const summary = () => vscode.commands.executeCommand('isabelle.pideDecorationSummary')

/** The document's semantic tokens, decoded: [{ line, char, length, type }]. */
async function tokens(doc) {
  const legend = await vscode.commands.executeCommand(
    'vscode.provideDocumentSemanticTokensLegend', doc.uri)
  const data = await vscode.commands.executeCommand(
    'vscode.provideDocumentSemanticTokens', doc.uri)
  const out = []
  let line = 0, char = 0
  for (let i = 0; data && i < data.data.length; i += 5) {
    const [dl, dc, length, type] = data.data.slice(i, i + 4)
    line += dl
    char = dl === 0 ? char + dc : dc
    out.push({ line, char, length, type: legend.tokenTypes[type] })
  }
  return out
}

/** The token type at the first character of `needle` on the line starting with `prefix`. */
function typeAt(all, prefix, needle, nth = 0) {
  const line = LINES.findIndex(l => l.startsWith(prefix))
  assert.ok(line >= 0, `no line starting with ${prefix}`)
  let at = -1
  for (let k = 0; k <= nth; k++) at = LINES[line].indexOf(needle, at + 1)
  assert.ok(at >= 0, `${needle} not on line ${line}`)
  const t = all.find(t => t.line === line && t.char <= at && at < t.char + t.length)
  return t && t.type
}

async function run() {
  const target = target_.resolve()
  if (!target) {
    console.log('SKIP: ' + target_.skipReason())
    console.log('SUITE39_SKIPPED')
    return
  }
  console.log(target.label)

  const ext = vscode.extensions.getExtension('yfprojects.vscode-isabelle')
  await ext.activate()

  const ws = vscode.workspace.workspaceFolders[0].uri.fsPath
  const file = path.join(ws, 'Semantic.thy')
  fs.writeFileSync(file, LINES.join('\n') + '\n', 'utf8')

  await target_.apply(target)
  await vscode.commands.executeCommand('isabelle.restartServer')

  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file))
  await vscode.window.showTextDocument(doc, { preview: false })

  const server = await until('restarting against the extended server', 240, async () => {
    const s = await vscode.commands.executeCommand('isabelle.serverState')
    return s && s.state === 'Running' ? s : undefined
  })
  assert.ok(server, 'the server should start')
  assert.ok(target_.matches(server, target), 'must be talking to the extended server')
  pass('language server runs against the extended server')

  // Checked once the last lemma's class has arrived: it is the last category to appear.
  const counts = await until('the theory to be checked', 240, async () => {
    const s = await summary()
    return s && s.semantic_class && s.semantic_constant ? s : undefined
  })
  assert.ok(counts, `semantic markup should arrive: ${JSON.stringify(await summary())}`)
  console.log('semantic markup: ' + JSON.stringify(Object.fromEntries(
    Object.entries(counts).filter(([k]) => k.startsWith('semantic_')))))
  pass('the extended server sends semantic_* markup')

  const all = await until('semantic tokens', 30, async () => {
    const t = await tokens(doc)
    return t.some(x => x.type === 'isabelleConstant') ? t : undefined
  })
  assert.ok(all, 'semantic_* markup should become semantic tokens')
  const expect = (prefix, needle, type, nth) =>
    assert.strictEqual(typeAt(all, prefix, needle, nth), type,
      `${needle} on "${prefix}..." should be ${type}`)

  expect('lemma twice_zero', 'twice', 'isabelleConstant', 1)
  expect('definition twice', 'nat', 'type')
  expect('lemma sorted', 'order', 'class')
  expect('  "twice n', '+', 'operator')
  expect('lemma twice_zero', '=', 'operator')
  // `2` is a numeral token; HOL's `0` is notation for a constant, read as a numeral too.
  expect('lemma twice_zero', '2', 'number')
  expect('lemma twice_zero', '0', 'number')
  expect('lemma twice_zero', 'int', 'type')
  pass('constants, type names, classes, operators and numerals each get their own category')

  // Variables keep Isabelle's own category: semantic_* only fills what text_* leaves.
  expect('lemma twice_zero', 'x', 'variable', 0)
  expect('lemma sorted', "'a", 'typeParameter')
  pass('free variables and type variables keep their own categories')

  if (target.extended) {
    await target_.reset(target)
    await vscode.commands.executeCommand('isabelle.restartServer')
    const plain = await until('the stock server to check the theory', 240, async () => {
      const s = await vscode.commands.executeCommand('isabelle.serverState')
      if (!s || s.state !== 'Running' || s.extendedJar) return undefined
      const m = await summary()
      return m && m.text_free ? m : undefined
    })
    assert.ok(plain, 'the stock server should still colour variables')
    assert.deepStrictEqual(Object.keys(plain).filter(k => k.startsWith('semantic_')), [],
      'a stock server sends no semantic_* markup')
    pass('the stock server sends no semantic_* markup, and variables are still coloured')
  } else {
    await target_.reset(target)
  }

  await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor')

  console.log(`\n${passed} checks passed`)
  console.log('SUITE39_OK')
}

module.exports = { run }
