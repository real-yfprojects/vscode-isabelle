// Sledgehammer jobs on the extended server (vscode_sledgehammer.ML, VSCode_Sledgehammer,
// src/sledgehammer_jobs.ts): runs that go on while the theory is edited, several at once.
//
// The classic run is a query on one command, and typing the next step edits that command --
// a word that is not yet a keyword joins the span before it -- which ended the run. A job
// only takes the proof state there and runs on in a group of its own. This types the next
// step letter by letter under a running job and requires it to run to its end; runs two at
// once; hammers the sorrys of a lemma and puts the proofs in, after which the theory checks;
// and checks Cancel, falsification, the fact override and subgoal, and the prover cache.
//
// Runs against the stock Isabelle with the extended server; skips itself without its jar
// (test/server_target.js).
const vscode = require('vscode')
const target_ = require('./server_target')
const assert = require('assert')
const fs = require('fs')
const path = require('path')

const wait = ms => new Promise(r => setTimeout(r, ms))
let passed = 0
const pass = m => { passed++; console.log('PASS: ' + m) }

async function until(what, seconds, probe, interval = 1000) {
  const deadline = Date.now() + seconds * 1000
  while (Date.now() < deadline) {
    const value = await probe()
    if (value) return value
    if (what) console.log(`  ...${what} (${Math.round((deadline - Date.now()) / 1000)}s left)`)
    await wait(interval)
  }
  return undefined
}

const LINES = [
  'theory Hammer_Jobs',
  '  imports Main',
  'begin',
  '',
  // True, and far beyond the provers: a run on it takes its whole timeout.
  'lemma hard: "(x::nat) ^ 3 + y ^ 3 \\<noteq> z ^ 3 \\<or> x * y * z = 0"',
  'proof -',
  '  have h: "(x::nat) ^ 3 + y ^ 3 \\<noteq> z ^ 3 \\<or> x * y * z = 0"',
  '',
  '    sorry',
  '  show ?thesis using h .',
  'qed',
  '',
  'lemma hard2: "(x::nat) ^ 4 + y ^ 4 \\<noteq> z ^ 4 \\<or> x * y * z = 0"',
  '  sorry',
  '',
  'lemma three: "rev (rev xs) = (xs::nat list) \\<and> length (xs @ ys) = length ys + length (xs::nat list)"',
  'proof',
  '  have "rev (rev xs) = (xs::nat list)" sorry',
  '  then show "rev (rev xs) = (xs::nat list)" sorry',
  '  show "length (xs @ ys) = length ys + length (xs::nat list)"',
  '    sorry',
  'qed',
  '',
  'definition c :: nat where "c = 3"',
  '',
  'lemma two: "c + 1 = 4 \\<and> (d::nat) = 5"',
  '  apply (rule conjI)',
  '  sorry',
  '',
  // Last: as a fact, a false lemma proves anything after it.
  'lemma wrong: "(x::nat) < 0"',
  '  sorry',
  '',
  'end',
]
const at = text => LINES.findIndex(l => l.includes(text))

const state = () => vscode.commands.executeCommand('isabelle.sledgehammerState')
async function jobs() { return ((await state()) || {}).jobs || [] }
async function job(id) { return (await jobs()).find(j => j.id === id) }
const active = j => j && ['queued', 'starting', 'running'].includes(j.status)

const errorsAt = (uri, line) => vscode.languages.getDiagnostics(uri).filter(d =>
  d.severity === vscode.DiagnosticSeverity.Error && d.range.start.line === line)
const errors = uri => vscode.languages.getDiagnostics(uri).filter(d =>
  d.severity === vscode.DiagnosticSeverity.Error)

/** The newest job the client knows, once one newer than `after` exists. */
async function newJob(after) {
  return until(undefined, 10, async () => {
    const js = await jobs()
    return js.filter(j => j.startedAt > after).sort((a, b) => b.startedAt - a.startedAt)[0]
  }, 100)
}

/* What the panel's controls set for the window's runs. */
const setOptions = options => vscode.commands.executeCommand('isabelle.sledgehammerTestOptions', options)

