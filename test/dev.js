// One command for a dev run of the extension against a PATCHED Isabelle.
//
//   npm run dev                         # uses C:\Users\yanni\Isabelle\Isabelle2025-2-query
//   ISABELLE_PATCHED_HOME=... npm run dev
//
// Compiles, seeds an isolated profile (test/dev-profile.js), then launches the
// installed VS Code as an Extension Development Host on test/workspace. Nothing here
// touches your real VS Code profile.

const { spawn, spawnSync } = require('child_process')
const path = require('path')
const os = require('os')
const fs = require('fs')

// Inherited from an extension-host terminal, these make the spawned Code.exe run as
// plain Node instead of opening the workbench.
for (const k of Object.keys(process.env)) {
  if (k.startsWith('VSCODE_') || k.startsWith('ELECTRON_')) delete process.env[k]
}

const { seed, REPO } = require('./dev-profile')

function installedVSCode() {
  const candidates = [
    'C:\\Program Files\\Microsoft VS Code\\Code.exe',
    path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Microsoft VS Code', 'Code.exe'),
    '/Applications/Visual Studio Code.app/Contents/MacOS/Electron',
    '/usr/share/code/code',
    '/usr/bin/code',
  ]
  const found = candidates.find(p => fs.existsSync(p))
  if (!found) throw new Error('Could not find an installed VS Code (Code.exe).')
  return found
}

function main() {
  const { profile } = seed()

  console.log('compiling...')
  const tsc = spawnSync(process.execPath, [
    path.join(REPO, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', REPO,
  ], { stdio: 'inherit' })
  if (tsc.status !== 0) process.exit(tsc.status || 1)

  const code = installedVSCode()
  const workspace = path.join(REPO, 'test', 'workspace')
  const args = [
    workspace,
    `--extensionDevelopmentPath=${REPO}`,
    `--user-data-dir=${profile}`,
    '--disable-extensions',
    // --user-data-dir does not isolate ~/.vscode-shared, so a second instance next to
    // your main editor cannot decrypt its OS-keychain secrets. "basic" keeps secrets
    // in the (throwaway) profile instead and silences safeStorage.decryptString errors.
    '--password-store=basic',
    '--skip-welcome',
    '--skip-release-notes',
    '--new-window',
  ]
  console.log(`launching: ${path.basename(code)} ${args.join(' ')}`)
  const child = spawn(code, args, { stdio: 'inherit', detached: false })
  child.on('exit', c => process.exit(c || 0))
}

try { main() }
catch (err) { console.error(String(err.message || err)); process.exit(1) }
