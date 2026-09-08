/* Theory structure: outline, breadcrumbs, folding, sticky scroll.
 *
 * The language server advertises hoverProvider, definitionProvider,
 * documentHighlightProvider and codeActionProvider -- and no symbol provider of either
 * kind. So `Ctrl+Shift+O`, the Outline view, breadcrumbs and `Ctrl+T` are all empty for
 * theories, which is a plain LSP gap rather than anything Isabelle-specific: no PIDE
 * message is needed, only a reading of the source.
 *
 * The scanner below is deliberately lexical, not a parser. It finds commands at the start
 * of a line while no comment, string or cartouche is open. That last part is what makes it
 * trustworthy: `text <open>... lemma foo ...<close>` must not become an outline entry, and
 * prose is exactly where the word "lemma" turns up most.
 *
 * Note that buffers here are ASCII (see README), so a cartouche is normally the escape
 * \<open>...\<close> rather than the glyph; both are handled.
 */

import * as vscode from 'vscode'

/** Heading commands, outermost first; the index is the nesting level. */
const HEADINGS = [
  'chapter', 'section', 'subsection', 'subsubsection', 'paragraph', 'subparagraph',
]

/**
 * Commands worth an outline entry. Deliberately not every command: an outline with one
 * row per `apply` is noise, and the point of the view is to find declarations.
 */
const ITEMS: Record<string, vscode.SymbolKind> = {
  theory: vscode.SymbolKind.File,
  lemma: vscode.SymbolKind.Function,
  theorem: vscode.SymbolKind.Function,
  corollary: vscode.SymbolKind.Function,
  proposition: vscode.SymbolKind.Function,
  schematic_goal: vscode.SymbolKind.Function,
  definition: vscode.SymbolKind.Constant,
  abbreviation: vscode.SymbolKind.Constant,
  lift_definition: vscode.SymbolKind.Constant,
  consts: vscode.SymbolKind.Constant,
  axiomatization: vscode.SymbolKind.Constant,
  fun: vscode.SymbolKind.Function,
  function: vscode.SymbolKind.Function,
  primrec: vscode.SymbolKind.Function,
  primcorec: vscode.SymbolKind.Function,
  inductive: vscode.SymbolKind.Function,
  inductive_set: vscode.SymbolKind.Function,
  coinductive: vscode.SymbolKind.Function,
  datatype: vscode.SymbolKind.Enum,
  codatatype: vscode.SymbolKind.Enum,
  typedef: vscode.SymbolKind.Struct,
  type_synonym: vscode.SymbolKind.Struct,
  record: vscode.SymbolKind.Struct,
  locale: vscode.SymbolKind.Module,
  class: vscode.SymbolKind.Class,
  context: vscode.SymbolKind.Module,
  bundle: vscode.SymbolKind.Module,
  instantiation: vscode.SymbolKind.Module,
  interpretation: vscode.SymbolKind.Module,
  sublocale: vscode.SymbolKind.Module,
  overloading: vscode.SymbolKind.Module,
  named_theorems: vscode.SymbolKind.Field,
  ML: vscode.SymbolKind.Object,
  ML_file: vscode.SymbolKind.Object,
  setup: vscode.SymbolKind.Object,
  method: vscode.SymbolKind.Object,
}

/**
 * Commands that open a `... begin ... end` block. They nest, so the lemmas of a locale
 * belong under it rather than beside it -- which also gives the block a real range, and
 * so a fold and a sticky header.
 */
const CONTAINERS = new Set([
  'locale', 'class', 'context', 'instantiation', 'overloading', 'bundle', 'experiment',
])

/** Words that can follow a goal command but are never its name. */
const NOT_A_NAME = new Set([
  'assumes', 'shows', 'fixes', 'obtains', 'where', 'and', 'for', 'if', 'is',
  'imports', 'begin', 'notes', 'defines', 'constrains', 'in', 'includes',
])

export type OutlineNode = {
  command: string
  /** Display label: the heading text, or "lemma foo". */
  name: string
  /** The bare declared name, if the command has one. Absent for anonymous goals. */
  plain?: string
  kind: vscode.SymbolKind
  /** Heading depth; items sit one below their enclosing heading. */
  level: number
  line: number
  endLine: number
  children: OutlineNode[]
}

/**
 * Offsets at which a command word starts a line outside every comment, string and
 * cartouche. Returned as [line, command] pairs.
 */
