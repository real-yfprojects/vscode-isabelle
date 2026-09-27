// Pure checks for the Get Started walkthrough -- no prover, no editor.
//
// A walkthrough fails quietly: a missing media file shows an empty pane, a button naming
// a command that does not exist does nothing when clicked, and a step whose completion
// event names a view that is not there never ticks. None of it is reported anywhere, so
// every reference in the contribution is checked against package.json here.
const assert = require('assert')
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const { ANCHORS, anchorPosition, TUTORIAL_FILE } = require(path.join(ROOT, 'out', 'tutorial.js'))

let passed = 0
const pass = m => { passed++; console.log('PASS: ' + m) }

/** Commands a button may run that the extension does not contribute. */
const BUILTIN = new Set(['workbench.action.openSettings', 'workbench.action.reloadWindow'])

async function run() {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
  const c = pkg.contributes
  const [walkthrough] = c.walkthroughs
  assert.strictEqual(walkthrough.id, 'gettingStarted', 'isabelle.gettingStarted opens it by this id')

  const steps = new Map(walkthrough.steps.map(step => [step.id, step]))
  for (const [step, command] of [
    ['isabelle', 'isabelle.checkInstallation'],
    ['infoview', 'isabelle.infoview'],
    ['prove', 'isabelle.sledgehammer'],
    ['sessions', 'isabelle.selectTutorialSession'],
  ]) {
    assert.ok(steps.get(step).completionEvents.includes(`onCommand:${command}`),
      `${step}: clicking ${command} completes the step`)
  }
  pass('action buttons have matching command completion events')
  assert.ok(steps.get('restart').completionEvents.includes('onCommand:workbench.action.reloadWindow'),
    'restart: reloading VS Code completes the step')
  assert.ok(steps.get('tutorial').completionEvents.includes('onContext:isabelle.tutorialOpened'),
    'tutorial: opening the tutorial sets a completion context')
  assert.ok(steps.get('extendedServer').completionEvents.includes(
    'onContext:isabelle.extendedServerEnabled == true'),
  'extended server: an already-enabled setting completes the step')
  pass('restart and tutorial completion events are declared')
  assert.ok(fs.existsSync(path.join(ROOT, 'media', 'walkthrough', 'ROOT')), 'tutorial ROOT exists')
  pass('the tutorial includes a ROOT session definition')

  const commands = new Set(c.commands.map(x => x.command))
  const views = new Set(Object.values(c.views).flat().map(v => v.id))
  const settings = new Set(Object.keys(c.configuration.properties))
  for (const id of ['isabelle.gettingStarted', 'isabelle.openTutorial', 'isabelle.checkInstallation',
                    'isabelle.revealFonts', 'isabelle.useIsabelleFont']) {
    assert.ok(commands.has(id), `${id} is contributed`)
  }
  pass('the walkthrough and its commands are contributed')

  // --- media ------------------------------------------------------------------------
  const markdown = []
  for (const step of walkthrough.steps) {
    const m = step.media
    const files = m.markdown ? [m.markdown] : Object.values(m.image)
    if (m.image) assert.ok(m.altText, `${step.id}: an image needs alt text`)
    for (const f of files) {
      assert.ok(fs.existsSync(path.join(ROOT, f)), `${step.id}: ${f} exists`)
      // .vscodeignore keeps media/, which is what puts these in the package.
      assert.ok(f.startsWith('media/'), `${step.id}: ${f} is packaged`)
    }
    if (m.markdown) markdown.push([step.id, fs.readFileSync(path.join(ROOT, m.markdown), 'utf8')])
  }
  pass('every media file exists and is packaged')

  // --- buttons and links ------------------------------------------------------------
  let links = 0
  const texts = [...walkthrough.steps.map(s => [s.id, s.description]), ...markdown]
  for (const [id, text] of texts) {
    for (const [, target] of text.matchAll(/\]\((command:[^)]+)\)/g)) {
      links++
      const m = /^command:(?:toSide:)?([\w.-]+)(?:\?(.*))?$/.exec(target)
      assert.ok(m, `${id}: ${target} is a command link`)
      const [, command, query] = m
      const focus = /^(.*)\.focus$/.exec(command)
      assert.ok(commands.has(command) || BUILTIN.has(command) || (focus && views.has(focus[1])),
        `${id}: ${command} exists`)
      if (query !== undefined) {
        const args = JSON.parse(decodeURIComponent(query))
        assert.ok(Array.isArray(args), `${id}: arguments of ${command} are a JSON array`)
        if (command === 'isabelle.openTutorial') {
          assert.ok(ANCHORS[args[0]], `${id}: tutorial section ${args[0]} has an anchor`)
        }
        if (command === 'workbench.action.openSettings' && !args[0].startsWith('@')) {
          assert.ok(settings.has(args[0]), `${id}: setting ${args[0]} exists`)
        }
      }
    }
  }
  assert.ok(links >= 15, `found ${links} command links`)
  pass(`all ${links} command links name a command, view or setting that exists`)

  for (const step of walkthrough.steps) {
    for (const event of step.completionEvents ?? []) {
      const [kind, ...rest] = event.split(':')
      const target = rest.join(':')
      if (kind === 'onCommand') assert.ok(commands.has(target) || BUILTIN.has(target), `${step.id}: ${event}`)
      else if (kind === 'onView') assert.ok(views.has(target), `${step.id}: ${event}`)
      else if (kind === 'onSettingChanged') assert.ok(settings.has(target), `${step.id}: ${event}`)
      else assert.ok(['onContext', 'onStepSelected', 'onLink'].includes(kind), `${step.id}: ${event}`)
    }
  }
  pass('every completion event can fire')

  // --- the tutorial theory ----------------------------------------------------------
  const theory = fs.readFileSync(path.join(ROOT, 'media', 'walkthrough', TUTORIAL_FILE), 'utf8')
  assert.ok(/^[\x00-\x7f]*$/.test(theory), 'isabelle build rejects literal Unicode')
  assert.ok(theory.startsWith(`theory ${path.basename(TUTORIAL_FILE, '.thy')}\n`),
    'the theory is named after its file')
  for (const [section, { needle }] of Object.entries(ANCHORS)) {
    assert.strictEqual(theory.split(needle).length - 1, 1, `${section}: "${needle}" occurs once`)
  }
  pass('Tutorial.thy is ASCII, named after its file, and has each anchor exactly once')

  const text = 'a\nb \\<forall>x::nat c\n'
  assert.deepStrictEqual(anchorPosition(text, 'symbols'), { line: 1, character: 5 })
  assert.strictEqual(anchorPosition(text, 'goals'), undefined)
  assert.strictEqual(anchorPosition(text, 'nonsense'), undefined)
  const sorry = anchorPosition(theory, 'sledgehammer')
  assert.strictEqual(theory.split('\n')[sorry.line].slice(sorry.character),
    'lemma "distinct xs \\<Longrightarrow> card (set xs) = length xs"')
  pass('anchorPosition finds the cursor position, and nothing for a missing anchor')

  console.log(passed + ' checks passed')
  console.log('SUITE46_OK')
}

module.exports = { run }

if (require.main === module) {
  run().catch(err => { console.error(err); process.exit(1) })
}
