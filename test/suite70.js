// Pure checks for the client-side rendering of Isabelle2026 prover output -- no prover, no
// editor. Isabelle2026's server sends the Output and State panels unformatted YXML and
// leaves formatting to the client; pretty.ts and pide_html.ts port Isabelle's own
// Pretty.formatted and Browser_Info.make_html for that.
//
// The fixtures are Isabelle2026's own: test/fixtures/pide/<name>.yxml is prover output
// captured from a theory, and <name>.<margin>.formatted.yxml / .html what Isabelle/Scala
// makes of it (scripts/gen-pide-fixtures.sh). Formatting must agree exactly; the HTML in
// its tags, classes and text, since the links and buttons carry attributes of our own.
const assert = require('assert')
const fs = require('fs')
const path = require('path')

const out = path.join(__dirname, '..', 'out')
const { parseYxml, yxmlOfBody, xmlOfBody, content, isYxml } = require(path.join(out, 'yxml.js'))
const { formatted, separate, symbolMetric } = require(path.join(out, 'pretty.js'))
const { makeHtml, renderPideOutput, textHtml, decodeActive } = require(path.join(out, 'pide_html.js'))
const { SymbolTable } = require(path.join(out, 'symbols.js'))

const FIXTURES = path.join(__dirname, 'fixtures', 'pide')
const MARGINS = [20, 40, 76, 120]

let passed = 0
const pass = m => { passed++; console.log('PASS: ' + m) }

const table = SymbolTable.parse(fs.readFileSync(path.join(FIXTURES, 'symbols'), 'utf8'))
const glyphs = s => table.glyphOf(s)

const decodeEntities = s => s
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&apos;/g, "'").replace(/&amp;/g, '&')

/** Tags with their class, and text, as a list: what the page shows and how it is styled.
    The `typing` spans that hold a type as a title are ours alone, and left out. */
function tokens(html) {
  const result = []
  const dropped = []
  const re = /<(\/?)([A-Za-z][A-Za-z0-9_]*)([^>]*?)(\/?)>|([^<]+)/g
  let m
  while ((m = re.exec(html))) {
    if (m[5] !== undefined) {
      const text = decodeEntities(m[5])
      if (result.length && result[result.length - 1].startsWith('text:')) result[result.length - 1] += text
      else result.push('text:' + text)
      continue
    }
    const [, close, name, attrs, selfClose] = m
    if (close) {
      if (dropped.pop()) continue
      result.push(`</${name}>`)
      continue
    }
    const cls = /class="([^"]*)"/.exec(attrs)?.[1] ?? ''
    if (cls === 'typing') { if (!selfClose) dropped.push(true); continue }
    result.push(`<${name}${cls ? '.' + cls : ''}>`)
    if (selfClose) result.push(`</${name}>`)
    else dropped.push(false)
  }
  return result
}

function firstDifference(a, b) {
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return `at ${i}: ${JSON.stringify(a[i])} vs ${JSON.stringify(b[i])}`
  return `lengths ${a.length} vs ${b.length}`
}

