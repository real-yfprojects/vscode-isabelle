const path = require('path')
const os = require('os')
const fs = require('fs')
const { runTests, downloadAndUnzipVSCode } = require('@vscode/test-electron')

// The extension host exports ELECTRON_RUN_AS_NODE=1 and VSCODE_*; inheriting those
// makes the spawned Code.exe run as plain Node instead of launching the workbench.
for (const k of Object.keys(process.env)) {
  if (k.startsWith('VSCODE_') || k.startsWith('ELECTRON_')) delete process.env[k]
}

function installedVSCode() {
  const candidates = [
    'C:\\Program Files\\Microsoft VS Code\\Code.exe',
    path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Microsoft VS Code', 'Code.exe'),
    '/Applications/Visual Studio Code.app/Contents/MacOS/Electron',
    '/usr/share/code/code',
  ]
  return candidates.find(p => fs.existsSync(p))
}

/**
 * Find the binary inside a downloaded VS Code, when the library's guess is wrong.
 *
 * @vscode/test-electron hardcodes "Visual Studio Code.app/Contents/MacOS/Electron" for
 * darwin (util.js, downloadDirToExecutablePath). VS Code 1.137.0 on darwin-arm64 does not
 * have a binary by that name, so the download succeeds, the library reports a path, and
 * spawning it fails with ENOENT -- which reads as a broken download rather than a stale
 * assumption. Look at what is actually in the bundle instead.
 */
function repairExecutable(exe) {
  const appIndex = exe.lastIndexOf('.app')
  const root = appIndex === -1 ? path.dirname(exe) : path.dirname(exe.slice(0, appIndex))
  let apps
  try { apps = fs.readdirSync(root) } catch { return undefined }
  for (const app of apps.filter(n => n.endsWith('.app'))) {
    const macos = path.join(root, app, 'Contents', 'MacOS')
    let bins
    try { bins = fs.readdirSync(macos) } catch { continue }
    // Helpers are separate executables in the same directory and never the entry point.
    const main = bins.find(n => !n.includes('Helper'))
    if (main) {
      console.log(`repaired VS Code path: ${app}/Contents/MacOS/${main} (had: ${bins.join(', ')})`)
      return path.join(macos, main)
    }
  }
  console.error(`no VS Code binary under ${root}; saw: ${apps.join(', ')}`)
  return undefined
}

/** The editor to drive: an installed one, else the downloaded one. */
async function resolveVSCode() {
  const installed = installedVSCode()
  if (installed) return installed
  const exe = await downloadAndUnzipVSCode()
  if (fs.existsSync(exe)) return exe
  return repairExecutable(exe) ?? exe
}

async function main() {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'isabelle-vsc-test-'))
  try {
    await runTests({
      vscodeExecutablePath: await resolveVSCode(),
      extensionDevelopmentPath: path.join(__dirname, '..'),
      extensionTestsPath: path.join(__dirname, process.argv[2] || 'suite.js'),
      // Forwarded so suite15 can find a patched Isabelle; unset in a normal run.
      extensionTestsEnv: {
        ISABELLE_QUERY_HOME: process.env.ISABELLE_QUERY_HOME || '',
        ISABELLE_PATCHED_HOME: process.env.ISABELLE_PATCHED_HOME || '',
        ISABELLE_TEST_PROJECT: process.env.ISABELLE_TEST_PROJECT || '',
        ISABELLE_TEST_WORKSPACE: process.env.ISABELLE_TEST_WORKSPACE || '',
      },
      launchArgs: [
        // Overridable so several suites can run at once: most of them write into the
        // workspace, so sharing one directory across concurrent editors races.
        process.env.ISABELLE_TEST_WORKSPACE || path.join(__dirname, 'workspace'),
        '--disable-extensions',
        '--user-data-dir', userDataDir,
        '--skip-welcome',
        '--skip-release-notes',
      ],
    })
  } catch (err) {
    console.error('FAILED:', err && err.message)
    process.exit(1)
  }
}

main()
