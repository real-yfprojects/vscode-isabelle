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

const fs = require('fs')
const os = require('os')
const path = require('path')
const { serverPath, toCygwinPath, buildServerOptions, stageExtendedJar } =
  require('../out/isabelle.js')
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

  // --- the launch path for every platform, from whichever we are on ----------------
  // Only the Windows/Cygwin path has ever started a real prover, and CI has no Isabelle
  // to change that. Injecting the platform at least holds the argument construction
  // still, which is where the -d bug lived.
  const backslash = String.fromCharCode(92)
  assert.strictEqual(serverPath('/home/me/afp', 'linux'), '/home/me/afp')
  assert.strictEqual(serverPath(['C:', 'x'].join(backslash), 'linux'),
    ['C:', 'x'].join(backslash),
    'off Windows a path is Isabelle-ready already and must not be rewritten')
  assert.ok(serverPath(['C:', 'x'].join(backslash), 'win32').startsWith('/cygdrive/c/'))
  pass('path conversion follows the target platform, not the host')

  // The two launch shapes differ in more than the executable: Windows goes through the
  // bundled Cygwin bash with the tool script as an argument, POSIX runs bin/isabelle.
  const home = '/opt/Isabelle2025-2'
  const posix = buildServerOptions(home, 'linux')
  assert.ok(posix.command.endsWith('isabelle') && !posix.command.includes('bash'),
    `POSIX should invoke bin/isabelle directly: ${posix.command}`)
  assert.strictEqual(posix.args[0], 'vscode_server',
    'vscode_server must be the first argument, not preceded by a shell login flag')
  assert.strictEqual(posix.options.env.CHERE_INVOKING, undefined,
    'CHERE_INVOKING is a Cygwin concern and must not leak onto POSIX')
  assert.ok(posix.args.every(a => !a.includes('cygdrive')),
    'no Cygwin path may appear in a POSIX launch')
  pass('the POSIX launch runs bin/isabelle directly, with no Cygwin residue')

  // The extended server is nothing but a jar ahead of the distribution's own: getsettings
  // seeds ISABELLE_CLASSPATH from CLASSPATH, so it has to come first there.
  const jar = '/ext/server/Isabelle2025-2.jar'
  const extended = buildServerOptions(home, 'linux', jar)
  assert.strictEqual(extended.options.env.CLASSPATH.split(':')[0], jar,
    'the extended server jar must head CLASSPATH')
  assert.deepStrictEqual(extended.args, posix.args,
    'the extended server changes the classpath, not the command line')
  assert.strictEqual(posix.options.env.CLASSPATH, process.env.CLASSPATH,
    'without the extended server CLASSPATH must pass through untouched')
  pass('the extended server is launched by prepending its jar to CLASSPATH')

  // The server runs a copy of the jar, because a JVM's open jar can be overwritten in place
  // on Windows and the server then fails its next class load. The copy is named by content.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'isa-stage-'))
  const source = path.join(tmp, 'Isabelle2025-2.jar')
  const store = path.join(tmp, 'storage', 'server')
  fs.writeFileSync(source, 'first build')
  const first = stageExtendedJar(source, store)
  assert.notStrictEqual(first, source, 'the server must not run the jar in the extension')
  assert.strictEqual(fs.readFileSync(first, 'utf8'), 'first build')
  assert.strictEqual(stageExtendedJar(source, store), first, 'the same jar is staged once')
  fs.writeFileSync(source, 'second build')
  const second = stageExtendedJar(source, store)
  assert.notStrictEqual(second, first, 'a rebuilt jar gets a copy of its own')
  assert.strictEqual(fs.readFileSync(second, 'utf8'), 'second build')
  assert.ok(!fs.existsSync(first), 'a copy nothing runs any more is removed')
  assert.deepStrictEqual(fs.readdirSync(store), [path.basename(second)],
    'no temporary files are left behind')
  fs.rmSync(tmp, { recursive: true, force: true })
  pass('the extended server runs a content-named copy of the jar')

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
