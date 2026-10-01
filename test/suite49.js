// Pure checks for how the Query and Sledgehammer panels render prover output -- no
// prover, no editor. The renderer runs in their webviews; here it builds stand-in nodes.
//
// The failure being held down: a wrapped element (xml_elem) carries a second body,
// xml_body, that is data rather than text -- for a type variable, its sort. Rendered as
// text, `rev (rev _)` in a Find Theorems result read
// `type?'b list ⇒ type?'b listrev (type?'b list ⇒ type?'b listrev type?'b list_)`.
const assert = require('assert')
const path = require('path')

const { markupText, renderMarkup } = require(path.join(__dirname, '..', 'out', 'markup_render.js'))

let passed = 0
const pass = m => { passed++; console.log('PASS: ' + m) }

// Parsed XML, as DOMParser hands it to the webview.
const txt = value => ({ nodeType: 3, nodeName: '#text', nodeValue: value, childNodes: [] })
const el = (name, ...children) => ({ nodeType: 1, nodeName: name, nodeValue: null, childNodes: children })

// The DOM the webview builds, reduced to what can be asserted on.
const doc = {
  createElement: tag => ({
    tag, className: '', textContent: null, children: [], listeners: {},
    appendChild(c) { this.children.push(c) },
    addEventListener(type, f) { this.listeners[type] = f },
  }),
  createTextNode: text => ({ text, appendChild() { throw new Error('a text node has no children') } }),
}
const shown = n => n.text ?? (n.tag === 'button' ? n.textContent : n.children.map(shown).join(''))
const find = (n, pred) => pred(n) ? n : (n.children ?? []).map(c => find(c, pred)).find(Boolean)

/** `?'b`, wrapped with its sort as the prover prints a schematic type variable. */
const tvar = () => el('xml_elem',
  el('xml_body', el('block', el('entity', el('tclass', txt('type'))))),
  el('block', el('block', el('tvar', txt("?'b")))))

async function run() {
  // find_theorems "rev (rev _)": the criterion as it comes back, cut down to one list type.
  const output = el('root', el('writeln_message',
    el('keyword1', txt('find_theorems')), txt(' "'),
    el('notation', tvar(), txt(' '), el('entity', el('tconst', txt('list')))),
    el('break', txt(' ')), el('entity', el('const', txt('rev'))), txt('"')))

  assert.strictEqual(markupText(output), `find_theorems "?'b list rev"`)
  const out = doc.createElement('pre')
  renderMarkup(output, out, doc)
  assert.strictEqual(shown(out), `find_theorems "?'b list rev"`)
  pass('the data half of a wrapped element is not shown')

  assert.ok(find(out, n => n.className === 'keyword1'), 'markup names become classes')
  assert.ok(find(out, n => n.className === 'tvar' && shown(n) === "?'b"),
    'the shown half of a wrapped element keeps its markup')
  assert.ok(!find(out, n => n.className === 'xml_body'))
  pass('everything else is a span classed by its markup name')

  // A Sledgehammer proof to click in: the button's text is what gets inserted.
  const suggestion = el('root', el('writeln_message', txt('e: Try this: '),
    el('sendback', txt('by (metis '), el('xml_elem', el('xml_body', txt('nat')), el('free', txt('x'))),
      txt(' foo)')), txt(' (12 ms)')))
  const sent = []
  const out2 = doc.createElement('pre')
  renderMarkup(suggestion, out2, doc, text => sent.push(text))
  const button = find(out2, n => n.tag === 'button')
  assert.strictEqual(button.className, 'sendback')
  assert.strictEqual(button.textContent, 'by (metis x foo)')
  button.listeners.click()
  assert.deepStrictEqual(sent, ['by (metis x foo)'], 'a click inserts the proof as shown')
  pass('a sendback is a button that inserts its shown text')

  // The Query panel passes no handler: there a sendback is just text in a span.
  const out3 = doc.createElement('pre')
  renderMarkup(suggestion, out3, doc)
  assert.ok(!find(out3, n => n.tag === 'button'))
  assert.strictEqual(shown(out3), 'e: Try this: by (metis x foo) (12 ms)')
  pass('without a handler a sendback is ordinary text')

  console.log(passed + ' checks passed')
  console.log('SUITE49_OK')
}

module.exports = { run }

if (require.main === module) {
  run().catch(err => { console.error(err); process.exit(1) })
}
