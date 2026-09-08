// Does -R (isabelle.logicRequirements) actually cache imported sessions?
//
// The instrument is the Theories view: PIDE filters out theories that are already in the
// loaded image (Resources.loaded_theory), so a cached import is one that does NOT appear
// while its importer does. Needs a patched Isabelle for the Theories protocol, and a
// two-session project in ISABELLE_TEST_PROJECT.
const vscode = require('vscode')
const assert = require('assert')
const path = require('path')

const wait = ms => new Promise(r => setTimeout(r, ms))
let passed = 0
const pass = m => { passed++; console.log('PASS: ' + m) }

async function until(what, seconds, probe) {
  const deadline = Date.now() + seconds * 1000
  while (Date.now() < deadline) {
    const v = await probe()
    if (v) return v
    console.log(`  ...${what} (${Math.round((deadline - Date.now()) / 1000)}s left)`)
    await wait(3000)
  }
  return undefined
}

async function run() {
  const home = process.env.ISABELLE_PATCHED_HOME || process.env.ISABELLE_QUERY_HOME
  const proj = process.env.ISABELLE_TEST_PROJECT
  if (!home || !proj) {
    console.log('SKIP: needs ISABELLE_PATCHED_HOME and ISABELLE_TEST_PROJECT')
    console.log('SUITE24_SKIPPED')
    return
  }
  const ext = vscode.extensions.getExtension('spike.isabelle-pide-stock')
  await ext.activate()

  const cfg = vscode.workspace.getConfiguration('isabelle')
  await cfg.update('home', home, vscode.ConfigurationTarget.Global)
  await cfg.update('theoriesPanel', true, vscode.ConfigurationTarget.Global)
  await cfg.update('sessionDirs', [proj], vscode.ConfigurationTarget.Global)
  await cfg.update('logic', 'Work', vscode.ConfigurationTarget.Global)
  await cfg.update('logicRequirements', true, vscode.ConfigurationTarget.Global)
  await vscode.commands.executeCommand('isabelle.restartServer')

  const doc = await vscode.workspace.openTextDocument(
    vscode.Uri.file(path.join(proj, 'work', 'WorkThy.thy')))
  const editor = await vscode.window.showTextDocument(doc, { preview: false })

  const server = await until('starting the server (may build an image)', 600, async () => {
    const s = await vscode.commands.executeCommand('isabelle.serverState')
    return s && s.state === 'Running' ? s : undefined
  })
  assert.ok(server, `server should start; last error: ${(server || {}).lastError}`)
  pass('server starts with -R against the two-session project')

  editor.selection = new vscode.Selection(4, 4, 4, 4)
  const st = await until('waiting for theory status', 300, async () => {
    const s = await vscode.commands.executeCommand('isabelle.theoriesState')
    return s && s.nodes.length > 0 ? s : undefined
  })
  assert.ok(st, 'the Theories view should report something')
  const theories = st.nodes.map(n => n.theory)
  console.log('theories being checked: ' + JSON.stringify(theories))

  assert.ok(theories.some(t => t.endsWith('WorkThy')),
    'the theory being edited must be checked live')
  assert.ok(!theories.some(t => t.endsWith('LibThy')),
    'LibThy comes from another session and must be served from the image, not re-checked; ' +
    `got ${JSON.stringify(theories)}`)
  pass('imported sessions are loaded from a heap rather than re-checked')

  console.log(`${passed} checks passed`)
  console.log('SUITE24_OK')
}

module.exports.run = () => run().catch(err => {
  console.error('FAIL: ' + (err && err.stack || err))
  process.exit(1)
})
