// Completion end to end, against a PATCHED Isabelle carrying the vscode-completion branch
// of mirror-isabelle: item kinds, templates as snippets, commit characters, no duplicate
// symbol items, and semantic names (facts) that show up right after an edit -- first by
// waiting for the prover, then by filtering the list it already reported. Within inner
// syntax, the names of the context: constants, fixed variables and types.
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
  const target = target_.resolve()
  if (!target) {
    console.log('SKIP: ' + target_.skipReason())
    console.log('SUITE33_SKIPPED')
    return
  }
  console.log(target.label)

  const ext = vscode.extensions.getExtension('yfprojects.vscode-isabelle')
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

  const setProbe = async text => {
    await editor.edit(b => b.replace(doc.lineAt(PROBE).range, text))
    return text.length
  }

  /* Right after an edit the server waits for the prover's report on the word, but only
     vscode_completion_delay long -- 0.5 s, and with the extended server on a stock
     Isabelle that option is not even declared, so it cannot be raised from here. The
     prover re-checking the line took 340 ms on an idle desktop; on a CI runner shared
     with another suite it can take longer, and the list then comes without the facts.
     What is tested is that the server waits: one that did not would answer at once. So
     facts missing after the whole wait means a slow prover, not a fault: wait for its
     report here, so that the checks after this one start where they expect. */
  const DELAY_MS = 500
  async function factsAfterEdit(pos, what) {
    const r = await complete(doc, pos)
    const both = items => named(items, 'foo_bar') && named(items, 'foo_qux')
    if (both(r.items)) return r
    assert.ok(r.ms >= DELAY_MS - 50,
      `${what}: answered in ${r.ms} ms without both facts, so the server did not wait ` +
      `for the prover: ${show(r.items)}`)
    console.log(`${what}: the prover took longer than the server's ${DELAY_MS} ms wait ` +
      `(${r.ms} ms); waiting for its report`)
    const later = await until('the prover to report on the word', 60, async () => {
      const r1 = await complete(doc, pos)
      return both(r1.items) ? r1 : undefined
    })
    assert.ok(later, `${what}: the facts never arrived`)
    return { ...later, ms: r.ms, late: true }
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
  let r = await factsAfterEdit(new vscode.Position(PROBE, col),
    'the keystroke that made the snapshot outdated')
  console.log(`after the edit: ${r.ms} ms, ${r.items.length} items: ` +
    show(r.items))
  pass(r.late ? `the server waited ${r.ms} ms for a slow prover after an edit`
    : `semantic names arrive right after an edit (${r.ms} ms)`)

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
  r = await factsAfterEdit(new vscode.Position(PROBE, col),
    'a shorter word must be asked of the prover again, not filtered from foo_b')
  console.log(`after backspacing to foo: ${r.ms} ms, ${show(r.items)}`)
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

  // ---------- inner syntax: the names of the context ----------
  // Within a term the prover reports names only for a name it rejects; a word being typed
  // is merely a free variable. The server asks for the names visible after the command
  // before the caret's, once, and filters them. A freshly written statement has no
  // language markup until the prover has seen it, so the first answers may lack them.
  async function innerNames(text, word, what) {
    await setProbe(text)
    const pos = new vscode.Position(PROBE, text.lastIndexOf(word) + word.length)
    const found = await until(`${what}: the names of the context`, 60, async () => {
      const r1 = await complete(doc, pos)
      return r1.items.some(i => i.detail && kindName(i) !== 'Text' &&
        kindName(i) !== 'Operator') && !r1.incomplete ? r1 : undefined
    })
    assert.ok(found, `${what}: no names of the context arrived`)
    console.log(`${what}: ${found.ms} ms, ${found.items.length} items: ${show(found.items)}`)
    return { ...found, pos }
  }

  r = await innerNames('lemma "rev (app) = []"', 'app', 'a constant within a term')
  const append = named(r.items, 'append')
  assert.ok(append, `append should be offered for app: ${show(r.items)}`)
  assert.strictEqual(kindName(append), 'Constant', 'a constant should have kind Constant')
  assert.ok(append.detail.includes('List.append'), `the detail names it in full: ${append.detail}`)
  pass('constants are completed within a term, with kind Constant')

  // Once there, the names of that context need no prover: another letter is answered at
  // once, from the same list, and VS Code may filter the list by itself.
  await editor.edit(b => b.insert(r.pos, 'e'))
  const r2 = await complete(doc, r.pos.translate(0, 1))
  assert.ok(named(r2.items, 'append'), `append should still be offered for appe: ${show(r2.items)}`)
  assert.ok(!r2.incomplete, 'a complete list of the context lets VS Code filter it')
  assert.ok(r2.ms < 400, `the names of a known context come without waiting (${r2.ms} ms)`)
  pass(`the names of a known context are answered at once (${r2.ms} ms)`)

  // A qualified form picks a name whose base name is ambiguous (PosReal.ppos next to
  // PosRat.ppos): offered when the word begins it, and after the qualifier and a dot.
  r = await innerNames('lemma "rev (Lis) = []"', 'Lis', 'the start of a qualified name')
  assert.ok(named(r.items, 'List.append'),
    `List.append should be offered for Lis: ${show(r.items)}`)
  pass('a qualified form is offered when the word begins it')

  r = await innerNames('lemma "rev (List.) = []"', 'List.', 'a qualifier and a dot')
  assert.ok(named(r.items, 'List.append'),
    `List.append should be offered after List.: ${show(r.items)}`)
  assert.ok(r.items.filter(i => i.detail && kindName(i) === 'Constant')
    .every(i => label(i).startsWith('List.')),
    `after List. only names under it: ${show(r.items)}`)
  pass('after a qualifier and a dot, the names under it')

  // The parameters of class instances are internal: one writes the class's constant.
  r = await innerNames('lemma "plus = x"', 'plus', 'names without instance parameters')
  assert.ok(!r.items.some(i => label(i).includes('_inst.')),
    `no instance parameters: ${show(r.items)}`)
  pass('the parameters of class instances are not offered')

  // Nor from the prover's own report, which lists them among the constants for a name it
  // rejects -- here one ending in "_", which it takes for an internal name.
  r = await innerNames('lemma "plus_ = x"', 'plus_', "the prover's own report")
  assert.ok(r.items.some(i => i.detail && kindName(i) === 'Constant'),
    `the prover's report should still be there: ${show(r.items)}`)
  assert.ok(!r.items.some(i => label(i).includes('_inst.')),
    `no instance parameters in the prover's report: ${show(r.items)}`)
  pass("the prover's own report leaves out the parameters of class instances")

  r = await innerNames(
    'lemma "True" proof - fix zeta_var :: nat have "zeta_v = 0" sorry',
    'zeta_v', 'a fixed variable')
  const zeta = named(r.items, 'zeta_var')
  assert.ok(zeta, `zeta_var, fixed by the command before, should be offered: ${show(r.items)}`)
  assert.strictEqual(kindName(zeta), 'Variable', 'a fixed variable should have kind Variable')
  pass('fixed variables are completed, with kind Variable')

  r = await innerNames('typ "nat li"', 'li', 'a type')
  const list = named(r.items, 'list')
  assert.ok(list, `the type list should be offered for li: ${show(r.items)}`)
  assert.strictEqual(kindName(list), 'Struct', 'a type name should have kind Struct')
  assert.ok(!r.items.some(i => i.detail && kindName(i) === 'Constant'),
    `a type offers no constants: ${show(r.items)}`)
  pass('within a type, only type names are offered')

  // Text is not inner syntax: its words are no names of the context.
  col = await setProbe('text \\<open>app\\<close>')
  await wait(2000)
  r = await complete(doc, new vscode.Position(PROBE, 'text \\<open>app'.length))
  assert.ok(!r.items.some(i => i.detail && kindName(i) === 'Constant'),
    `text should offer no constants: ${show(r.items)}`)
  pass('text offers no constants')

  await setProbe('')
  await doc.save()

  console.log(`\n${passed} checks passed`)
  console.log('SUITE33_OK')
}

module.exports = { run }
