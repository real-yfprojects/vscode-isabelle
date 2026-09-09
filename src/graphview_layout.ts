/* Laying out a dependency DAG, for the Graphview panel.
 *
 * Isabelle has a layout engine already (src/Tools/Graphview/layout.scala), but it is
 * Swing-bound and produces coordinates for a Java2D canvas, so it cannot be reused here.
 * This is a layered ("Sugiyama-lite") layout, which is the right family for what these
 * graphs are: thy_deps, class_deps, locale_deps and thm_deps are all dependency DAGs that
 * a reader wants to see flowing in one direction, imports at the top.
 *
 * The two steps that matter are layering and ordering. Layering is the easy half and
 * decides correctness -- an edge must always point downwards or the picture lies about
 * the dependency. Ordering within a layer is the half that decides readability, and it is
 * NP-hard done properly, so this uses the standard barycentre heuristic: repeatedly place
 * each node at the average position of its neighbours in the layer above. A handful of
 * passes gets most of the crossing reduction that is available.
 *
 * No vscode import, so all of this is testable under plain node.
 */

export interface GraphNode { ident: string; name: string; content?: string }
export interface GraphEdge { from: string; to: string }
export interface Graph { nodes: GraphNode[]; edges: GraphEdge[] }

export interface Placed extends GraphNode {
  layer: number
  order: number
  x: number
  y: number
  width: number
}

export interface Layout {
  nodes: Placed[]
  edges: GraphEdge[]
  width: number
  height: number
}

export const NODE_HEIGHT = 24
export const LAYER_GAP = 56
export const NODE_GAP = 24
const CHAR_WIDTH = 7.2
const PADDING = 16

/** Roughly how wide a label renders; exact metrics would need the DOM. */
export function nodeWidth(name: string): number {
  return Math.max(48, Math.round(name.length * CHAR_WIDTH) + 16)
}

/**
 * Assign each node to a layer: one below its deepest parent.
 *
 * Longest-path layering, so every edge points strictly downwards. Nodes in a cycle
 * cannot satisfy that; the server sends `transitive_reduction_acyclic` output so cycles
 * should not arrive, but a cycle here must degrade rather than hang, hence the visited
 * set rather than a bare recursion.
 */
export function assignLayers(graph: Graph): Map<string, number> {
  const parents = new Map<string, string[]>()
  for (const n of graph.nodes) parents.set(n.ident, [])
  for (const e of graph.edges) parents.get(e.to)?.push(e.from)

  const layer = new Map<string, number>()
  const visiting = new Set<string>()

  const depth = (ident: string): number => {
    const known = layer.get(ident)
    if (known !== undefined) return known
    // A cycle: stop rather than recurse forever, and let the node sit at the top.
    if (visiting.has(ident)) return 0
    visiting.add(ident)
    const ps = parents.get(ident) ?? []
    const d = ps.length === 0 ? 0 : Math.max(...ps.map(p => depth(p) + 1))
    visiting.delete(ident)
    layer.set(ident, d)
    return d
  }

  for (const n of graph.nodes) depth(n.ident)
  return layer
}

/** Nodes grouped by layer, each in input order to start with. */
export function groupByLayer(graph: Graph, layers: Map<string, number>): GraphNode[][] {
  const max = Math.max(0, ...[...layers.values()])
  const rows: GraphNode[][] = Array.from({ length: max + 1 }, () => [])
  for (const n of graph.nodes) rows[layers.get(n.ident) ?? 0].push(n)
  return rows
}

/**
 * Reduce edge crossings by the barycentre heuristic.
 *
 * Each pass sorts a layer by the mean position of its parents in the layer above. Four
 * passes is where the returns flatten for graphs of this size; the exact optimum is
 * NP-hard and not worth chasing for a picture.
 */
export function orderLayers(rows: GraphNode[][], edges: GraphEdge[], passes = 4): GraphNode[][] {
  const parents = new Map<string, string[]>()
  for (const e of edges) {
    const list = parents.get(e.to)
    if (list === undefined) parents.set(e.to, [e.from])
    else list.push(e.from)
  }

  let ordered = rows.map(r => [...r])
  for (let pass = 0; pass < passes; pass++) {
    const position = new Map<string, number>()
    ordered.forEach(row => row.forEach((n, i) => position.set(n.ident, i)))

    ordered = ordered.map((row, layer) => {
      if (layer === 0) return row
      const key = (n: GraphNode): number => {
        const ps = (parents.get(n.ident) ?? [])
          .map(p => position.get(p))
          .filter((v): v is number => v !== undefined)
        // A node with no parent in the layer above keeps its place rather than jumping
        // to the left edge, which is what sorting an empty mean would do.
        return ps.length === 0 ? (position.get(n.ident) ?? 0) : ps.reduce((a, b) => a + b, 0) / ps.length
      }
      return [...row].sort((a, b) => key(a) - key(b))
    })
  }
  return ordered
}

/** Place nodes on a canvas, each layer centred on the widest one. */
export function layoutGraph(graph: Graph): Layout {
  if (graph.nodes.length === 0) return { nodes: [], edges: [], width: 0, height: 0 }

  const layers = assignLayers(graph)
  const rows = orderLayers(groupByLayer(graph, layers), graph.edges)

  const rowWidths = rows.map(row =>
    row.reduce((sum, n) => sum + nodeWidth(n.name), 0) + Math.max(0, row.length - 1) * NODE_GAP)
  const widest = Math.max(...rowWidths, 1)

  const placed: Placed[] = []
  rows.forEach((row, layer) => {
    let x = PADDING + (widest - rowWidths[layer]) / 2
    row.forEach((n, order) => {
      const width = nodeWidth(n.name)
      placed.push({
        ...n, layer, order, width,
        x,
        y: PADDING + layer * (NODE_HEIGHT + LAYER_GAP),
      })
      x += width + NODE_GAP
    })
  })

  return {
    nodes: placed,
    edges: graph.edges,
    width: widest + 2 * PADDING,
    height: rows.length * NODE_HEIGHT + Math.max(0, rows.length - 1) * LAYER_GAP + 2 * PADDING,
  }
}

/** Count edges that cross, for judging whether the ordering is doing anything. */
export function countCrossings(layout: Layout): number {
  const at = new Map(layout.nodes.map(n => [n.ident, n]))
  let crossings = 0
  const edges = layout.edges
    .map(e => ({ from: at.get(e.from), to: at.get(e.to) }))
    .filter(e => e.from !== undefined && e.to !== undefined) as
      { from: Placed; to: Placed }[]

  for (let i = 0; i < edges.length; i++) {
    for (let j = i + 1; j < edges.length; j++) {
      const a = edges[i]
      const b = edges[j]
      // Only edges spanning the same pair of layers can cross in this drawing.
      if (a.from.layer !== b.from.layer || a.to.layer !== b.to.layer) continue
      if ((a.from.x - b.from.x) * (a.to.x - b.to.x) < 0) crossings++
    }
  }
  return crossings
}
