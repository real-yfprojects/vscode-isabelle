// Completion end to end, against a PATCHED Isabelle carrying the vscode-completion branch
// of mirror-isabelle: item kinds, templates as snippets, commit characters, no duplicate
// symbol items, and semantic names (facts) that show up right after an edit -- first by
// waiting for the prover, then by filtering the list it already reported.
// Point ISABELLE_PATCHED_HOME at such a build; the suite skips itself otherwise.
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
    await wait(2000)
  }
  return undefined
}

const label = item => typeof item.label === 'string' ? item.label : item.label.label
const insert = item =>
  item.insertText instanceof vscode.SnippetString ? item.insertText.value
  : item.insertText ?? label(item)
const kindName = item => vscode.CompletionItemKind[item.kind]
// VS Code's word-based suggestions list every word of the document too, without a detail.
const named = (items, l) => items.find(i => label(i) === l && i.detail)
const show = items => JSON.stringify(items.filter(i => i.detail).map(i => `${label(i)}:${kindName(i)}`).slice(0, 12))

async function complete(doc, pos) {
  const t0 = Date.now()
  const list = await vscode.commands.executeCommand(
    'vscode.executeCompletionItemProvider', doc.uri, pos)
  return { items: list ? list.items : [], incomplete: !!(list && list.isIncomplete),
           ms: Date.now() - t0 }
}

const PROBE = 8   // the blank line the probes are written into

