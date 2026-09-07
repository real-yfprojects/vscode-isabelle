# Isabelle/PIDE for stock VS Code

A prototype Isabelle client that runs as an ordinary `.vsix` in unmodified VS Code —
no patched VSCodium, no custom editor build. It spawns Isabelle's own headless language
server (`isabelle vscode_server`) and speaks LSP to it.

## The constraint everything follows from

Two facts, both verified against Isabelle2025-2:

1. **`isabelle build` rejects literal Unicode.** A theory containing `∀` instead of
   `\<forall>` fails with `Inner lexical error`. In `symbol.ML` a raw codepoint is a
   `UTF8` symbol, which is a *different* thing from `Sym "\<forall>"` — only the latter
   carries HOL syntax. This applies to control symbols too (`x⇩1` → `Malformed command syntax`).
2. **The language server accepts Unicode anyway**, because `vscode_model.scala` does
   `Bytes(Symbol.encode(text))` on everything the editor sends.

So the file on disk *must* be ASCII escapes, while the editor may show whatever it likes.
The official client resolves this with a custom `UTF-8-Isabelle` file encoding baked into
a patched VSCodium — the one capability VS Code offers no extension-level substitute for.

This extension takes the other route: **the buffer stays ASCII, and Unicode is presentation
only.** Nothing can desynchronise, because there is only one representation.

## What it does

- **Language server** — locates an Isabelle distribution, launches `isabelle vscode_server`
  (through Isabelle's bundled Cygwin on Windows), and sends `PIDE/caret_update`, without
  which PIDE processes nothing and reports no diagnostics at all.
- **Symbol rendering** — `\<forall>` is *displayed* as `∀` with editor decorations, scoped
  to the viewport. `\<^sub>`/`\<^sup>`/`\<^bold>` render as real sub/superscript and bold.
  The symbol under the caret reverts to raw text so it can be edited.
- **Symbol input** — type `\forall`, get `\<forall>`. Ambiguous prefixes wait: `\subset`
  does not expand while `\<subseteq>` is still reachable. Completion on `\` covers the rest.
- **Save normalisation** — an `onWillSaveTextDocument` participant rewrites any literal
  Unicode back to `\<name>` before the file is written, so pasted or code-action-inserted
  Unicode cannot produce an unbuildable file.
- **Atomic motion** — arrow keys, shift-arrows, backspace and delete treat `\<forall>` as
  one unit; `wordPattern` and a per-language `editor.wordSeparators` cover double-click
  selection and Ctrl+arrow declaratively.
- **PIDE markup** — syntax colouring and processing status from `PIDE/decoration`, using
  the palette from Isabelle's own `text_color` defaults (override via
  `isabelle.textColorOverrides`).
- **Panels** — Output and State as webviews over `PIDE/dynamic_output` and `PIDE/state_*`,
  plus a Symbols palette whose entries come from `etc/symbols`. The State panel has
  Update / Auto-update / Locate.
- **Sledgehammer sendback** — works with no extra code: Isabelle2025 exposes it as LSP
  code actions, so `try0` and `sledgehammer` suggestions appear under the lightbulb.

## Setup

Install Isabelle's fonts once, system-wide, from
`$ISABELLE_HOME/contrib/isabelle_fonts-*/ttf/`, and set:

```json
"editor.fontFamily": "'Isabelle DejaVu Sans Mono', monospace"
```

This is not optional: 102 of the 439 codepoints in `etc/symbols` live above U+FFFF
(script letters, bold digits) and ordinary monospace fonts do not cover them. Fonts are
an OS-level resource, so unlike the encoding they *can* be installed globally.

Point `isabelle.home` at your distribution if it is not auto-detected.

## Performance

Both decoration systems -- symbol rendering and PIDE markup -- are scoped to
`editor.visibleRanges` ± `isabelle.renderMarginLines`. This matters most for PIDE:
the server sends markup for the whole document, over 51000 ranges on a 9000-line
theory, and applying all of it is what makes large files feel heavy.

Measured in VS Code 1.136 on a synthetic 9006-line theory (12000 symbol occurrences)
with the language server attached and identical markup across all three rows:

| configuration | typing median | typing p95 | scroll median | scroll p95 |
|---|---:|---:|---:|---:|
| whole-document PIDE + symbols | 24.3 ms | 227.8 ms | 143.1 ms | 440.9 ms |
| **viewport PIDE + symbols (default)** | **19.3 ms** | **34.4 ms** | **66.7 ms** | **113.0 ms** |
| viewport PIDE only | 4.7 ms | 24.4 ms | 18.8 ms | 58.2 ms |

Two caveats worth stating plainly. Symbol rendering, not PIDE markup, is the larger
remaining cost once both are viewport-scoped -- an earlier figure of ~1.7ms measured it
in isolation with no server attached, which flattered it considerably. And the scroll
column is close to worst case: the benchmark awaits every viewport change individually,
whereas real scrolling coalesces through a 20ms debounce.

Set `isabelle.pideViewportScope` to `false` to compare against the unscoped behaviour,
and `isabelle.renderSymbols` to `false` to drop symbol rendering on very large files.

## Development

```
npm install
npm run compile
node test/runTest.js suite.js    # Step 1: server, diagnostics, hover
node test/runTest.js suite2.js   # Step 2: symbols, rendering, input, save, motion
node test/runTest.js suite3.js   # visual: holds a window open for a screenshot
node test/runTest.js suite4.js   # reveal boundaries, selection, motion decisions
node test/runTest.js suite5.js   # sendback arrives as LSP code actions
node test/runTest.js suite6.js   # PIDE markup, Output panel, State panel
node test/runTest.js suite7.js   # visual: panels and palette, for a screenshot
```

The suites drive a real VS Code against a real Isabelle; they are integration tests,
not unit tests, and need an Isabelle distribution present.

## Status

Prototype. [GAPS.md](GAPS.md) analyses this against the official Isabelle/VSCode: the
fork exists for exactly two capabilities (a custom file encoding and bundled fonts),
both worked around here.

PIDE markup colouring and the Output, State and Symbols panels are now implemented, so
this uses 10 of the 32 `PIDE/*` protocol messages. Still missing, and all ordinary
extension work rather than missing capability: the Sledgehammer panel (sendback itself
already works), the Documentation and Preview panels, and the spell checker.

## License

[BSD 3-Clause](LICENSE), the same license Isabelle itself uses.

No Isabelle sources are vendored here: `etc/symbols` is read at runtime from whichever
distribution `isabelle.home` points at, so nothing in this repository is a derivative
work of Isabelle. Matching its license is a convenience for reuse, not an obligation.
