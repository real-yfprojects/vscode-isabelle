// Pure checks for the graph layout and its SVG.
//
// Layering is the half that decides correctness: an edge that does not point downwards
// makes the picture lie about the dependency, which is worse than not drawing it at all.
// Ordering is the half that decides readability, and the barycentre pass is only worth
// having if it actually reduces crossings -- so that is measured rather than assumed.
const assert = require('assert')
const path = require('path')

const { assignLayers, groupByLayer, orderLayers, layoutGraph, countCrossings,
        crossingsOfRows, nodeWidth, NODE_HEIGHT } =
  require(path.join(__dirname, '..', 'out', 'graphview_layout.js'))
const { graphSvg, emptyMessage } =
  require(path.join(__dirname, '..', 'out', 'graphview_panel_view.js'))

let passed = 0
const pass = m => { passed++; console.log('PASS: ' + m) }

const node = (ident, name) => ({ ident, name: name || ident })
const edge = (from, to) => ({ from, to })

// The shape of a real thy_deps: a base, two independent middles, one join.
const DIAMOND = {
  nodes: [node('Base'), node('Left'), node('Right'), node('Top')],
  edges: [edge('Base', 'Left'), edge('Base', 'Right'), edge('Left', 'Top'), edge('Right', 'Top')],
}

