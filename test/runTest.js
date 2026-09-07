const path = require('path')
const os = require('os')
const fs = require('fs')
const { runTests } = require('@vscode/test-electron')

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

async function main() {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'isabelle-vsc-test-'))
  try {
    await runTests({
      vscodeExecutablePath: installedVSCode(),
      extensionDevelopmentPath: path.join(__dirname, '..'),
      extensionTestsPath: path.join(__dirname, process.argv[2] || 'suite.js'),
      launchArgs: [
        path.join(__dirname, 'workspace'),
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
