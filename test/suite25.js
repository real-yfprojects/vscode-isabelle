// Pure checks for ROOT parsing and the session picker -- no prover, no editor.
//
// The recommendation rule is the reason this suite exists. Picking a frontier that is
// too high does not fail loudly: the server starts, theories check, and the only symptom
// is that results above your edit quietly reflect the heap's stale copy. A test is the
// only place that stays honest about it.
const assert = require('assert')
const path = require('path')
const fs = require('fs')
const os = require('os')

const { stripComments, tokenize, parseRoot, sessionForFile, depth, orderSessions,
        isAncestor, recommendedSession, findRootFiles, readSessions,
        heapSessions, stalenessWarning, sessionDirsFor } =
  require(path.join(__dirname, '..', 'out', 'sessions.js'))
const { pickItems, statusText, statusTooltip, openSessions } =
  require(path.join(__dirname, '..', 'out', 'session_items.js'))

let passed = 0
const pass = m => { passed++; console.log('PASS: ' + m) }

// The real shape of viper-roots, which is what prompted all of this.
const VIPER = [
  { root: '/p/vipersemcommon/ROOT', text: 'session ViperCommon = "HOL" +\n  sessions\n    "HOL-Eisbach"\n  theories\n    Binop\n    SepAlgebra\n' },
  { root: '/p/vipersemabstract/ROOT', text: 'session ViperAbstract = ViperCommon +\n  theories\n    AbstractSemantics\n    Instantiation\n' },
  { root: '/p/simple-frontend/ROOT', text: 'session SimpleViperFrontEnd = ViperAbstract +\n  theories\n\tVHelper\n\tParImp\n' },
  { root: '/p/main-results/ROOT', text: 'session MainResults = ViperAbstract +\n  sessions\n    SimpleViperFrontEnd\n  theories\n    PaperResults\n' },
]

function viperSessions() {
  const out = []
  for (const r of VIPER) out.push(...parseRoot(r.text, r.root))
  return out
}