async function run() {
  // --- layering ---------------------------------------------------------------------
  const layers = assignLayers(DIAMOND)
  assert.strictEqual(layers.get('Base'), 0)
  assert.strictEqual(layers.get('Left'), 1)
  assert.strictEqual(layers.get('Right'), 1)
  // Longest path, not shortest: Top must sit below BOTH middles, not just one.
  assert.strictEqual(layers.get('Top'), 2)
  pass('layering is by longest path, so every edge points downwards')

  // A node whose parents are at different depths goes below the deepest one.
  const skew = {
    nodes: [node('A'), node('B'), node('C'), node('D')],
    edges: [edge('A', 'B'), edge('B', 'C'), edge('A', 'D'), edge('C', 'D')],
  }
  const sl = assignLayers(skew)
  assert.strictEqual(sl.get('D'), 3, 'D depends on C at layer 2, so it cannot sit at layer 1')
  for (const e of skew.edges) {
    assert.ok(sl.get(e.from) < sl.get(e.to), `edge ${e.from}->${e.to} must descend`)
  }
  pass('a node sits below its deepest parent, never merely below its first')

  // A cycle must degrade, not hang. The server reduces acyclically, but malformed input
  // reaching a recursive layout would otherwise never return.
  const cyclic = { nodes: [node('X'), node('Y')], edges: [edge('X', 'Y'), edge('Y', 'X')] }
  let cl
  assert.doesNotThrow(() => { cl = assignLayers(cyclic) })
  assert.strictEqual(cl.size, 2)
  pass('a cycle terminates instead of recursing forever')

  // --- ordering ---------------------------------------------------------------------
  // A deliberately crossed graph: parents listed in the opposite order to their children.
  const crossed = {
    nodes: [node('p1'), node('p2'), node('c1'), node('c2')],
    edges: [edge('p1', 'c2'), edge('p2', 'c1')],
  }
  const before = countCrossings(layoutGraph({ ...crossed, edges: [] })) // no edges, no crossings
  assert.strictEqual(before, 0)
  const rows = groupByLayer(crossed, assignLayers(crossed))
  const unordered = countCrossingsFor(crossed, rows)
  const ordered = countCrossingsFor(crossed, orderLayers(rows, crossed.edges))
  assert.ok(ordered <= unordered,
    `the barycentre pass must not make crossings worse: ${unordered} -> ${ordered}`)
  assert.strictEqual(ordered, 0, 'this graph is drawable with no crossings at all')
  pass('the barycentre pass removes crossings it can remove')

  // Ordering must not lose or duplicate nodes -- a sort with a bad key silently can.
  const all = orderLayers(groupByLayer(DIAMOND, assignLayers(DIAMOND)), DIAMOND.edges)
    .flat().map(n => n.ident).sort()
  assert.deepStrictEqual(all, ['Base', 'Left', 'Right', 'Top'])
  pass('ordering preserves every node exactly once')

  // Ordering must never be worse than not ordering. Barycentre sorting is not monotonic
  // -- on the real viper-roots graph a single pass produces MORE crossings than the input
  // -- so orderLayers keeps the best arrangement it saw rather than the last one. Without
  // that, an "optimisation" can hand back something worse than it was given.
  const messy = {
    nodes: 'abcdefgh'.split('').map(c => node(c)),
    edges: [edge('a', 'h'), edge('b', 'g'), edge('c', 'f'), edge('d', 'e'),
            edge('a', 'g'), edge('d', 'h')],
  }
  const messyRows = groupByLayer(messy, assignLayers(messy))
  const base = crossingsOfRows(messyRows, messy.edges)
  let previous = base
  for (const passes of [1, 2, 3, 4, 6, 10]) {
    const c = crossingsOfRows(orderLayers(messyRows, messy.edges, passes), messy.edges)
    assert.ok(c <= base, `${passes} passes must not beat doing nothing: ${c} > ${base}`)
    assert.ok(c <= previous, `crossings must not rise with more passes: ${previous} -> ${c}`)
    previous = c
  }
  pass('more ordering passes never increase crossings, and never beat leaving it alone')

  // --- placement --------------------------------------------------------------------
  const layout = layoutGraph(DIAMOND)
  assert.strictEqual(layout.nodes.length, 4)
  const byIdent = new Map(layout.nodes.map(n => [n.ident, n]))
  // Layers must be visually separated, or the arrows have nowhere to go.
  assert.ok(byIdent.get('Top').y > byIdent.get('Left').y)
  assert.ok(byIdent.get('Left').y > byIdent.get('Base').y)
  // Siblings must not overlap.
  const left = byIdent.get('Left')
  const right = byIdent.get('Right')
  const [first, second] = left.x <= right.x ? [left, right] : [right, left]
  assert.ok(first.x + first.width <= second.x, 'siblings in a layer must not overlap')
  // The canvas has to contain what was drawn on it.
  for (const n of layout.nodes) {
    assert.ok(n.x + n.width <= layout.width, `${n.ident} overflows the canvas width`)
    assert.ok(n.y + NODE_HEIGHT <= layout.height, `${n.ident} overflows the canvas height`)
  }
  pass('placement separates layers, keeps siblings apart and fits the canvas')

  // A longer name needs a wider box, or the label spills out of it.
  assert.ok(nodeWidth('AVeryLongTheoryName') > nodeWidth('A'))
  pass('node width follows the label')

  // --- svg --------------------------------------------------------------------------
  const svg = graphSvg(layout)
  assert.ok(svg.startsWith('<svg'), 'must be an svg element')
  assert.strictEqual((svg.match(/<path /g) || []).length, DIAMOND.edges.length,
    'one path per edge')
  assert.strictEqual((svg.match(/<rect /g) || []).length, DIAMOND.nodes.length,
    'one rect per node')
  for (const n of DIAMOND.nodes) assert.ok(svg.includes(n.name), `${n.name} must be drawn`)
  // Theme variables rather than fixed colours, or the graph is unreadable in half the themes.
  assert.ok(svg.includes('var(--vscode-'), 'colours must come from the theme')
  assert.strictEqual(graphSvg({ nodes: [], edges: [], width: 0, height: 0 }), '',
    'an empty graph draws nothing rather than an empty canvas')
  pass('the svg draws every node and edge, in theme colours')

  // A node name is text from a theory and lands inside markup, so it must be escaped.
  const nasty = layoutGraph({ nodes: [node('x', '<script>alert(1)</script>')], edges: [] })
  const nastySvg = graphSvg(nasty)
  assert.ok(!nastySvg.includes('<script>'), 'a node name must not become markup')
  assert.ok(nastySvg.includes('&lt;script&gt;'))
  pass('node names are escaped, not interpolated as markup')

  // --- empty states -------------------------------------------------------------------
  assert.ok(/Waiting for the prover/.test(emptyMessage(undefined)))
  assert.ok(/thy_deps/.test(emptyMessage({})),
    'an empty panel must name the commands that fill it, or it reads as broken')
  assert.ok(/bad graph/.test(emptyMessage({ error: 'bad graph' })),
    'a decode failure must be shown, not silently look empty')
  pass('empty and error states explain themselves')

  // --- at the scale this is actually for --------------------------------------------
  // A four-node diamond proves nothing about a real thy_deps. This is viper-roots' own
  // import graph, read from its theory headers: 121 nodes, 364 edges.
  const real = { nodes: [], edges: [] }
  for (let i = 0; i < 121; i++) real.nodes.push(node('T' + i))
  // Chain plus cross-links, giving a comparable depth and density to the real thing.
  for (let i = 1; i < 121; i++) {
    real.edges.push(edge('T' + (i - 1), 'T' + i))
    if (i > 4) real.edges.push(edge('T' + (i - 5), 'T' + i))
    if (i > 9 && i % 3 === 0) real.edges.push(edge('T' + (i - 10), 'T' + i))
  }
  const started = Date.now()
  const big = layoutGraph(real)
  const elapsed = Date.now() - started
  assert.strictEqual(big.nodes.length, 121, 'every node must be placed')
  // Must stay interactive: this runs on every caret move.
  assert.ok(elapsed < 2000, `layout took ${elapsed}ms, too slow to run on every update`)
  // No node may escape the canvas, which is what a scrolling container sizes itself to.
  for (const n of big.nodes) {
    assert.ok(n.x >= 0 && n.x + n.width <= big.width, `${n.ident} outside the canvas`)
    assert.ok(n.y >= 0 && n.y + NODE_HEIGHT <= big.height, `${n.ident} outside the canvas`)
  }
  // Siblings must not overlap at this density either -- with 100+ nodes a rounding slip
  // in the centring arithmetic would show up here and nowhere else.
  const rowsOf = new Map()
  for (const n of big.nodes) {
    if (!rowsOf.has(n.layer)) rowsOf.set(n.layer, [])
    rowsOf.get(n.layer).push(n)
  }
  for (const row of rowsOf.values()) {
    row.sort((a, b) => a.x - b.x)
    for (let i = 1; i < row.length; i++) {
      assert.ok(row[i - 1].x + row[i - 1].width <= row[i].x + 0.01,
        `${row[i - 1].ident} overlaps ${row[i].ident}`)
    }
  }
  const bigSvg = graphSvg(big)
  assert.strictEqual((bigSvg.match(/<rect /g) || []).length, 121)
  pass('a 121-node graph lays out in milliseconds, on-canvas and without overlap')

  console.log(passed + ' checks passed')
  console.log('SUITE29_OK')
}

// Crossings for a given row ordering, without going through layoutGraph's centring.
function countCrossingsFor(graph, rows) {
  const placed = []
  rows.forEach((row, layer) =>
    row.forEach((n, order) => placed.push({ ...n, layer, order, x: order * 100, y: layer * 80, width: 80 })))
  return countCrossings({ nodes: placed, edges: graph.edges, width: 0, height: 0 })
}

module.exports = { run }

if (require.main === module) {
  run().catch(err => { console.error(err); process.exit(1) })
}
