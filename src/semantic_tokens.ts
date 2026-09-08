/* PIDE markup as semantic tokens, so the colour theme applies to checked text.
 *
 * The problem this solves: PIDE markup was painted with `TextEditorDecorationType`s whose
 * colours come from `src/colors.ts` -- Isabelle's own `text_color` defaults, which happen
 * to be VS Code's Dark+/Light+ values. A decoration `color` overrides everything, so
 * installing a theme recoloured only the text PIDE had not reached yet: unchecked code
 * followed the theme (via the TextMate grammar) and checked code snapped back to what
 * looked like the default theme. It was the Isabelle palette winning.
 *
 * Semantic tokens are the mechanism built for this. The editor colours them from the
 * active theme, and the custom token types declared in package.json carry `superType`
 * plus a `semanticTokenScopes` mapping to ordinary TextMate scopes, so a theme that has
 * never heard of Isabelle still styles them by the rules it already has for
 * `keyword.control`, `variable.other` and so on.
 *
 * What stays a decoration: everything that is not a token colour -- processing status
 * backgrounds, the dotted message underlines, spell-checker squiggles and overview-ruler
 * marks. Those have no semantic-token equivalent and no theme opinion.
 */

import * as vscode from 'vscode'
import { PideDecorations } from './pide_decorations'

/**
 * Isabelle's text categories, mapped onto semantic tokens.
 *
 * `main` is deliberately absent: it is Isabelle's plain-text colour, and leaving those
 * ranges untokenised is what lets the theme's own editor foreground show through.
 */
export const TOKEN_MAP: Record<string, { type: string; modifiers?: string[] }> = {
  keyword1: { type: 'keyword' },
  keyword2: { type: 'isabelleProofKeyword' },
  keyword3: { type: 'isabelleInnerKeyword' },
  quasi_keyword: { type: 'isabelleQuasiKeyword' },
  improper: { type: 'isabelleImproper' },
  operator: { type: 'operator' },
  tfree: { type: 'typeParameter' },
  tvar: { type: 'typeParameter', modifiers: ['readonly'] },
  free: { type: 'variable' },
  skolem: { type: 'isabelleSkolem' },
  bound: { type: 'parameter' },
  var: { type: 'isabelleSchematic' },
  inner_numeral: { type: 'number' },
  inner_quoted: { type: 'string' },
  inner_cartouche: { type: 'string' },
  comment1: { type: 'comment' },
  comment2: { type: 'comment' },
  comment3: { type: 'comment' },
  dynamic: { type: 'function' },
  class_parameter: { type: 'property' },
  antiquote: { type: 'macro' },
  raw_text: { type: 'string' },
  plain_text: { type: 'string' },
}

export const TOKEN_TYPES: string[] =
  [...new Set(Object.values(TOKEN_MAP).map(m => m.type))].sort()
export const TOKEN_MODIFIERS: string[] = ['readonly']

export const LEGEND = new vscode.SemanticTokensLegend(TOKEN_TYPES, TOKEN_MODIFIERS)

export type RawToken = {
  line: number
  char: number
  length: number
  type: string
  modifiers: string[]
}

/**
 * Flatten PIDE ranges into single-line, non-overlapping tokens.
 *
 * Semantic tokens cannot span lines, while PIDE ranges routinely do -- a quoted inner
 * term wraps freely -- so ranges are cut at line ends.
 *
 * Overlaps should not arise: text colours come from `Snapshot.select`, which yields
 * disjoint infos. The check is defensive, because an overlap corrupts the delta encoding
 * of every *following* token rather than merely mislabelling one word, so the failure
 * would be both spectacular and hard to trace back. The rule is document order: the
 * token that starts first wins, and among tokens starting together the shorter one does,
 * being the more specific markup.
 */
export function buildTokens(
  byType: ReadonlyMap<string, { items: { range: vscode.Range }[] }>,
  lineLength: (line: number) => number,
): RawToken[] {
  const raw: RawToken[] = []
  for (const [key, entry] of byType) {
    if (!key.startsWith('text_')) continue
    const mapped = TOKEN_MAP[key.slice('text_'.length)]
    if (!mapped) continue
    for (const { range } of entry.items) {
      for (let line = range.start.line; line <= range.end.line; line++) {
        const char = line === range.start.line ? range.start.character : 0
        const end = line === range.end.line ? range.end.character : lineLength(line)
        if (end > char) {
          raw.push({ line, char, length: end - char, type: mapped.type, modifiers: mapped.modifiers ?? [] })
        }
      }
    }
  }

  raw.sort((a, b) =>
    a.line - b.line || a.char - b.char || a.length - b.length)

  const out: RawToken[] = []
  let lastLine = -1
  let lastEnd = 0
  for (const token of raw) {
    if (token.line !== lastLine) { lastLine = token.line; lastEnd = 0 }
    if (token.char < lastEnd) continue
    out.push(token)
    lastEnd = token.char + token.length
  }
  return out
}

class PideSemanticTokensProvider implements vscode.DocumentSemanticTokensProvider {
  private readonly changed = new vscode.EventEmitter<void>()
  readonly onDidChangeSemanticTokens = this.changed.event

  constructor(private readonly pide: PideDecorations) {}

  fire(): void { this.changed.fire() }

  provideDocumentSemanticTokens(doc: vscode.TextDocument): vscode.SemanticTokens {
    const builder = new vscode.SemanticTokensBuilder(LEGEND)
    const byType = this.pide.rangesFor(doc.uri)
    if (byType) {
      const lineLength = (line: number) =>
        line < doc.lineCount ? doc.lineAt(line).text.length : 0
      for (const token of buildTokens(byType, lineLength)) {
        builder.push(token.line, token.char, token.length, TOKEN_TYPES.indexOf(token.type),
          token.modifiers.reduce((bits, m) => bits | (1 << TOKEN_MODIFIERS.indexOf(m)), 0))
      }
    }
    return builder.build()
  }
}

/** Whether the theme, rather than Isabelle's palette, should colour checked text. */
export function themeColorsMarkup(): boolean {
  return vscode.workspace.getConfiguration('isabelle')
    .get<string>('markupColors', 'theme') !== 'isabelle'
}

export function registerSemanticTokens(
  scope: vscode.Disposable[],
  selector: vscode.DocumentSelector,
  pide: PideDecorations,
): void {
  const provider = new PideSemanticTokensProvider(pide)
  scope.push(
    vscode.languages.registerDocumentSemanticTokensProvider(selector, provider, LEGEND),
    // The server pushes markup as it checks, so tokens have to be invalidated with it.
    pide.onDidUpdate(() => provider.fire()),
  )
}