async function run() {
  // --- comments -------------------------------------------------------------------
  // ML comments nest, so a non-greedy regex would stop at the first "*)" and leak the
  // rest of the outer comment into the token stream as if it were grammar.
  assert.strictEqual(stripComments('a (* x (* y *) z *) b').replace(/\s+/g, ' ').trim(), 'a b')
  assert.strictEqual(stripComments('a (* x *) b').replace(/\s+/g, ' ').trim(), 'a b')
  // A quoted string is not a comment opener, however much it looks like one.
  assert.ok(stripComments('directories "(*odd*)"').includes('(*odd*)'))
  pass('ROOT comments nest, and quoted text is not treated as a comment')

  // --- tokens ---------------------------------------------------------------------
  const toks = tokenize('session A in "sub dir" = "HOL-Eisbach" +')
  assert.deepStrictEqual(toks.map(t => t.value),
    ['session', 'A', 'in', 'sub dir', '=', 'HOL-Eisbach', '+'])
  assert.strictEqual(toks[3].quoted, true, 'a quoted path keeps its spaces')
  assert.strictEqual(toks[5].quoted, true)
  assert.strictEqual(toks[1].quoted, false)
  pass('tokenizer separates quoted names from bare ones and keeps punctuation')

  // --- entries --------------------------------------------------------------------
  const one = parseRoot('session TotalViperDeps in TotalViperDeps = ViperCommon +\n' +
                        '  sessions\n    "HOL-Analysis"\n  theories\n    Dependencies\n',
                        '/p/viper-total-heaps/ROOT')
  assert.strictEqual(one.length, 1)
  assert.strictEqual(one[0].name, 'TotalViperDeps')
  assert.strictEqual(one[0].parent, 'ViperCommon')
  // `in DIR` moves the session's directory below the ROOT's own.
  assert.strictEqual(path.basename(one[0].dirs[0]), 'TotalViperDeps')
  pass('session entry yields name, parent and the directory named by "in"')

  // `sessions` names imports, not directories: it must not leak into dirs.
  assert.strictEqual(one[0].dirs.length, 1,
    'the "sessions" clause must not be read as a directory list')
  pass('the sessions clause is not confused with the directories clause')

  const dirs = parseRoot(
    'session Multi = P +\n  directories "a" b\n  theories T\n', '/p/x/ROOT')
  assert.strictEqual(dirs[0].dirs.length, 3)
  assert.deepStrictEqual(dirs[0].dirs.slice(1).map(d => path.basename(d)), ['a', 'b'])
  pass('directories resolve against the session directory and are all recorded')

  // A quoted keyword is a name. Reading it as a clause would truncate the list.
  const quoted = parseRoot(
    'session Q = P +\n  directories "theories" other\n  theories T\n', '/p/x/ROOT')
  assert.deepStrictEqual(quoted[0].dirs.slice(1).map(d => path.basename(d)),
    ['theories', 'other'])
  pass('a quoted keyword in a directory list is a name, not the next clause')

  // Several sessions in one ROOT, the viper-total-heaps shape.
  const many = parseRoot(
    'session A in DA = "HOL" +\n  theories T1\n\nsession B in DB = A +\n  theories T2\n',
    '/p/x/ROOT')
  assert.deepStrictEqual(many.map(s => s.name), ['A', 'B'])
  assert.strictEqual(many[1].parent, 'A')
  pass('multiple session entries in one ROOT are all found')

  // A session with no body has no "+", so nothing should be mistaken for its parent.
  const bare = parseRoot('session Solo = HOL\n', '/p/x/ROOT')
  assert.strictEqual(bare.length, 1)
  assert.strictEqual(bare[0].parent, undefined,
    'without "+" there is no parent clause to read')
  pass('a session with no body parses without inventing a parent')

  // Groups must not be mistaken for anything else.
  const grouped = parseRoot('session G (main timing) in d = HOL +\n  theories T\n', '/p/x/ROOT')
  assert.strictEqual(grouped[0].name, 'G')
  assert.strictEqual(path.basename(grouped[0].dirs[0]), 'd')
  pass('a groups clause is skipped without disturbing "in" or the parent')

  // --- file -> session ------------------------------------------------------------
  const sessions = viperSessions()
  assert.deepStrictEqual(sessions.map(s => s.name),
    ['ViperCommon', 'ViperAbstract', 'SimpleViperFrontEnd', 'MainResults'])
  const owner = sessionForFile(sessions, path.resolve('/p/vipersemabstract/Instantiation.thy'))
  assert.strictEqual(owner && owner.name, 'ViperAbstract')
  // Isabelle maps a file by its parent directory only; an unowned directory has no session.
  assert.strictEqual(sessionForFile(sessions, path.resolve('/p/elsewhere/T.thy')), undefined)
  pass('a theory is attributed to the session owning its directory')

  // --- ordering -------------------------------------------------------------------
  assert.strictEqual(depth(sessions, 'ViperCommon'), 0, 'parent HOL is outside the scan')
  assert.strictEqual(depth(sessions, 'ViperAbstract'), 1)
  assert.strictEqual(depth(sessions, 'MainResults'), 2)
  assert.deepStrictEqual(orderSessions(sessions).map(s => s.name),
    ['ViperCommon', 'ViperAbstract', 'MainResults', 'SimpleViperFrontEnd'])
  pass('sessions order parents before children, ties by name')

  assert.ok(isAncestor(sessions, 'ViperCommon', 'MainResults'))
  assert.ok(isAncestor(sessions, 'MainResults', 'MainResults'), 'a session is its own frontier')
  assert.ok(!isAncestor(sessions, 'MainResults', 'ViperCommon'))
  pass('ancestry follows the parent chain in one direction only')

  // --- the recommendation ---------------------------------------------------------
  // The whole point: with -R S everything below S is an immutable heap compiled against
  // the current text. Editing down there leaves the rest stale, so the frontier must be
  // the LOWEST session in play, never the one owning the file that happens to be focused.
  assert.strictEqual(
    recommendedSession(sessions, ['MainResults', 'ViperCommon']), 'ViperCommon',
    'editing ViperCommon forbids caching it, however high the other session sits')
  assert.strictEqual(recommendedSession(sessions, ['MainResults']), 'MainResults')
  assert.strictEqual(
    recommendedSession(sessions, ['SimpleViperFrontEnd', 'MainResults']), 'MainResults',
    'siblings resolve to the one nearer the base')
  assert.strictEqual(recommendedSession(sessions, []), undefined)
  assert.strictEqual(recommendedSession(sessions, ['Unknown']), undefined,
    'a session outside the workspace cannot be a frontier')
  pass('the recommended frontier is the lowest session being edited')

  // --- what the heap image contains -----------------------------------------------
  // The image follows BOTH edges Sessions.background follows. MainResults reaches
  // SimpleViperFrontEnd only through its `sessions` clause, so a parent-chain-only walk
  // would call it live and never warn about editing it.
  const heap = heapSessions(sessions, 'MainResults', true)
  assert.ok(heap.has('ViperCommon') && heap.has('ViperAbstract'))
  assert.ok(heap.has('SimpleViperFrontEnd'),
    'an import named by the sessions clause is in the image, not just ancestors')
  assert.ok(!heap.has('MainResults'), 'under -R the named session stays live')
  // Under -l the session itself is in the image too, so nothing is editable.
  assert.ok(heapSessions(sessions, 'MainResults', false).has('MainResults'))
  // The stock default caches no project session at all -- the original complaint.
  assert.strictEqual(heapSessions(sessions, 'HOL', false).size, 1)
  pass('the heap image follows parent and import edges, and -R exempts its own session')

  // --- the stale-edit warning -----------------------------------------------------
  const stale = stalenessWarning(
    sessions, path.resolve('/p/vipersemcommon/SepAlgebra.thy'), 'MainResults', true)
  assert.ok(stale, 'editing a theory inside the image must be reported')
  assert.strictEqual(stale.session, 'ViperCommon')
  assert.strictEqual(stale.suggested, 'ViperCommon')
  assert.ok(/nothing that imports it will see the change/.test(stale.message))
  pass('editing a theory inside the heap image is reported with the frontier to move to')

  // The live session is the whole point of -R: editing it must stay silent.
  assert.strictEqual(
    stalenessWarning(sessions, path.resolve('/p/main-results/PaperResults.thy'),
                     'MainResults', true),
    undefined, 'the session named by -R is live, so editing it is exactly right')
  // Under -l even that is baked, and editing it achieves nothing.
  assert.ok(stalenessWarning(sessions, path.resolve('/p/main-results/PaperResults.thy'),
                             'MainResults', false))
  pass('-R leaves its own session editable; -l does not, and says so')

  // A file belonging to no scanned session cannot be judged, so must not be warned about.
  assert.strictEqual(
    stalenessWarning(sessions, path.resolve('/p/nowhere/X.thy'), 'MainResults', true),
    undefined)
  // Nor may a session above the frontier be warned about: it was never in the image.
  assert.strictEqual(
    stalenessWarning(sessions, path.resolve('/p/main-results/PaperResults.thy'),
                     'ViperAbstract', true),
    undefined, 'a session above the frontier is live and needs no warning')
  pass('files outside the image, or above the frontier, raise no warning')

  // The suggestion must clear every open session at once, not just the edited file's,
  // or accepting it would produce the same warning again on the next file.
  const together = stalenessWarning(
    sessions, path.resolve('/p/vipersemabstract/Instantiation.thy'), 'MainResults', true,
    ['ViperCommon'])
  assert.strictEqual(together.session, 'ViperAbstract')
  assert.strictEqual(together.suggested, 'ViperCommon',
    'the frontier must drop below every open session, not only the edited one')
  pass('the suggested frontier clears all open sessions in one move')

  // --- picker rendering -----------------------------------------------------------
  const items = pickItems(sessions, ['MainResults', 'ViperCommon'], 'HOL')
  const names = items.map(i => i.session)
  assert.deepStrictEqual(names,
    ['ViperCommon', 'ViperAbstract', 'MainResults', 'SimpleViperFrontEnd', 'HOL'])
  assert.ok(items.every(i => i.session === 'HOL' || i.requirements === true),
    'a project session is only useful with -R; -l would bake its own theories in too')
  const rec = items.find(i => i.session === 'ViperCommon')
  assert.ok(rec.detail && rec.detail.includes('recommended'))
  // The star is the marker: exactly one row carries it, so it cannot read as decoration.
  assert.strictEqual(rec.icon, 'recommended')
  assert.strictEqual(items.filter(i => i.icon === 'recommended').length, 1)
  const other = items.find(i => i.session === 'MainResults')
  assert.ok(other.detail && other.detail.includes('open in an editor'))
  assert.ok(!other.detail.includes('recommended'), 'only one session is recommended')
  assert.strictEqual(other.icon, 'session')
  // Labels are plain names now that the icon carries the marking; a leftover inline
  // codicon would draw a second glyph next to the real one.
  assert.ok(items.every(i => !i.label.includes('$(')),
    'the icon is iconPath, not a codicon baked into the label')
  pass('the pick list is dependency-ordered and stars exactly the recommended frontier')

  // HOL must stay reachable, and must say plainly that it caches nothing.
  const hol = items[items.length - 1]
  assert.strictEqual(hol.session, 'HOL')
  assert.strictEqual(hol.requirements, false)
  // This list was built with HOL in force, so HOL carries the check rather than the
  // circle-slash; the slash is for when some project session is the current one.
  assert.strictEqual(hol.icon, 'current')
  assert.strictEqual(
    pickItems(sessions, [], 'ViperAbstract').find(i => i.session === 'HOL').icon, 'uncached')
  assert.ok(/checked from source/.test(hol.detail))
  pass('the uncached HOL image stays selectable and is labelled as caching nothing')

  // The current session is marked wherever it sits in the order.
  const marked = pickItems(sessions, [], 'ViperAbstract').find(i => i.session === 'ViperAbstract')
  assert.strictEqual(marked.icon, 'current')
  assert.ok(marked.detail.includes('current'))
  pass('the session in force is marked in the list')

  // Precedence: a session that is both recommended and current keeps the star, because
  // "this is the one to choose" is the only thing the row adds -- the status bar and the
  // detail both already say which session is in force.
  const both = pickItems(sessions, ['ViperCommon'], 'ViperCommon')
    .find(i => i.session === 'ViperCommon')
  assert.strictEqual(both.icon, 'recommended')
  assert.ok(both.detail.includes('recommended') && both.detail.includes('current'))
  pass('the star outranks the check when a session is both')

  // --- status bar -----------------------------------------------------------------
  assert.ok(statusText('MainResults', true).includes('MainResults'))
  assert.ok(!statusText('MainResults', true).includes('uncached'))
  assert.ok(statusText('HOL', false).includes('uncached'),
    'the default must look wrong at a glance, because it is')
  assert.ok(/not re-checked/.test(statusTooltip('MainResults', true)))
  assert.ok(/checked from source/.test(statusTooltip('HOL', false)))
  pass('the status bar distinguishes a caching session from an uncached one')

  // --- making a discovered session actually resolvable ----------------------------
  // A ROOT under the workspace is invisible to Isabelle unless its directory is a
  // component, is in a ROOTS catalogue, or is passed with -d. Two of viper-roots' own
  // sessions are invisible for that reason, so the picker must register the directory or
  // it would offer a choice that fails at startup.
  assert.deepStrictEqual(
    sessionDirsFor(sessions, 'MainResults', []).map(d => path.basename(d)),
    ['main-results'])
  // Redundant entries would still work (Isabelle dedupes ROOTs by canonical file) but
  // rewriting settings on every pick is noise.
  const already = sessionDirsFor(sessions, 'MainResults', [])
  assert.strictEqual(sessionDirsFor(sessions, 'MainResults', already).length, 1,
    'a directory already configured is not added twice')
  assert.deepStrictEqual(sessionDirsFor(sessions, 'HOL', ['/x']), ['/x'],
    'a session outside the workspace contributes no directory')
  pass('the chosen session gets its ROOT directory registered, without duplicates')

  // --- discovery on a real tree ---------------------------------------------------
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'isa-roots-'))
  fs.mkdirSync(path.join(tmp, 'a'), { recursive: true })
  fs.mkdirSync(path.join(tmp, 'node_modules', 'deep'), { recursive: true })
  fs.writeFileSync(path.join(tmp, 'a', 'ROOT'), 'session Disc = "HOL" +\n  theories T\n')
  fs.writeFileSync(path.join(tmp, 'node_modules', 'deep', 'ROOT'), 'session Nope = "HOL"\n')
  const roots = findRootFiles([tmp])
  assert.strictEqual(roots.length, 1, 'node_modules must not be walked')
  const discovered = readSessions([tmp])
  assert.deepStrictEqual(discovered.map(s => s.name), ['Disc'])
  // A file in the discovered directory maps back to it.
  const back = sessionForFile(discovered, path.join(tmp, 'a', 'T.thy'))
  assert.strictEqual(back && back.name, 'Disc')
  pass('ROOT discovery walks the workspace, skips vendor directories and round-trips')

  // openSessions is the bridge from open editors to the recommendation.
  assert.deepStrictEqual(
    openSessions(sessions, [path.resolve('/p/main-results/PaperResults.thy'),
                            path.resolve('/p/vipersemcommon/SepAlgebra.thy'),
                            path.resolve('/p/nowhere/X.thy')]).sort(),
    ['MainResults', 'ViperCommon'])
  pass('open editors map to their sessions, ignoring files outside every session')

  // A malformed ROOT must not take the picker down with it.
  const broken = fs.mkdtempSync(path.join(os.tmpdir(), 'isa-bad-'))
  fs.writeFileSync(path.join(broken, 'ROOT'), 'session (* unterminated\n')
  assert.doesNotThrow(() => readSessions([broken]))
  pass('a malformed ROOT is skipped rather than thrown')

  console.log(passed + ' checks passed')
  console.log('SUITE25_OK')
}

module.exports = { run }

if (require.main === module) {
  run().catch(err => { console.error(err); process.exit(1) })
}
