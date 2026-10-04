// References in dependent theories: PIDE/dependents and PIDE/check_theories on the
// extended server (vscode_entities.scala on the release branch), through
// isabelle.checkDependentTheories in src/dependents.ts.
//
// Find references sees only the theories the server has loaded, and a theory that merely
// imports the open one has no markup until the prover has checked it. The dependents of an
// entity are the project's theories that may refer to it: unloaded, importing where it is
// bound (also indirectly), and spelling its name. This opens only the defining theory and
// checks which of four others are chosen -- a direct and an indirect importer that use the
// name, an importer that does not, and a theory that defines the same name without the
// import -- that the reference search then finds the uses in the chosen ones, and that a
// second check has nothing left to load. On the stock server the command declines.
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

const THEORIES = {
  Dep_A: [
    'theory Dep_A',
    '  imports Main',
    'begin',
    '',
    'definition tripled :: "nat \\<Rightarrow> nat" where',
    '  "tripled n = 3 * n"',
    '',
    'end',
  ],
  // imports Dep_A and uses the name
  Dep_B: [
    'theory Dep_B',
    '  imports Dep_A',
    'begin',
    '',
    'lemma tripled_zero: "tripled 0 = 0"',
    '  unfolding tripled_def by simp',
    '',
    'end',
  ],
  // imports it only through Dep_B
  Dep_C: [
    'theory Dep_C',
    '  imports Dep_B',
    'begin',
    '',
    'lemma "tripled 1 = 3"',
    '  unfolding tripled_def by simp',
    '',
    'end',
  ],
  // imports it, never says the name
  Dep_D: [
    'theory Dep_D',
    '  imports Dep_A',
    'begin',
    '',
    'lemma "True" by simp',
    '',
    'end',
  ],
  // says the name, of a constant of its own
  Dep_E: [
    'theory Dep_E',
    '  imports Main',
    'begin',
    '',
    'definition tripled :: nat where "tripled = 3"',
    '',
    'end',
  ],
}

const base = uri => path.basename(uri.fsPath ?? vscode.Uri.parse(uri).fsPath)

async function run() {
  const target = target_.resolve()
  if (!target) {
    console.log('SKIP: ' + target_.skipReason())
    console.log('SUITE52_SKIPPED')
    return
  }
  console.log(target.label)

  const ext = vscode.extensions.getExtension('yfprojects.vscode-isabelle')
  await ext.activate()

  const ws = vscode.workspace.workspaceFolders[0].uri.fsPath
  const files = {}
  for (const [name, lines] of Object.entries(THEORIES)) {
    files[name] = path.join(ws, `${name}.thy`)
    fs.writeFileSync(files[name], lines.join('\n') + '\n', 'utf8')
  }
  const uriA = vscode.Uri.file(files.Dep_A)

  await target_.apply(target)
  await vscode.commands.executeCommand('isabelle.restartServer')

  const docA = await vscode.workspace.openTextDocument(uriA)
  await vscode.window.showTextDocument(docA, { preview: false })

  const server = await until('restarting against the extended server', 240, async () => {
    const s = await vscode.commands.executeCommand('isabelle.serverState')
    return s && s.state === 'Running' ? s : undefined
  })
  assert.ok(server, 'the server should start')
  assert.ok(target_.matches(server, target), 'must be talking to the extended server')
  pass('language server runs against the extended server')

  const def = new vscode.Position(4, 'definition '.length)
  const references = () =>
    vscode.commands.executeCommand('vscode.executeReferenceProvider', uriA, def)

  // Only the open theory is loaded: the definition and its equation, nothing else.
  const before = await until('Dep_A to be checked', 240, async () => {
    const locs = await references()
    return locs && locs.length >= 2 ? locs : undefined
  })
  assert.ok(before, 'references in Dep_A should arrive')
  assert.deepStrictEqual([...new Set(before.map(l => base(l.uri)))], ['Dep_A.thy'],
    'before checking, only the open theory has references')
  pass('before: references in the open theory only')

  const checked = await vscode.commands.executeCommand('isabelle.checkDependentTheories', uriA, def)
  assert.ok(checked, 'the extended server answers')
  console.log('dependents: ' + JSON.stringify({
    names: checked.names, theories: checked.theories.map(base), failed: checked.failed.map(base),
    in_image: checked.in_image.map(base) }))
  assert.deepStrictEqual(checked.names, ['tripled'])
  assert.deepStrictEqual(checked.theories.map(base).sort(), ['Dep_B.thy', 'Dep_C.thy'],
    'the importers that spell the name, also indirect ones; not Dep_D, not Dep_E')
  assert.deepStrictEqual(checked.failed, [], 'both check without errors')
  pass('dependents: the direct and the indirect importer that use the name, nothing else')

  // Checked means checked: the uses are there at once, with nothing left to wait for.
  const after = await references()
  const where = after.map(l => `${base(l.uri)}:${l.range.start.line}:${l.range.start.character}`).sort()
  console.log('references after: ' + where.join(', '))
  for (const [file, line, char] of [['Dep_B.thy', 4, 21], ['Dep_C.thy', 4, 7]]) {
    assert.ok(where.includes(`${file}:${line}:${char}`), `the use in ${file} is found`)
  }
  assert.ok(!where.some(w => w.startsWith('Dep_E') || w.startsWith('Dep_D')),
    'nothing from the theory with its own tripled, nor from the one that never says it')
  pass('after: the reference search finds the uses in both')

  const again = await vscode.commands.executeCommand('isabelle.checkDependentTheories', uriA, def)
  assert.deepStrictEqual(again.theories, [], 'loaded theories are not dependents any more')
  pass('a second check has nothing left to load')

  if (target.extended) {
    await target_.reset(target)
    await vscode.commands.executeCommand('isabelle.restartServer')
    const plain = await until('the stock server', 240, async () => {
      const s = await vscode.commands.executeCommand('isabelle.serverState')
      return s && s.state === 'Running' && !s.extendedJar ? s : undefined
    })
    assert.ok(plain, 'the stock server should start')
    const none = await vscode.commands.executeCommand('isabelle.checkDependentTheories', uriA, def)
    assert.strictEqual(none, undefined, 'a stock server is not asked, as it would never answer')
    pass('the stock server is not asked')
  } else {
    await target_.reset(target)
  }

  await vscode.commands.executeCommand('workbench.action.closeAllEditors')
  for (const file of Object.values(files)) fs.rmSync(file, { force: true })

  console.log(`\n${passed} checks passed`)
  console.log('SUITE52_OK')
}

module.exports = { run }
