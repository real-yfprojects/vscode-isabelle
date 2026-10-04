// Completion previews of the extended server: the item VS Code shows says what its name
// stands for -- the statement of a fact, the type of a constant or a fixed variable -- as
// its detail, on one line, and laid out as its documentation when it takes more (a fact of
// several theorems). VS Code asks for it (completionItem/resolve) as it shows an item; the
// server asks the prover in the context the names come from, as a hover does.
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
const kindName = item => vscode.CompletionItemKind[item.kind]
const docText = item => {
  const d = item.documentation
  const s = d === undefined ? '' : typeof d === 'string' ? d : d.value
  return s.replace(/<[^>]*>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&amp;/g, '&')
}
// Symbols come as Unicode or as \<name>, by the user's setting: compare in one spelling.
const ascii = s => s.replace(/⇒/g, '\\<Rightarrow>').replace(/…/g, '\\<dots>')

/* The item named `name` of the list at `pos`, resolved as VS Code resolves the one it
   shows. vscode.executeCompletionItemProvider resolves the first n items of the list, so
   the list is asked twice: for where the item is, then resolved up to it. */
async function resolved(doc, pos, name) {
  const list = await vscode.commands.executeCommand(
    'vscode.executeCompletionItemProvider', doc.uri, pos)
  const items = list ? list.items : []
  const i = items.findIndex(it => label(it) === name && it.detail)
  if (i < 0) return { offered: items.filter(it => it.detail).map(label).slice(0, 12) }
  const list1 = await vscode.commands.executeCommand(
    'vscode.executeCompletionItemProvider', doc.uri, pos, undefined, i + 1)
  const item = (list1 ? list1.items : []).find(it => label(it) === name && it.detail)
  return { item, before: items[i].detail }
}

const PROBE = 18   // the blank line inside the proof that the probes are written into

async function run() {
  const target = target_.resolve()
  if (!target) {
    console.log('SKIP: ' + target_.skipReason())
    console.log('SUITE65_SKIPPED')
    return
  }
  console.log(target.label)

  const ext = vscode.extensions.getExtension('yfprojects.vscode-isabelle')
  await ext.activate()

  const ws = vscode.workspace.workspaceFolders[0].uri.fsPath
  const file = path.join(ws, 'ComplInfo.thy')
  fs.writeFileSync(file, [
    'theory ComplInfo',
    '  imports Main',
    'begin',
    '',
    'definition double :: "nat \\<Rightarrow> nat" where "double n = n + n"',
    '',
    'lemma double_add: "double (a + b) = double a + double b"',
    '  unfolding double_def by simp',
    '',
    'fun cnt :: "nat \\<Rightarrow> nat" where',
    '  "cnt 0 = 0"',
    '| "cnt (Suc n) = cnt n"',
    '',
    'lemma',
    '  fixes width :: nat',
    '  shows "width = width"',
    'proof -',
    '  fix height :: nat',
    '',
    '  show ?thesis by simp',
    'qed',
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

  /* Writes a probe, the caret at its |, and waits until `name` is offered and resolved
     with a preview: the prover has to check the theory first, then report on the word or
     list the names of the context. */
  async function preview(probe, name, what) {
    const text = probe.replace('|', '')
    await editor.edit(b => b.replace(doc.lineAt(PROBE).range, text))
    const pos = new vscode.Position(PROBE, probe.indexOf('|'))
    let last
    const r = await until(`${what}: ${name} with a preview`, 300, async () => {
      last = await resolved(doc, pos, name)
      return last.item && last.item.detail !== last.before ? last : undefined
    })
    assert.ok(r, `${what}: no preview for ${name}: ${JSON.stringify(last)}`)
    console.log(`${what}: ${label(r.item)} [${kindName(r.item)}] ` +
      `${JSON.stringify(r.before)} -> ${JSON.stringify(r.item.detail)}` +
      (r.item.documentation ? `, documentation ${JSON.stringify(docText(r.item))}` : ''))
    return r.item
  }

  // ---------- a fact: its statement, without its name ----------
  let item = await preview('  have "True" using double_ad|', 'double_add', 'a fact')
  assert.strictEqual(kindName(item), 'Reference')
  // as the theorem is: its variables schematic, as `thm double_add` prints them
  assert.strictEqual(item.detail, 'double (?a + ?b) = double ?a + double ?b',
    'the detail is the statement, and the label already names it')
  assert.ok(!item.documentation, 'a statement on one line needs no documentation')
  pass('a fact shows its statement')

  // ---------- several theorems: the first as detail, all laid out below ----------
  item = await preview('  have "True" using cnt.sim|', 'cnt.simps', 'a fact of two theorems')
  assert.strictEqual(ascii(item.detail), 'cnt 0 = 0 \\<dots>',
    'the detail is the first theorem, and says that there are more')
  const shown = docText(item)
  assert.ok(shown.includes('cnt 0 = 0') && shown.includes('cnt (Suc ?n) = cnt ?n'),
    `the documentation lists both theorems: ${JSON.stringify(shown)}`)
  pass('a fact of several theorems lists them all in its documentation')

  // ---------- a constant within a term: its type ----------
  item = await preview('  have "doubl| = width" sorry', 'double', 'a constant')
  assert.strictEqual(kindName(item), 'Constant')
  assert.strictEqual(ascii(item.detail), 'double :: nat \\<Rightarrow> nat')
  pass('a constant shows its type')

  // ---------- fixed variables: of the statement, and of the proof body ----------
  item = await preview('  have "widt| = 0" sorry', 'width', 'a variable fixed by the statement')
  assert.strictEqual(kindName(item), 'Variable')
  assert.strictEqual(item.detail, 'width :: nat')
  // fix in a proof body fixes height as height__, and completion offers it as height
  item = await preview('  have "heigh| = 0" sorry', 'height', 'a variable fixed in the proof')
  assert.strictEqual(item.detail, 'height :: nat')
  pass('fixed variables show their types, also those of a proof body')

  await vscode.commands.executeCommand('workbench.action.files.revert')
  await target_.reset(target)
  console.log(`${passed} checks passed`)
  console.log('SUITE65_OK')
}

module.exports = { run }
