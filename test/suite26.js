// Checks for server-path conversion and build-progress relaying.
//
// Runs in the extension host because both modules import vscode: serverPath sits beside
// the launcher it fixes, and BuildProgress needs window.withProgress.
//
// Both exist because of a real failure. Switching session wrote a native Windows path
// into sessionDirs, so the server was launched with a native -d argument; Isabelle's
// Path.explode rejects that and vscode_server exited 1. The retry then spent several
// minutes building a heap image with nothing at all on screen.
const assert = require('assert')

const { serverPath, toCygwinPath } = require('../out/isabelle.js')
const { buildLine } = require('../out/build_progress.js')

let passed = 0
const pass = m => { passed++; console.log('PASS: ' + m) }

async function run() {
  // --- paths as the server must see them ------------------------------------------
  if (process.platform === 'win32') {
    // The exact argument that broke startup.
    const native = ['c:', 'Users', 'yanni', 'Documents', 'Programming', 'viper-roots',
                    'main-results'].join('\\')
    assert.strictEqual(serverPath(native),
      '/cygdrive/c/Users/yanni/Documents/Programming/viper-roots/main-results')
    assert.ok(!serverPath(['C:', 'x', 'y'].join('\\')).includes('\\'),
      'no backslash may survive into an Isabelle argument')
    // A setting that was already POSIX must be left alone: path.resolve would turn it
    // into a C:-rooted native path and break a configuration that worked.
    assert.strictEqual(serverPath('/cygdrive/c/x'), '/cygdrive/c/x')
    assert.strictEqual(serverPath('/home/me/afp'), '/home/me/afp')
    assert.strictEqual(serverPath('C:/already/forward'), toCygwinPath('C:/already/forward'))
    pass('Windows session directories are converted, POSIX ones are left untouched')
  } else {
    assert.strictEqual(serverPath('/home/me/afp'), '/home/me/afp')
    assert.strictEqual(serverPath('relative/dir'), 'relative/dir')
    pass('paths pass through unchanged off Windows')
  }

  // --- what reaches the notification ----------------------------------------------
  // The line the server actually emitted when this was reported.
  assert.strictEqual(
    buildLine('Build started for Isabelle/MainResults_requirements(ViperAbstract) ...'),
    'building MainResults_requirements(ViperAbstract)')
  // The Isabelle/ prefix is optional and the trailing dots may be absent.
  assert.strictEqual(buildLine('Build started for HOL'), 'building HOL')
  pass('the build-started line becomes a progress message naming the session')

  for (const line of ['Running ViperCommon ...', 'Finished ViperCommon (0:01:12 elapsed)',
                      'Building TotalViperDeps ...']) {
    assert.strictEqual(buildLine(line), line, `should be surfaced: ${line}`)
  }
  pass('per-session build lines are surfaced verbatim')

  // Noise must not reach the notification: a message rewritten every few milliseconds is
  // worse than none, and per-theory chatter is most of the output.
  for (const line of ['', '   ', 'theory Pure.Thy_Output',
                      'Timing ViperCommon (5 threads, 12.3s elapsed)',
                      '### Legacy feature', 'random server chatter']) {
    assert.strictEqual(buildLine(line), undefined, `should be ignored: ${line}`)
  }
  pass('ordinary output and timing chatter stay out of the notification')

  console.log(passed + ' checks passed')
  console.log('SUITE26_OK')
}

module.exports = { run }