export function scanCommands(text: string): { line: number; command: string; rest: string }[] {
  const out: { line: number; command: string; rest: string }[] = []
  let comment = 0
  let cartouche = 0
  let verbatim = false
  let quote: '"' | '`' | undefined
  let line = 0
  let atLineStart = true

  const at = (s: string, i: number) => text.startsWith(s, i)

  for (let i = 0; i < text.length;) {
    const c = text[i]

    if (c === '\n') { line++; i++; atLineStart = true; continue }

    if (quote) {
      if (c === '\\') { i += 2; continue }
      if (c === quote) quote = undefined
      i++
      continue
    }
    if (verbatim) {
      if (at('*}', i)) { verbatim = false; i += 2; continue }
      i++
      continue
    }
    if (comment > 0) {
      if (at('(*', i)) { comment++; i += 2; continue }
      if (at('*)', i)) { comment--; i += 2; continue }
      i++
      continue
    }
    if (cartouche > 0) {
      // Nested cartouches are legal and common in document text.
      if (at('\\<open>', i)) { cartouche++; i += 7; continue }
      if (at('\\<close>', i)) { cartouche--; i += 8; continue }
      if (c === '‹') { cartouche++; i++; continue }
      if (c === '›') { cartouche--; i++; continue }
      i++
      continue
    }

    if (at('(*', i)) { comment = 1; i += 2; atLineStart = false; continue }
    if (at('{*', i)) { verbatim = true; i += 2; atLineStart = false; continue }
    if (at('\\<open>', i)) { cartouche = 1; i += 7; atLineStart = false; continue }
    if (c === '‹') { cartouche = 1; i++; atLineStart = false; continue }
    if (c === '"' || c === '`') { quote = c as '"' | '`'; i++; atLineStart = false; continue }

    if (c === ' ' || c === '\t' || c === '\r') { i++; continue }

    if (atLineStart) {
      const m = /^[A-Za-z_][A-Za-z0-9_']*/.exec(text.slice(i, i + 64))
      if (m) {
        const nl = text.indexOf('\n', i)
        out.push({
          line,
          command: m[0],
          rest: text.slice(i + m[0].length, nl < 0 ? text.length : nl),
        })
      }
    }
    atLineStart = false
    i++
  }
  return out
}

/** The declared name after a command keyword, if there is one. */
export function nameAfter(rest: string): string | undefined {
  let s = rest.trim()
  // Skip type parameters: `datatype 'a tree`, `datatype ('a, 'b) either`.
  for (;;) {
    const m = /^(\([^)]*\)|'[A-Za-z_][A-Za-z0-9_']*)\s*/.exec(s)
    if (!m) break
    s = s.slice(m[0].length)
  }
  const m = /^([A-Za-z_][A-Za-z0-9_'.]*)/.exec(s)
  if (!m) return undefined
  return NOT_A_NAME.has(m[1]) ? undefined : m[1]
}

/** The text of a heading, which is a cartouche or a string argument. */
export function headingText(rest: string): string | undefined {
  const cartouche = /\\<open>([\s\S]*?)(?:\\<close>|$)/.exec(rest) ??
    /‹([\s\S]*?)(?:›|$)/.exec(rest)
  if (cartouche) return cartouche[1].trim() || undefined
  const quoted = /"([^"]*)"/.exec(rest)
  return quoted ? quoted[1].trim() || undefined : undefined
}

export function buildOutline(text: string, lineCount: number): OutlineNode[] {
  const commands = scanCommands(text)
  const roots: OutlineNode[] = []
  /** Open headings, innermost last. */
  const stack: OutlineNode[] = []
  const flat: OutlineNode[] = []

  const push = (node: OutlineNode) => {
    while (stack.length && stack[stack.length - 1].level >= node.level) stack.pop()
    const parent = stack[stack.length - 1]
    if (parent) parent.children.push(node)
    else roots.push(node)
    flat.push(node)
  }

  for (const { line, command, rest } of commands) {
    const heading = HEADINGS.indexOf(command)
    if (heading >= 0) {
      const text = headingText(rest)
      const node: OutlineNode = {
        command,
        name: text ?? command,
        plain: text,
        kind: vscode.SymbolKind.Namespace,
        level: heading,
        line,
        endLine: line,
        children: [],
      }
      push(node)
      stack.push(node)
      continue
    }
    if (command === 'end') {
      // Closes the innermost open block, if any; the theory's own `end` closes nothing.
      if (stack.length && stack[stack.length - 1].level >= HEADINGS.length) stack.pop()
      continue
    }
    const kind = ITEMS[command]
    if (kind === undefined) continue
    const name = nameAfter(rest)
    const container = CONTAINERS.has(command)
    // Blocks and items always sit below every heading level, so that a later heading
    // closes an open block rather than being swallowed by it.
    const enclosingLevel =
      Math.max(stack[stack.length - 1]?.level ?? 0, HEADINGS.length - 1)
    const node: OutlineNode = {
      command,
      // An anonymous goal still deserves a row; naming it after the command is what
      // jEdit's outline does too.
      name: name ? `${command} ${name}` : command,
      plain: name,
      kind,
      // Items sit one below whatever encloses them; a block opens a new level, so its
      // own items nest one deeper still.
      level: enclosingLevel + (container ? 1 : 2),
      line,
      endLine: line,
      children: [],
    }
    push(node)
    if (container) stack.push(node)
  }

  // A node runs until the next node that is not nested inside it.
  for (let i = 0; i < flat.length; i++) {
    let end = lineCount - 1
    for (let j = i + 1; j < flat.length; j++) {
      if (flat[j].level <= flat[i].level) { end = flat[j].line - 1; break }
    }
    flat[i].endLine = Math.max(flat[i].line, end)
  }
  return roots
}

/* Cache: the outline is recomputed only when the document actually changes. */
const cache = new Map<string, { version: number; roots: OutlineNode[] }>()