async function run() {
  const samples = fs.readdirSync(FIXTURES)
    .filter(f => f.endsWith('.yxml') && !f.includes('.formatted.'))
    .map(f => f.slice(0, -'.yxml'.length))
  assert.ok(samples.length >= 6, `fixtures present (${samples.join(', ')})`)

  for (const name of samples) {
    const source = fs.readFileSync(path.join(FIXTURES, `${name}.yxml`), 'utf8')
    const messages = parseYxml(source)
    assert.strictEqual(yxmlOfBody(messages), source, `${name}: YXML round trip`)
    for (const margin of MARGINS) {
      const expected = fs.readFileSync(path.join(FIXTURES, `${name}.${margin}.formatted.yxml`), 'utf8')
      const ours = formatted(separate(messages), { margin })
      const oursYxml = yxmlOfBody(ours)
      if (oursYxml !== expected) {
        const e = expected.replace(/\x05/g, '<').replace(/\x06/g, '|')
        const o = oursYxml.replace(/\x05/g, '<').replace(/\x06/g, '|')
        let i = 0
        while (i < e.length && e[i] === o[i]) i++
        assert.fail(`${name} @${margin}: formatting differs at ${i}:\n  isabelle ${JSON.stringify(e.slice(Math.max(0, i - 60), i + 60))}\n  ours     ${JSON.stringify(o.slice(Math.max(0, i - 60), i + 60))}`)
      }
      const expectedHtml = tokens(fs.readFileSync(path.join(FIXTURES, `${name}.${margin}.html`), 'utf8'))
      const oursHtml = tokens(makeHtml(ours, glyphs))
      assert.deepStrictEqual(oursHtml, expectedHtml,
        `${name} @${margin}: HTML differs ${firstDifference(oursHtml, expectedHtml)}`)
    }
    pass(`${name}: formatting and HTML agree with Isabelle2026 at margins ${MARGINS.join(', ')}`)
  }

  // A narrow margin really wraps, and a wide one does not: the comparison above would
  // also pass if both sides ignored the margin.
  {
    const source = fs.readFileSync(path.join(FIXTURES, 'goal.yxml'), 'utf8')
    const lines = margin => content(formatted(separate(parseYxml(source)), { margin })).split('\n').length
    assert.ok(lines(20) > lines(120), `goal wraps more at 20 (${lines(20)}) than at 120 (${lines(120)})`)
    pass('the margin changes where lines break')
  }

  // Sendback and dialog become buttons that carry the element back to the server.
  {
    const html = renderPideOutput(fs.readFileSync(path.join(FIXTURES, 'sendback.yxml'), 'utf8'), 76, glyphs)
    const args = [...html.matchAll(/class="active" data-command="markupAction" data-arg="([^"]*)"/g)].map(m => m[1])
    assert.strictEqual(args.length, 2, 'two sendbacks')
    const active = decodeActive(args[0])
    const [elem] = parseYxml(active)
    assert.strictEqual(elem.name, 'sendback')
    assert.ok(elem.props.some(([a]) => a === 'id'), 'the sendback carries its command id')
    assert.strictEqual(content([elem]), 'by (simp add: algebra_simps)')
    pass('a sendback is a button carrying the element and its text')

    const dialog = renderPideOutput(fs.readFileSync(path.join(FIXTURES, 'dialog.yxml'), 'utf8'), 76, glyphs)
    const choices = [...dialog.matchAll(/data-command="markupAction" data-arg="([^"]*)"/g)]
      .map(m => parseYxml(decodeActive(m[1]))[0])
    assert.deepStrictEqual(choices.map(e => e.props.find(([a]) => a === 'result')[1]),
      ['Stop', '100', '1000', '10000'])
    assert.ok(choices.every(e => e.name === 'dialog' && e.props.some(([a]) => a === 'serial')),
      'each choice carries the dialog serial')
    pass('a dialog offers each of its answers as a button')
  }

  // Entities link to their definitions through the server, which maps def_file.
  {
    const html = renderPideOutput(fs.readFileSync(path.join(FIXTURES, 'subscripts.yxml'), 'utf8'), 76, glyphs)
    const link = /data-command="gotoSource" data-arg="([^"]*)"/.exec(html)
    assert.ok(link, 'a constant links to its definition')
    const arg = JSON.parse(link[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&'))
    assert.ok(arg.file && arg.line > 0, `with file and line: ${link[1]}`)
    assert.ok(html.includes('class="typing" title=":: '), 'a typed atom carries its type as a title')
    assert.ok(/x<sub>1<\/sub>/.test(html), `\\<^sub> renders as <sub>: ${html.slice(0, 300)}`)
    assert.ok(html.includes('∀'), 'symbols render as glyphs')
    pass('entities link, types show as titles, subscripts and symbols render')
  }

  // Text is never markup.
  {
    assert.strictEqual(textHtml('<script>alert(1)</script> & \\<forall>', glyphs),
      '&lt;script&gt;alert(1)&lt;/script&gt; &amp; ∀')
    assert.strictEqual(textHtml('x\\<^sub>i\\<^sup>2 \\<^bold>b', glyphs), 'x<sub>i</sub><sup>2</sup> <b>b</b>')
    assert.strictEqual(textHtml('a\\<^bsub>ij\\<^esub>', glyphs), 'a<sub>ij</sub>')
    assert.strictEqual(textHtml('a\\<^bsub>unbalanced', glyphs), 'a⇘unbalanced')
    pass('text is escaped, control symbols become sub/sup/b')
  }

  // Formats tell themselves apart, and malformed input does not throw.
  {
    assert.ok(isYxml('\x05\x06writeln_message\x05hi\x05\x06\x05'))
    assert.ok(!isYxml('<span class="writeln_message">hi</span>'))
    // Unbalanced: shown as all its text, the element name included, rather than lost.
    assert.strictEqual(renderPideOutput('\x05\x06broken\x05text', 76, glyphs), 'brokentext')
    assert.strictEqual(xmlOfBody(parseYxml('\x05\x06a\x06x=1"<\x05t&\x05\x06\x05')), '<a x="1&quot;&lt;">t&amp;</a>')
    // \<long...> arrows are two wide, control symbols take no width.
    assert.strictEqual(symbolMetric('\\<longrightarrow>x\\<^sub>1'), 4)
    pass('YXML is told from HTML, malformed YXML shows as text, XML is escaped')
  }

  console.log(`\n${passed} checks passed`)
  console.log('SUITE70_OK')
}

run().catch(err => { console.error('FAIL:', err.message ?? err); process.exit(1) })
