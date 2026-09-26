// Pure checks for heap_files.ts: which workspace files a heap image holds, and when one
// of them no longer matches it. No prover, no editor -- real files in a temp directory.
//
// A stale image gives no signal of its own: the heap theories are never re-read, and
// everything above them keeps checking against the old text. So the comparison has to be
// right on its own terms, which is content and not timestamps.
const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')

const { heapSourceFiles, takeBaseline, compare, digest, digestFile, fileKey } =
  require(path.join(__dirname, '..', 'out', 'heap_files.js'))
const { parseRoot } = require(path.join(__dirname, '..', 'out', 'sessions.js'))

let passed = 0
const pass = m => { passed++; console.log('PASS: ' + m) }

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
}

async function run() {
  // Common <- Abstract <- Main, plus a Helper that Main pulls in through `sessions`.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'isa-heap-'))
  const roots = {
    common: 'session Common = HOL +\n  theories\n    Binop\n',
    abstract: 'session Abstract = Common +\n  directories\n    extra\n  theories\n    Sem\n',
    helper: 'session Helper = HOL +\n  theories\n    Help\n',
    main: 'session Main2 = Abstract +\n  sessions\n    Helper\n  theories\n    Results\n',
  }
  const sessions = []
  for (const [dir, text] of Object.entries(roots)) {
    write(path.join(tmp, dir, 'ROOT'), text)
    sessions.push(...parseRoot(text, path.join(tmp, dir, 'ROOT')))
  }
  write(path.join(tmp, 'common', 'Binop.thy'), 'theory Binop imports Main begin end\n')
  write(path.join(tmp, 'common', 'binop.ML'), 'val x = 1\n')
  write(path.join(tmp, 'common', 'notes.txt'), 'not a source\n')
  write(path.join(tmp, 'common', 'sub', 'Deep.thy'), 'theory Deep begin end\n')
  write(path.join(tmp, 'abstract', 'Sem.thy'), 'theory Sem imports Binop begin end\n')
  write(path.join(tmp, 'abstract', 'extra', 'Extra.thy'), 'theory Extra begin end\n')
  write(path.join(tmp, 'helper', 'Help.thy'), 'theory Help begin end\n')
  write(path.join(tmp, 'main', 'Results.thy'), 'theory Results imports Sem Help begin end\n')

  const names = files => files.map(f => path.relative(tmp, f).split(path.sep).join('/')).sort()

  // --- what is in the image ------------------------------------------------------------
  // -R Main2: everything it builds on, but not Main2's own theories.
  assert.deepStrictEqual(names(heapSourceFiles(sessions, 'Main2', true)), [
    'abstract/Sem.thy', 'abstract/extra/Extra.thy', 'common/Binop.thy', 'common/binop.ML',
    'helper/Help.thy'])
  pass('-R: the whole closure, parents and `sessions` imports, minus the session itself')

  // -l Main2: Main2 is in the image too.
  assert.ok(names(heapSourceFiles(sessions, 'Main2', false)).includes('main/Results.thy'))
  // -R Common: Common's parent is HOL, which is not ours to watch.
  assert.deepStrictEqual(heapSourceFiles(sessions, 'Common', true), [])
  assert.deepStrictEqual(heapSourceFiles(sessions, 'HOL', false), [])
  pass('-l includes the session; distribution sessions contribute nothing')

  // Declared directories only: a theory in an undeclared subdirectory is not the session's.
  assert.ok(!names(heapSourceFiles(sessions, 'Main2', true)).includes('common/sub/Deep.thy'))
  pass('only theories and ML in declared session directories count')

  // --- comparing against the image -----------------------------------------------------
  const files = heapSourceFiles(sessions, 'Main2', true)
  const baseline = await takeBaseline(files)
  assert.strictEqual(baseline.files.size, 5)
  const binop = path.join(tmp, 'common', 'Binop.thy')
  const original = fs.readFileSync(binop, 'utf8')

  assert.strictEqual(compare(baseline, binop, await digestFile(binop), false), undefined)
  write(binop, original.replace('end', 'lemma x: True by simp end'))
  assert.strictEqual(compare(baseline, binop, await digestFile(binop), false), 'modified')
  pass('a changed file on disk is stale')

  // Rewritten with the same content, as a checkout does: newer mtime, not stale.
  write(binop, original)
  const later = new Date(Date.now() + 60000)
  fs.utimesSync(binop, later, later)
  assert.strictEqual(compare(baseline, binop, await digestFile(binop), false), undefined)
  pass('content decides, not timestamps: a rewrite with the same text is not stale')

  // An unsaved buffer counts, and undoing the edit clears it.
  assert.strictEqual(compare(baseline, binop, digest(original + ' '), true), 'unsaved')
  assert.strictEqual(compare(baseline, binop, digest(original), true), undefined)
  pass('an unsaved edit is stale until it is undone')

  const help = path.join(tmp, 'helper', 'Help.thy')
  fs.rmSync(help)
  assert.strictEqual(await digestFile(help), undefined)
  assert.strictEqual(compare(baseline, help, undefined, false), 'deleted')
  pass('a deleted file is stale')

  // A file the image never held is never stale, whatever happens to it.
  const results = path.join(tmp, 'main', 'Results.thy')
  assert.strictEqual(compare(baseline, results, digest('anything'), false), undefined)
  const fresh = path.join(tmp, 'common', 'New.thy')
  write(fresh, 'theory New begin end\n')
  assert.strictEqual(compare(baseline, fresh, await digestFile(fresh), false), undefined)
  pass('files outside the image, including new ones, are never stale')

  // --- path identity -------------------------------------------------------------------
  assert.strictEqual(fileKey('C:\\P\\Binop.thy', 'win32'), fileKey('c:\\p\\binop.thy', 'win32'))
  assert.notStrictEqual(fileKey('/p/Binop.thy', 'linux'), fileKey('/p/binop.thy', 'linux'))
  if (process.platform === 'win32') {
    // What a watcher or an editor reports may differ in case from what readdir listed.
    assert.strictEqual(compare(baseline, binop.toUpperCase(), digest('x'), false), 'modified')
  }
  pass('paths compare case-insensitively on Windows only')

  fs.rmSync(tmp, { recursive: true, force: true })
  console.log(passed + ' checks passed')
  console.log('SUITE42_OK')
}

module.exports = { run }

if (require.main === module) {
  run().catch(err => { console.error(err); process.exit(1) })
}
