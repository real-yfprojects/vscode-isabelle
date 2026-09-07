/* Isabelle's PIDE markup palette, as [light, dark] pairs.
 *
 * Ported from the isabelle.text_color defaults of the official Isabelle/VSCode
 * extension (Isabelle is BSD-3-Clause, as is this project). Regenerate with
 * scripts/gen_colors.js against a newer distribution if upstream changes it.
 */

export type ColorPair = readonly [light: string, dark: string]

export const ISABELLE_COLORS: Record<string, ColorPair> = {
  "antiquote": ["rgba(102, 0, 204, 1.00)", "rgba(197, 134, 192, 1.00)"],
  "antiquoted": ["rgba(255, 200, 50, 0.10)", "rgba(255, 214, 102, 0.15)"],
  "bad": ["rgba(255, 106, 106, 0.40)", "rgba(255, 106, 106, 0.40)"],
  "bound": ["rgba(0, 128, 0, 1.00)", "rgba(96, 139, 78, 1.00)"],
  "canceled": ["rgba(255, 106, 106, 0.40)", "rgba(255, 106, 106, 0.40)"],
  "class_parameter": ["rgba(210, 105, 30, 1.00)", "rgba(210, 105, 30, 1.00)"],
  "comment1": ["rgba(129, 31, 63, 1.00)", "rgba(100, 102, 149, 1.00)"],
  "comment2": ["rgba(209, 105, 105, 1.00)", "rgba(206, 155, 120, 1.00)"],
  "comment3": ["rgba(0, 128, 0, 1.00)", "rgba(96, 139, 78, 1.00)"],
  "dynamic": ["rgba(121, 94, 38, 1.00)", "rgba(220, 220, 170, 1.00)"],
  "error": ["rgba(178, 34, 34, 1.00)", "rgba(178, 34, 34, 1.00)"],
  "free": ["rgba(0, 0, 255, 1.00)", "rgba(86, 156, 214, 1.00)"],
  "improper": ["rgba(205, 49, 49, 1.00)", "rgba(244, 71, 71, 1.00)"],
  "information": ["rgba(193, 223, 238, 1.0)", "rgba(193, 223, 238, 1.0)"],
  "inner_cartouche": ["rgba(129, 31, 63, 1.00)", "rgba(209, 105, 105, 1.00)"],
  "inner_comment": ["rgba(0, 128, 0, 1.00)", "rgba(96, 139, 78, 1.00)"],
  "inner_numeral": ["rgba(9, 136, 90, 1.00)", "rgba(181, 206, 168, 1.00)"],
  "inner_quoted": ["rgba(163, 21, 21, 1.00)", "rgba(206, 145, 120, 1.00)"],
  "intensify": ["rgba(255, 204, 102, 0.40)", "rgba(204, 136, 0, 0.20)"],
  "keyword1": ["rgba(175, 0, 219, 1.00)", "rgba(197, 134, 192, 1.00)"],
  "keyword2": ["rgba(9, 136, 90, 1.00)", "rgba(181, 206, 168, 1.00)"],
  "keyword3": ["rgba(38, 127, 153, 1.00)", "rgba(78, 201, 176), 1.00)"],
  "main": ["rgba(0, 0, 0, 1.00)", "rgba(212, 212, 212, 1.00)"],
  "markdown_bullet1": ["rgba(218, 254, 218, 1.00)", "rgba(5, 199, 5, 0.20)"],
  "markdown_bullet2": ["rgba(255, 240, 204, 1.00)", "rgba(204, 143, 0, 0.20)"],
  "markdown_bullet3": ["rgba(231, 231, 255, 1.00)", "rgba(0, 0, 204, 0.20)"],
  "markdown_bullet4": ["rgba(255, 224, 240, 1.00)", "rgba(204, 0, 105, 0.20)"],
  "operator": ["rgba(50, 50, 50, 1.00)", "rgba(212, 212, 212, 1.00)"],
  "plain_text": ["rgba(102, 0, 204, 1.00)", "rgba(197, 134, 192, 1.00)"],
  "quasi_keyword": ["rgba(153, 102, 255, 1.00)", "rgba(153, 102, 255, 1.00)"],
  "quoted": ["rgba(139, 139, 139, 0.10)", "rgba(150, 150, 150, 0.15)"],
  "raw_text": ["rgba(102, 0, 204, 1.00)", "rgba(197, 134, 192, 1.00)"],
  "running": ["rgba(97, 0, 97, 1.00)", "rgba(255, 160, 160, 1.00)"],
  "running1": ["rgba(97, 0, 97, 0.40)", "rgba(255, 160, 160, 0.40)"],
  "skolem": ["rgba(210, 105, 30, 1.00)", "rgba(210, 105, 30, 1.00)"],
  "spell_checker": ["rgba(0, 0, 255, 1.0)", "rgba(86, 156, 214, 1.00)"],
  "tfree": ["rgba(160, 32, 240, 1.00)", "rgba(160, 32, 240, 1.00)"],
  "tvar": ["rgba(160, 32, 240, 1.00)", "rgba(160, 32, 240, 1.00)"],
  "unprocessed": ["rgba(255, 160, 160, 1.00)", "rgba(97, 0, 97, 1.00)"],
  "unprocessed1": ["rgba(255, 160, 160, 0.20)", "rgba(97, 0, 97, 0.20)"],
  "var": ["rgba(0, 16, 128, 1.00)", "rgba(156, 220, 254, 1.00)"],
  "warning": ["rgba(255, 140, 0, 1.0)", "rgba(255, 140, 0, 1.0)"],
  "writeln": ["rgba(192, 192, 192, 1.0)", "rgba(192, 192, 192, 1.0)"],
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
