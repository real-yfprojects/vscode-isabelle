// Hover information, token by token: what the editor shows when the pointer rests on each
// kind of token of a theory -- facts, binding sites, constants, case names, term
// abbreviations, methods and attributes, and the atoms of inner syntax.
//
// Prints the hover text at every probe, so a run documents what each kind of token shows,
// and asserts what the extended server adds on top of the PIDE tooltips. Runs against a
// patched Isabelle or the stock one with the extended server (test/server_target.js), and
// skips itself when there is neither.
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

const THY = [
  'theory HoverInfo',
  '  imports Main',
  'begin',
  '',
  'definition double :: "nat \\<Rightarrow> nat" where',
  '  "double n = n + n"',
  '',
  'lemma double_zero [simp]: "double 0 = 0"',
  '  unfolding double_def by simp',
  '',
  'abbreviation sq :: "nat \\<Rightarrow> nat" where "sq x \\<equiv> x * x"',
  '',
  'lemma sq_two: "sq 2 = 4"',
  '  by simp',
  '',
  'lemma assm_test:',
  '  fixes x :: nat',
  '  assumes pos: "0 < x" and big: "x > 5"',
  '  shows "x \\<noteq> 0"',
  '  using assms(2) by simp',
  '',
  'lemma rev_test: "rev (rev xs) = xs"',
  'proof (induct xs)',
  '  case Nil',
  '  show ?case by simp',
  'next',
  '  case (Cons a ys)',
  '  then show ?case by simp',
  'qed',
  '',
  'lemma let_test: "\\<forall>y::nat. (\\<lambda>z. z + y) 0 = y"',
  'proof -',
  '  let ?t = "\\<lambda>z::nat. z"',
  '  have h: "?t 1 = 1" by simp',
  '  fix u :: nat',
  '  obtain w :: nat where "w = u" by blast',
  '  show ?thesis using h by simp',
  'qed',
  '',
  'schematic_goal sch: "?x = (1::nat)"',
  '  by (rule refl)',
  '',
  'lemma bad_type: "True = (0::nat)"',
  '  oops',
  '',
  'end',
]

/** The position of the nth `needle` on the line of THY starting with `prefix`, as a whole
    token: `x` is not the x of `fixes`. */