async function run() {
  const target = target_.resolve()
  if (!target) {
    console.log('SKIP: ' + target_.skipReason())
    console.log('SUITE68_SKIPPED')
    return
  }
  console.log(target.label)

  const ext = vscode.extensions.getExtension('yfprojects.vscode-isabelle')
  await ext.activate()

  const ws = vscode.workspace.workspaceFolders[0].uri.fsPath
  const file = path.join(ws, 'Hammer_Jobs.thy')
  fs.writeFileSync(file, LINES.join('\n') + '\n', 'utf8')

  const cfg = vscode.workspace.getConfiguration('isabelle')
  await cfg.update('checkWholeTheory', true, vscode.ConfigurationTarget.Global)
  await cfg.update('sledgehammer.maxParallel', 2, vscode.ConfigurationTarget.Global)
  await target_.apply(target)
  await vscode.commands.executeCommand('isabelle.restartServer')

  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file))
  const editor = await vscode.window.showTextDocument(doc, { preview: false })

  const server = await until('restarting against the extended server', 240, async () => {
    const s = await vscode.commands.executeCommand('isabelle.serverState')
    return s && s.state === 'Running' ? s : undefined
  }, 2000)
  assert.ok(server && target_.matches(server, target), 'must be talking to the extended server')
  await vscode.commands.executeCommand('isabelle-sledgehammer.focus')
  assert.ok(await until('the jobs to be offered', 30, async () => !!(await state())?.jobs, 500),
    'the server should offer Sledgehammer jobs')
  pass('the extended server offers Sledgehammer jobs')

  await setOptions({ timeout: 15, stopAtFirst: true, falsify: true })

  // --- 1. typing the next step under a running job ------------------------------------------
  const HAVE = at('have h:')
  editor.selection = new vscode.Selection(HAVE, 4, HAVE, 4)
  let t0 = Date.now()
  await vscode.commands.executeCommand('isabelle.sledgehammer')
  const typed = await newJob(t0 - 1)
  assert.ok(typed, 'a job should start at the cursor')
  assert.strictEqual(typed.kind, 'command')
  const ran = await until('the job to run', 120, async () => (await job(typed.id))?.status === 'running', 250)
  if (!ran) console.log('  job: ' + JSON.stringify(await job(typed.id)))
  assert.ok(ran, 'the job should run')
  const BLANK = HAVE + 1
  /* `b` is a word, not yet the keyword: it joins the have's span, so that command goes, as
     it did under the classic run. `by` then splits off, a command of its own that lacks
     its method -- an error, which says that the prover has seen the edits. */
  const editedAt = Date.now()
  await editor.edit(b => b.insert(doc.lineAt(BLANK).range.end, '  b'))
  await wait(1500)
  await editor.edit(b => b.insert(doc.lineAt(BLANK).range.end, 'y'))
  const changed = await until('the edit to be checked', 30, async () =>
    errorsAt(doc.uri, BLANK).length > 0, 250)
  const during = await job(typed.id)
  console.log(`  after the edit: ${during && during.status}, error shown: ${!!changed}`)
  assert.ok(changed, 'the edit of the have should be checked')
  assert.ok(active(during), 'the job should still run after its command was edited')
  const typedEnd = await until('the job to end', 90, async () => {
    const j = await job(typed.id)
    return j && !active(j) ? j : undefined
  })
  assert.ok(typedEnd, 'the job should end')
  console.log(`  ended: ${typedEnd.status}/${typedEnd.outcome} after ` +
    `${((typedEnd.endedAt - typedEnd.startedAt) / 1000).toFixed(1)}s, ` +
    `${((typedEnd.endedAt - editedAt) / 1000).toFixed(1)}s after the edit`)
  assert.strictEqual(typedEnd.status, 'finished', 'run to its end, not cancelled with its command')
  assert.ok(typedEnd.endedAt - editedAt > 3000, 'and ended well after the edit')
  await editor.edit(b => b.delete(doc.lineAt(BLANK).range))
  pass('a job runs to its end while the next step is typed under it')

  // --- 2. two at once ---------------------------------------------------------------------
  const H2 = at('lemma hard2')
  t0 = Date.now()
  editor.selection = new vscode.Selection(at('lemma hard:'), 0, at('lemma hard:'), 0)
  await vscode.commands.executeCommand('isabelle.sledgehammer')
  const first = await newJob(t0 - 1)
  editor.selection = new vscode.Selection(H2, 0, H2, 0)
  await vscode.commands.executeCommand('isabelle.sledgehammer')
  const second = await newJob(first.startedAt)
  assert.ok(first && second && first.id !== second.id, 'two jobs')
  const both = await until('both to run', 120, async () =>
    (await job(first.id))?.status === 'running' && (await job(second.id))?.status === 'running', 250)
  assert.ok(both, 'two jobs should run at the same time')
  pass('two jobs run at once')

  // --- 3. Cancel --------------------------------------------------------------------------
  const cancelledAt = Date.now()
  await vscode.commands.executeCommand('isabelle.sledgehammerCancelJob', first.id)
  await vscode.commands.executeCommand('isabelle.sledgehammerCancel')
  assert.strictEqual((await job(first.id)).status, 'cancelled')
  assert.strictEqual((await job(second.id)).status, 'cancelled')
  // And the server lets go of their slots: a new job starts at once -- here from the light
  // bulb of a sorry.
  const WRONG_SORRY = at('lemma wrong') + 1
  const bulb = await vscode.commands.executeCommand('vscode.executeCodeActionProvider', doc.uri,
    new vscode.Range(WRONG_SORRY, 2, WRONG_SORRY, 2))
  const hammerThis = bulb.find(a => a.title === 'Sledgehammer this sorry')
  assert.ok(hammerThis, `a sorry offers a run: ${JSON.stringify(bulb.map(a => a.title))}`)
  assert.ok(!bulb.some(a => /^Sledgehammer all/.test(a.title)), 'not for all: the lemma has one')
  t0 = Date.now()
  await vscode.commands.executeCommand(hammerThis.command.command, ...hammerThis.command.arguments)
  const falsify = await newJob(t0 - 1)
  assert.strictEqual(falsify.kind, 'sorry')
  const bulbAfter = await vscode.commands.executeCommand('vscode.executeCodeActionProvider', doc.uri,
    new vscode.Range(WRONG_SORRY, 2, WRONG_SORRY, 2))
  assert.ok(!bulbAfter.some(a => a.title === 'Sledgehammer this sorry'), 'none while one runs')
  assert.ok(await until(undefined, 30, async () => (await job(falsify.id))?.status !== 'queued', 250),
    'a cancelled job frees its slot')
  pass(`Cancel ends jobs and frees their slots (${((Date.now() - cancelledAt) / 1000).toFixed(1)}s)`)

  // --- 4. falsification -------------------------------------------------------------------
  const falsified = await until('the false goal', 90, async () => {
    const j = await job(falsify.id)
    return j && !active(j) ? j : undefined
  })
  console.log(`  wrong: ${falsified && falsified.status}, falsified: ${falsified && falsified.falsified}` +
    `, messages: ${JSON.stringify((falsified && falsified.messages || []).map(m => m.replace(/<[^>]*>/g, '')).slice(-3))}`)
  assert.ok(falsified && falsified.falsified, 'x < 0 should be falsified')
  pass('a false goal is reported as falsified')

  // --- 5. all the sorrys of a lemma, put in ---------------------------------------------------
  const THREE = at('lemma three')
  const offered = await vscode.commands.executeCommand('vscode.executeCodeActionProvider', doc.uri,
    new vscode.Range(THREE + 2, 4, THREE + 2, 4))
  const hammerAll = offered.find(a => a.title === 'Sledgehammer all 3 sorrys of this lemma')
  assert.ok(hammerAll, `the light bulb offers all the lemma's sorrys: ${JSON.stringify(offered.map(a => a.title))}`)
  t0 = Date.now()
  await vscode.commands.executeCommand(hammerAll.command.command, ...hammerAll.command.arguments)
  const batch = (await until(undefined, 10, async () => {
    const js = (await jobs()).filter(j => j.startedAt >= t0 - 1)
    return js.length >= 3 ? js : undefined
  }, 200)) || []
  assert.strictEqual(batch.length, 3, 'one job for each sorry of the lemma')
  assert.ok(batch.every(j => j.kind === 'sorry'))
  const done = await until('the sorrys', 180, async () => {
    const js = await Promise.all(batch.map(j => job(j.id)))
    return js.every(j => j && !active(j)) ? js : undefined
  }, 2000)
  assert.ok(done, 'the jobs should end')
  for (const j of done) console.log(`  ${j.label}: ${j.status}, ${j.proofs.length} proof(s) ${JSON.stringify(j.proofs)}` +
    ` in ${((j.endedAt - j.startedAt) / 1000).toFixed(1)}s`)
  assert.ok(done.every(j => j.proofs.length > 0), 'each sorry should get a proof')
  assert.ok(done.every(j => j.endedAt - j.startedAt < 15000 * 2),
    'stopped at the first proof, well before twice the timeout')
  const lenses = await vscode.commands.executeCommand('vscode.executeCodeLensProvider', doc.uri)
  assert.ok(lenses.some(l => l.command && l.command.command === 'isabelle.sledgehammerApply'),
    'the proofs are offered as CodeLenses')
  const fixes = await vscode.commands.executeCommand('vscode.executeCodeActionProvider', doc.uri,
    new vscode.Range(THREE + 2, 0, THREE + 2, 50))
  assert.ok(fixes.some(a => /^Replace sorry with /.test(a.title)), 'and as quick fixes')
  assert.ok(!fixes.some(a => /^Sledgehammer /.test(a.title)), 'no new run for a sorry with a proof waiting')
  for (const j of done) {
    assert.ok(await vscode.commands.executeCommand('isabelle.sledgehammerApply', j.id, j.proofs[0]),
      `the proof for ${j.label} should go in`)
  }
  const lemmaText = () => doc.getText(new vscode.Range(THREE, 0, THREE + 6, 0))
  console.log(lemmaText())
  assert.ok(!/\bsorry\b/.test(lemmaText()), 'no sorry left in the lemma')
  // Checked again once the edits arrive; an error would show by then.
  await wait(15000)
  const errs = errors(doc.uri).filter(d => d.range.start.line >= THREE && d.range.start.line <= THREE + 6)
  assert.strictEqual(errs.length, 0, `the lemma should check: ${errs.map(d => d.message).join('; ')}`)
  pass('Sledgehammer All sorrys proves a lemma, and the proofs it puts in check')

  // --- 6. facts and subgoal -------------------------------------------------------------------
  const TWO = at('lemma two')
  const APPLY = TWO + 1
  /** A run on the state after the apply, with these options; how it ended. */
  async function hammerApply(options, what) {
    await setOptions(options)
    editor.selection = new vscode.Selection(APPLY, 4, APPLY, 4)
    const t = Date.now()
    await vscode.commands.executeCommand('isabelle.sledgehammer')
    const started = await newJob(t - 1)
    const end = await until(what, 90, async () => {
      const j = await job(started.id)
      return j && !active(j) ? j : undefined
    })
    console.log(`  ${what}: ${end && end.status}/${end && end.outcome}, ${JSON.stringify(end && end.proofs)}`)
    return end
  }
  const added = await hammerApply({ facts: 'add: c_def', subgoal: 1, timeout: 10 }, 'add: c_def')
  assert.ok(added && added.proofs.some(p => /c_def/.test(p)), 'a proof with the added fact')
  const deleted = await hammerApply({ facts: 'del: c_def', subgoal: 1, timeout: 10 }, 'del: c_def')
  assert.ok(deleted && !deleted.proofs.some(p => /c_def/.test(p)), 'none with the deleted one')
  const sub2 = await hammerApply({ facts: '', subgoal: 2, timeout: 8 }, 'subgoal 2')
  assert.ok(sub2 && sub2.status === 'finished' && sub2.proofs.length === 0,
    'd = 5 is not provable: subgoal 2 was hammered')
  await setOptions({ facts: '', subgoal: 1, timeout: 15 })
  pass('the fact override and the subgoal reach Sledgehammer')

  // --- 7. the prover cache ------------------------------------------------------------------
  const cacheDir = await vscode.commands.executeCommand('isabelle.sledgehammerCacheDir')
  const files = cacheDir && fs.existsSync(cacheDir) ? fs.readdirSync(cacheDir) : []
  console.log(`  cache ${cacheDir}: ${files.length} file(s)`)
  assert.ok(files.length > 0, 'the external provers\' answers should be cached')
  pass('the answers of the external provers are cached')

  await cfg.update('checkWholeTheory', undefined, vscode.ConfigurationTarget.Global)
  await cfg.update('sledgehammer.maxParallel', undefined, vscode.ConfigurationTarget.Global)
  await target_.reset(target)
  await vscode.commands.executeCommand('workbench.action.closeAllEditors')
  fs.rmSync(file, { force: true })

  console.log(`\n${passed} checks passed`)
  console.log('SUITE68_OK')
}

module.exports = { run }
