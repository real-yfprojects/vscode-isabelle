// The walkthrough's "Follow the proof" step, before any server: its "Show Infoview" button
// has to open the Infoview.
//
// The walkthrough is read with no theory open, so no server is running, and clicking a
// button is often what activates the extension. isabelle.infoview used to be registered
// only once a server had started, so the click did nothing and said nothing. suite46
// checks that the command is contributed; this checks that it exists and works then.
//
// Needs no prover; runAll starts it with isabelle.autoStart off.
const vscode = require('vscode')
const assert = require('assert')

const EXT_ID = 'yfprojects.vscode-isabelle'
const wait = ms => new Promise(r => setTimeout(r, ms))
let passed = 0
const pass = m => { passed++; console.log('PASS: ' + m) }

async function until(what, seconds, probe) {
  const deadline = Date.now() + seconds * 1000
  let last
  while (Date.now() < deadline) {
    last = await probe()
    if (last) return last
    await wait(250)
  }
  throw new Error(`timed out after ${seconds}s: ${what}`)
}

async function run() {
  try { await drive() } catch (err) {
    console.error('SUITE50 FAILED: ' + (err && err.stack || err))
    throw err
  }
}

async function drive() {
  const ext = vscode.extensions.getExtension(EXT_ID)
  assert.ok(!ext.isActive, 'nothing has activated the extension yet: the button has to')

  // What the button's command: link does.
  await vscode.commands.executeCommand('isabelle.infoview')
  assert.ok(ext.isActive, 'the button activates the extension')
  const commands = await vscode.commands.getCommands(true)
  assert.ok(commands.includes('isabelle.infoview'), 'isabelle.infoview is registered without a server')
  const state = await until('the Infoview view to be resolved', 30, async () => {
    const s = await vscode.commands.executeCommand('isabelle.infoviewState')
    return s?.inView && s
  })
  assert.strictEqual(state.mode, 'waiting', 'with no server the Infoview says it is waiting')
  const server = await vscode.commands.executeCommand('isabelle.serverState')
  assert.strictEqual(server.state, 'none', 'no server was started for this')
  pass('"Show Infoview" opens the Infoview before any server has started')

  console.log(passed + ' checks passed')
  console.log('SUITE50_OK')
}

module.exports = { run }