export function outlineFor(doc: vscode.TextDocument): OutlineNode[] {
  const key = doc.uri.toString()
  const hit = cache.get(key)
  if (hit && hit.version === doc.version) return hit.roots
  const roots = buildOutline(doc.getText(), doc.lineCount)
  cache.set(key, { version: doc.version, roots })
  return roots
}

export function forgetOutline(doc: vscode.TextDocument): void {
  cache.delete(doc.uri.toString())
}

/** Outline nodes enclosing `line`, outermost first -- what sticky scroll shows. */
export function enclosing(roots: readonly OutlineNode[], line: number): OutlineNode[] {
  const out: OutlineNode[] = []
  let level: readonly OutlineNode[] = roots
  for (;;) {
    const node = level.find(n => n.line <= line && line <= n.endLine)
    if (!node) break
    out.push(node)
    level = node.children
  }
  return out
}

function toSymbol(doc: vscode.TextDocument, node: OutlineNode): vscode.DocumentSymbol {
  const startLine = doc.lineAt(node.line)
  const end = doc.lineAt(Math.min(node.endLine, doc.lineCount - 1)).range.end
  const range = new vscode.Range(startLine.range.start, end)
  const selection = startLine.range
  const symbol = new vscode.DocumentSymbol(node.name, node.command, node.kind, range, selection)
  symbol.children = node.children.map(child => toSymbol(doc, child))
  return symbol
}

class TheoryOutlineProvider
implements vscode.DocumentSymbolProvider, vscode.FoldingRangeProvider {
  provideDocumentSymbols(doc: vscode.TextDocument): vscode.DocumentSymbol[] {
    return outlineFor(doc).map(node => toSymbol(doc, node))
  }

  provideFoldingRanges(doc: vscode.TextDocument): vscode.FoldingRange[] {
    const out: vscode.FoldingRange[] = []
    const walk = (nodes: readonly OutlineNode[]) => {
      for (const node of nodes) {
        if (node.endLine > node.line) out.push(new vscode.FoldingRange(node.line, node.endLine))
        walk(node.children)
      }
    }
    walk(outlineFor(doc))
    return out
  }
}

/**
 * Ctrl+T across the workspace's theories.
 *
 * VS Code does not derive workspace symbols from document symbols, so this is a separate
 * provider over files on disk. Note what it is *not*: the Query panel's `find_theorems`
 * searches the loaded session image -- Main and everything below it -- by unifying a term
 * pattern against each statement, so it finds lemmas whose name you do not know. This
 * finds names, in files you have open in the workspace. They answer different questions.
 */
class TheoryWorkspaceSymbolProvider implements vscode.WorkspaceSymbolProvider {
  /** Parsed files, keyed by uri, invalidated on modification time. */
  private readonly index = new Map<string, { mtime: number; symbols: vscode.SymbolInformation[] }>()

  async provideWorkspaceSymbols(query: string): Promise<vscode.SymbolInformation[]> {
    const files = await vscode.workspace.findFiles('**/*.thy', '**/{.git,node_modules}/**', 4000)
    const needle = query.toLowerCase()
    const out: vscode.SymbolInformation[] = []

    for (const uri of files) {
      let entry = this.index.get(uri.toString())
      try {
        const stat = await vscode.workspace.fs.stat(uri)
        if (!entry || entry.mtime !== stat.mtime) {
          entry = { mtime: stat.mtime, symbols: await this.parse(uri) }
          this.index.set(uri.toString(), entry)
        }
      } catch {
        this.index.delete(uri.toString())
        continue
      }
      for (const symbol of entry.symbols) {
        // Loose filtering only: VS Code applies its own fuzzy ranking to what we return.
        if (!needle || symbol.name.toLowerCase().includes(needle)) out.push(symbol)
        if (out.length >= 512) return out
      }
    }
    return out
  }

  private async parse(uri: vscode.Uri): Promise<vscode.SymbolInformation[]> {
    const bytes = await vscode.workspace.fs.readFile(uri)
    const text = new TextDecoder().decode(bytes)
    const lineCount = text.split('\n').length
    const out: vscode.SymbolInformation[] = []
    const walk = (nodes: readonly OutlineNode[], container: string) => {
      for (const node of nodes) {
        if (node.plain) {
          const range = new vscode.Range(node.line, 0, node.endLine, 0)
          out.push(new vscode.SymbolInformation(
            node.plain, node.kind, container, new vscode.Location(uri, range)))
        }
        walk(node.children, node.plain ?? container)
      }
    }
    walk(buildOutline(text, lineCount), '')
    return out
  }
}

export function registerOutline(
  context: vscode.ExtensionContext,
  selector: vscode.DocumentSelector,
): void {
  const provider = new TheoryOutlineProvider()
  context.subscriptions.push(
    vscode.languages.registerDocumentSymbolProvider(selector, provider),
    vscode.languages.registerFoldingRangeProvider(selector, provider),
    vscode.languages.registerWorkspaceSymbolProvider(new TheoryWorkspaceSymbolProvider()),
    vscode.workspace.onDidCloseTextDocument(forgetOutline),
  )
}