async function run() {
  const home = process.env.ISABELLE_PATCHED_HOME
  if (!home) {
    console.log('SKIP: no patched Isabelle (set ISABELLE_PATCHED_HOME)')
    console.log('SUITE33_SKIPPED')
    return
  }
  console.log('patched Isabelle: ' + home)

  const ext = vscode.extensions.getExtension('spike.isabelle-pide-stock')
  await ext.activate()

  const ws = vscode.workspace.workspaceFolders[0].uri.fsPath
  const file = path.join(ws, 'Compl.thy')
  fs.writeFileSync(file, [
    'theory Compl',
    '  imports Main',
    'begin',
    '',
    'lemma foo_bar: "True" by simp',
    'lemma foo_qux: "True" by simp',
    'lemma foo_set_mono: "True" by simp',
    'lemma "True" using foo_ by simp',
    '',
    '',
    'end',
    '',
  ].join('\n'), 'utf8')

  const cfg = vscode.workspace.getConfiguration('isabelle')
  await cfg.update('home', home, vscode.ConfigurationTarget.Global)
  await vscode.commands.executeCommand('isabelle.restartServer')

  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file))
  const editor = await vscode.window.showTextDocument(doc, { preview: false })

  const server = await until('restarting against the patched build', 240, async () => {
    const s = await vscode.commands.executeCommand('isabelle.serverState')
    return s && s.state === 'Running' ? s : undefined
  })
  assert.ok(server, 'the patched Isabelle should start')
  assert.strictEqual(server.isabelleHome, home, 'must be talking to the patched build')
  pass('language server runs against the patched build')

  const setProbe = async text => {
    await editor.edit(b => b.replace(doc.lineAt(PROBE).range, text))
    return text.length
  }

  // ---------- semantic completion on a checked theory ----------
  editor.selection = new vscode.Selection(7, 0, 7, 0)
  const warmCol = 'lemma "True" using foo_'.length
  const warm = await until('waiting for the prover to report on foo_', 300, async () => {
    const { items } = await complete(doc, new vscode.Position(7, warmCol))
    return named(items, 'foo_bar') ? items : undefined
  })
  assert.ok(warm, 'foo_bar should be offered once the theory is checked')
  const warmBar = named(warm, 'foo_bar')
  assert.strictEqual(kindName(warmBar), 'Reference', 'a fact should have kind Reference')
  assert.ok(named(warm, 'foo_qux'), 'foo_qux should be offered too')
  pass('facts are completed, with kind Reference')

  // ---------- right after an edit: the server waits for the prover ----------
  editor.selection = new vscode.Selection(PROBE, 0, PROBE, 0)
  await wait(1000)
  const text = 'lemma "True" using foo_'
  await setProbe(text + ' by simp')
  let col = text.length
  let r = await complete(doc, new vscode.Position(PROBE, col))
  console.log(`after the edit: ${r.ms} ms, ${r.items.length} items: ` +
    show(r.items))
  assert.ok(named(r.items, 'foo_bar') && named(r.items, 'foo_qux'),
    'both facts should be offered on the keystroke that made the snapshot outdated')
  pass(`semantic names arrive right after an edit (${r.ms} ms)`)

  // ---------- one more letter: filtered from the list already reported ----------
  await editor.edit(b => b.insert(new vscode.Position(PROBE, col), 'b'))
  col += 1
  r = await complete(doc, new vscode.Position(PROBE, col))
  console.log(`after 'b': ${r.ms} ms, ${show(r.items)}`)
  const bar = named(r.items, 'foo_bar')
  assert.ok(bar, 'foo_bar should still be offered for foo_b')
  // The whole list comes back: VS Code narrows it down itself, fuzzily.
  assert.ok(named(r.items, 'foo_qux'), 'the list is not narrowed on the server')
  assert.ok(!r.incomplete, 'a complete list lets VS Code filter instead of asking again')
  assert.ok(r.ms < 400, `the extended word should be answered without waiting (${r.ms} ms)`)
  pass(`an extended word is answered from the earlier report (${r.ms} ms)`)

  // Not unique: the name is also offered qualified, as Compl.foo_bar.
  assert.ok(!bar.commitCharacters, 'an ambiguous result must not commit on typing')

  // ---------- backspace: the earlier report no longer covers the word ----------
  await editor.edit(b => b.delete(new vscode.Range(PROBE, col - 2, PROBE, col)))
  col -= 2
  r = await complete(doc, new vscode.Position(PROBE, col))
  console.log(`after backspacing to foo: ${r.ms} ms, ${show(r.items)}`)
  assert.ok(named(r.items, 'foo_bar') && named(r.items, 'foo_qux'),
    'a shorter word must be asked of the prover again, not filtered from foo_b')
  pass('a shortened word goes back to the prover')

  // ---------- fuzzy: the list for foo still serves fooMono ----------
  await editor.edit(b => b.insert(new vscode.Position(PROBE, col), 'Mono'))
  col += 4
  r = await complete(doc, new vscode.Position(PROBE, col))
  console.log(`after fooMono: ${r.ms} ms, incomplete=${r.incomplete}, ${show(r.items)}`)
  assert.ok(named(r.items, 'foo_set_mono'),
    'fooMono is no prefix of foo_set_mono, but VS Code matches it fuzzily -- it needs the name')
  assert.ok(!r.incomplete && r.ms < 400, 'answered at once from the complete list for foo')
  pass(`a non-prefix word keeps the names VS Code filters fuzzily (${r.ms} ms)`)

  // ---------- keywords ----------
  col = await setProbe('lemm')
  r = await complete(doc, new vscode.Position(PROBE, col))
  const lemma = named(r.items, 'lemma')
  assert.ok(lemma, 'lemma should be offered for lemm')
  assert.strictEqual(kindName(lemma), 'Keyword')
  pass('outer keywords have kind Keyword')

  // ---------- templates ----------
  col = await setProbe('text "')
  r = await complete(doc, new vscode.Position(PROBE, col))
  const template = r.items.find(i => i.insertText instanceof vscode.SnippetString)
  console.log('template items: ' + JSON.stringify(r.items.map(i => [label(i), insert(i)])))
  assert.ok(template, 'the cartouche template should be a snippet')
  assert.strictEqual(template.insertText.value, '\\\\<open>$0\\\\<close>',
    'the caret goes between the delimiters, and backslashes are escaped for the snippet')
  pass('templates are snippets with the caret inside')

  // ---------- symbols: one item each ----------
  col = await setProbe('\\fora')
  r = await complete(doc, new vscode.Position(PROBE, col))
  const foralls = r.items.filter(i => insert(i) === '\\<forall>')
  console.log(`\\fora: ${JSON.stringify(r.items.map(i => [label(i), kindName(i)]).slice(0, 8))}`)
  assert.strictEqual(foralls.length, 1, 'the server and the client should not both list \\<forall>')
  assert.strictEqual(kindName(foralls[0]), 'Operator', 'a symbol is not a plain word (abc icon)')
  pass('a \\name symbol is listed once')

  col = await setProbe('A ==>')
  r = await complete(doc, new vscode.Position(PROBE, col))
  const arrow = r.items.find(i => insert(i) === '\\<Longrightarrow>')
  assert.ok(arrow, 'the server should complete the ASCII abbrev ==>')
  assert.strictEqual(kindName(arrow), 'Operator')
  pass('symbols reached through an ASCII abbrev stay, with kind Operator')

  // The one unique, immediate result here: it commits on the next character typed, as
  // jEdit inserts it at once -- but never on a word character, which would still be
  // typing a name when the unique item is a semantic one.
  assert.ok(arrow.commitCharacters && arrow.commitCharacters.includes(' '),
    'a unique immediate item should commit on space')
  assert.ok(!arrow.commitCharacters.some(c => /[A-Za-z0-9_'.]/.test(c)),
    `word characters must not commit: ${arrow.commitCharacters.join('')}`)
  pass('a unique item commits on punctuation, never on a word character')

  await setProbe('')
  await doc.save()

  console.log(`\n${passed} checks passed`)
  console.log('SUITE33_OK')
}

module.exports = { run }
