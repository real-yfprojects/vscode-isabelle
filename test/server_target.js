// Which Isabelle the suites for the experimental panels talk to.
//
// Those panels need messages a released language server does not send. There are two ways
// to get them: a distribution patched and rebuilt by hand (ISABELLE_PATCHED_HOME, and for
// suite15 the older ISABELLE_QUERY_HOME), or -- the way users get them -- the stock
// distribution the extension finds, started with isabelle.extendedServer and the jar that
// scripts/build-server-jar.sh builds for it. An explicit home wins; the jar is used when it
// exists for that distribution; with neither, a suite has nothing to test and skips.
//
// Resolved without activating the extension, because suite30 writes its settings first.
const vscode = require('vscode')
const fs = require('fs')
const path = require('path')
const { findIsabelleHome } = require('../out/isabelle.js')

const EXT_ID = 'spike.isabelle-pide-stock'

function resolve(vars = ['ISABELLE_PATCHED_HOME']) {
  const explicit = vars.map(v => process.env[v]).find(Boolean)
  if (explicit) return { home: explicit, label: `patched Isabelle: ${explicit}` }

  let home
  try { home = findIsabelleHome() } catch { return undefined }
  let identifier
  try {
    identifier = fs.readFileSync(path.join(home, 'etc', 'ISABELLE_IDENTIFIER'), 'utf8').trim()
  } catch { return undefined }
  const jar = path.join(vscode.extensions.getExtension(EXT_ID).extensionPath,
    'server', `${identifier}.jar`)
  if (!fs.existsSync(jar)) return undefined
  return { extended: true, home, jar, label: `stock ${identifier} with the extended server` }
}

function skipReason(vars = ['ISABELLE_PATCHED_HOME']) {
  return `no patched Isabelle: set ${vars.join(' or ')}, or build the extended server ` +
    '(scripts/build-server-jar.sh)'
}

async function apply(target, scope = vscode.ConfigurationTarget.Global) {
  const cfg = vscode.workspace.getConfiguration('isabelle')
  if (target.extended) await cfg.update('extendedServer', true, scope)
  else await cfg.update('home', target.home, scope)
}

async function reset(target, scope = vscode.ConfigurationTarget.Global) {
  const cfg = vscode.workspace.getConfiguration('isabelle')
  if (target.extended) await cfg.update('extendedServer', undefined, scope)
  else await cfg.update('home', undefined, scope)
}

/* The extension's context and vscode.extensions spell the same path differently on
   Windows (drive letter case), and that file system ignores case anyway. */
const samePath = (a, b) => {
  if (!a || !b) return false
  const norm = p => process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p)
  return norm(a) === norm(b)
}

/** Whether isabelle.serverState describes a server started for this target. */
function matches(state, target) {
  const [actual, expected] =
    target.extended ? [state.extendedJar, target.jar] : [state.isabelleHome, target.home]
  if (samePath(actual, expected)) return true
  console.log(`server started with ${actual}, expected ${expected}`)
  return false
}

module.exports = { resolve, skipReason, apply, reset, matches }
