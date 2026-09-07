// Emit src/colors.ts from the palette shipped with the official Isabelle/VSCode extension.
const fs = require('fs')
const path = require('path')

const ISA = process.argv[2]
const out = process.argv[3]
const pkg = JSON.parse(fs.readFileSync(
  path.join(ISA, 'src', 'Tools', 'VSCode', 'extension', 'package.json'), 'utf8'))
const map = pkg.contributes.configuration.properties['isabelle.text_color'].default

const keys = Object.keys(map).filter(k => k.endsWith('_light')).map(k => k.slice(0, -6)).sort()
const lines = keys.map(k => {
  const l = map[k + '_light']
  const d = map[k + '_dark']
  return `  ${JSON.stringify(k)}: [${JSON.stringify(l)}, ${JSON.stringify(d)}],`
})

fs.writeFileSync(out, `/* Isabelle's PIDE markup palette, as [light, dark] pairs.
 *
 * Ported from the isabelle.text_color defaults of the official Isabelle/VSCode
 * extension (Isabelle is BSD-3-Clause, as is this project). Regenerate with
 * scripts/gen_colors.js against a newer distribution if upstream changes it.
 */

export type ColorPair = readonly [light: string, dark: string]

export const ISABELLE_COLORS: Record<string, ColorPair> = {
${lines.join('\n')}
}

/** Look up a colour for the current theme, honouring user overrides. */
export function colorOf(
  name: string,
  light: boolean,
  overrides: Record<string, string> = {},
): string | undefined {
  const key = name + (light ? '_light' : '_dark')
  if (overrides[key]) return overrides[key]
  const pair = ISABELLE_COLORS[name]
  return pair ? (light ? pair[0] : pair[1]) : undefined
}
`, 'utf8')
console.log(`wrote ${keys.length} colour names to ${out}`)