function at(prefix, needle, nth = 0) {
  const line = THY.findIndex(l => l.startsWith(prefix))
  assert.ok(line >= 0, `no line starting with ${prefix}`)
  const text = THY[line]
  const word = c => c !== undefined && /[\w'?.]/.test(c)
  let char = -1
  for (let k = 0; k <= nth; k++) {
    do char = text.indexOf(needle, char + 1)
    while (char >= 0 && (word(text[char - 1]) && word(needle[0]) ||
      word(text[char + needle.length]) && word(needle[needle.length - 1])))
  }
  assert.ok(char >= 0, `${needle} not on line ${line}`)
  return new vscode.Position(line, char)
}

/* [label, prefix of the line, the token, which occurrence of it on that line] */
const PROBES = [
  ['constant, declared', 'definition double', 'double'],
  ['type in a type', 'definition double', 'nat'],
  ['constant, defined', '  "double n', 'double'],
  ['variable of a definition', '  "double n', 'n'],
  ['infix +', '  "double n', '+'],
  ['fact, declared', 'lemma double_zero', 'double_zero'],
  ['attribute simp', 'lemma double_zero', 'simp'],
  ['constant, used', 'lemma double_zero', 'double'],
  ['numeral', 'lemma double_zero', '0'],
  ['fact, used', '  unfolding double_def', 'double_def'],
  ['method simp', '  unfolding double_def', 'simp'],
  ['fixes x', '  fixes x', 'x'],
  ['abbreviation, declared', 'abbreviation sq', 'sq'],
  ['abbreviation, used', 'lemma sq_two', 'sq'],
  ['notation of an abbreviation', '  shows "x', '\\<noteq>'],
  ['assumption label', '  assumes pos', 'pos'],
  ['variable in assumption', '  assumes pos', 'x'],
  ['fact with selection', '  using assms(2)', 'assms'],
  ['implicitly bound variable', 'lemma rev_test', 'xs'],
  ['constant rev', 'lemma rev_test', 'rev'],
  ['induct method', 'proof (induct', 'induct'],
  ['case name', '  case Nil', 'Nil'],
  ['?case', '  show ?case', '?case'],
  ['case with variables', '  case (Cons', 'Cons'],
  ['variable of a case', '  case (Cons', 'a'],
  ['binder \\<forall>', 'lemma let_test', '\\<forall>'],
  ['bound variable, binder', 'lemma let_test', 'y'],
  ['\\<lambda>', 'lemma let_test', '\\<lambda>'],
  ['let ?t, bound', '  let ?t', '?t'],
  ['?t, used', '  have h', '?t'],
  ['local fact label', '  have h', 'h'],
  ['fix u', '  fix u', 'u'],
  ['obtain w', '  obtain w', 'w'],
  ['?thesis', '  show ?thesis', '?thesis'],
  ['local fact, used', '  show ?thesis using h', 'h'],
  ['schematic variable', 'schematic_goal sch', '?x'],
  ['term with a type error', 'lemma bad_type', 'True'],
]

const hoverText = async (uri, pos) => {
  const hovers = await vscode.commands.executeCommand('vscode.executeHoverProvider', uri, pos)
  return (hovers || []).flatMap(h => h.contents.map(c => (typeof c === 'string' ? c : c.value)))
}

async function run() {
  const target = target_.resolve()
  if (!target) {
    console.log('SKIP: ' + target_.skipReason())
    console.log('SUITE52_SKIPPED')
    return
  }
  console.log(target.label)

  // Before activation: the Theories view, whose state says when the theory is checked,
  // is created at activation, and only with the extended server.
  await target_.apply(target)
  const ext = vscode.extensions.getExtension('yfprojects.vscode-isabelle')
  await ext.activate()

  const ws = vscode.workspace.workspaceFolders[0].uri.fsPath
  const file = path.join(ws, 'HoverInfo.thy')
  fs.writeFileSync(file, THY.join('\n') + '\n', 'utf8')
  const uri = vscode.Uri.file(file)

  await vscode.commands.executeCommand('isabelle.restartServer')

  const doc = await vscode.workspace.openTextDocument(uri)
  await vscode.window.showTextDocument(doc, { preview: false })

  const server = await until('restarting against the extended server', 240, async () => {
    const s = await vscode.commands.executeCommand('isabelle.serverState')
    return s && s.state === 'Running' ? s : undefined
  })
  assert.ok(server, 'the server should start')
  assert.ok(target_.matches(server, target), 'must be talking to the extended server')
  pass('language server runs against the extended server')

  const checked = await until('HoverInfo to be checked', 300, async () => {
    const s = await vscode.commands.executeCommand('isabelle.theoriesState')
    const node = s && s.nodes.find(n => n.theory.endsWith('HoverInfo'))
    return node && node.consolidated ? node : undefined
  })
  assert.ok(checked, 'HoverInfo should be checked')
  pass('the theory is checked')

  const results = {}
  for (const [label, prefix, needle, nth] of PROBES) {
    const contents = await hoverText(uri, at(prefix, needle, nth))
    results[label] = contents
    console.log(`--- ${label} (${needle})`)
    console.log(contents.length ? contents.join('\n  ~~\n') : '(empty)')
  }
  pass('every probe answered')

  // What the query of the extended server adds: asked for on the first hover, so a slow
  // answer may only be there on the next one -- which is what a user sees too.
  const plain = s => s.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/\s+/g, ' ')
  const shows = async (label, ...expected) => {
    const [, prefix, needle, nth] = PROBES.find(p => p[0] === label)
    const text = await until(`the hover of ${label}`, 20, async () => {
      const t = plain((await hoverText(uri, at(prefix, needle, nth))).join(' | '))
      return expected.every(e => t.includes(e)) ? t : undefined
    }, 500)
    assert.ok(text, `${label} should show ${expected.join(' and ')}: ` +
      plain((await hoverText(uri, at(prefix, needle, nth))).join(' | ')))
    pass(`${label}: ${expected.join(' ... ')}`)
    return text
  }
  await shows('fact, used', 'double ?n = ?n + ?n')
  const selected = await shows('fact with selection', '5 < x')
  assert.ok(!selected.includes('0 < x'), `assms(2) is only the second assumption: ${selected}`)
  await shows('assumption label', '0 < x')
  await shows('local fact, used', '1 = 1')
  await shows('local fact label', '1 = 1')
  await shows('fixes x', 'x :: nat')
  await shows('fix u', 'u :: nat')
  await shows('obtain w', 'w :: nat')
  await shows('variable of a case', "a :: 'a")
  await shows('constant, declared', 'double :: nat ⇒ nat')
  await shows('constant rev', "rev :: 'a list ⇒ 'a list")
  await shows('abbreviation, declared', 'sq :: nat ⇒ nat', 'sq x ≡ x * x')
  await shows('abbreviation, used', 'sq :: nat ⇒ nat', 'sq x ≡ x * x')
  await shows('notation of an abbreviation', ":: 'a ⇒ 'a ⇒ bool", '≡ ¬ ')
  // Its arguments are its own, not the x that assm_test fixes, so they link nowhere.
  const noteq = (await hoverText(uri, at('  shows "x', '\\<noteq>'))).join('\n')
  assert.ok(/<pre><code><a [^>]*>\(≠\)<\/a> ::[^\n]*\nx <a [^>]*>≠<\/a> y ≡/.test(noteq),
    `the equation of ≠ should be over plain arguments: ${noteq}`)
  pass('an abbreviation is shown over its own arguments, not variables of the context')
  await shows('case name', '?case ≡', 'rev (rev []) = []')
  await shows('case with variables', '?case ≡', 'rev (rev (a # ys)) = a # ys')
  await shows('?case', '?case ≡')
  await shows('let ?t, bound', '?t ≡ λz. z')
  await shows('?t, used', '?t ≡ λz. z')
  await shows('?thesis', '?thesis ≡ ∀y')

  // Names in a hover link to where they are defined: nat in the type of double.
  const linked = (await hoverText(uri, at('lemma double_zero', 'double'))).join('\n')
  assert.ok(/<a href="file:[^"]*Nat\.thy#L\d+,\d+">nat<\/a>/.test(linked),
    `the type should link nat to Nat.thy: ${linked}`)
  pass('a type in a hover links its type constructor to its theory')

  // The infoview: the goal of assm_test, where x :: nat, carries the type of x as a title.
  const editor = vscode.window.activeTextEditor
  const proofLine = THY.findIndex(l => l.startsWith('  using assms(2)'))
  editor.selection = new vscode.Selection(proofLine, 2, proofLine, 2)
  await vscode.commands.executeCommand('isabelle.infoview')
  const goals = await until('the goal in the infoview', 60, async () => {
    const s = await vscode.commands.executeCommand('isabelle.infoviewState')
    const g = String(s?.live?.goals ?? '')
    return g.includes('title=":: nat"') ? g : undefined
  }, 1000)
  assert.ok(goals, 'the goal should carry the type of x: ' +
    String((await vscode.commands.executeCommand('isabelle.infoviewState'))?.live?.goals ?? ''))
  pass('a variable of a goal in the infoview carries its type as a title')

  await target_.reset(target)
  await vscode.commands.executeCommand('workbench.action.closeAllEditors')
  fs.rmSync(file, { force: true })

  console.log(`\n${passed} checks passed`)
  console.log('SUITE52_OK')
}

module.exports = { run }
