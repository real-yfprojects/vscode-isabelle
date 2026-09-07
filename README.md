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

Symbol rendering is scoped to `editor.visibleRanges` ± `isabelle.renderMarginLines`.
Measured in VS Code 1.136 on real theories:

| approach | ranges | scroll / keystroke latency |
|---|---:|---:|
| baseline, no decorations | 0 | 0.6–1.1 ms |
| **viewport-scoped (this extension)** | 87–152 | **1.5–2.0 ms** |
| whole document | ~5 000 | 17 ms |
| whole document, 144 k-line file | 79 200 | 233 ms |

Cost is linear in decorated range count and **independent of file size** — a 144 k-line
theory costs the same as a 9 k-line one. Keep the range count under ~500 and it is free.

## Development

```
npm install
npm run compile
node test/runTest.js suite.js    # Step 1: server, diagnostics, hover
node test/runTest.js suite2.js   # Step 2: symbols, rendering, input, save, motion
node test/runTest.js suite3.js   # visual: holds a window open for a screenshot
```

The suites drive a real VS Code against a real Isabelle; they are integration tests,
not unit tests, and need an Isabelle distribution present.

## Status

Prototype. See the gap analysis for what the official Isabelle/VSCode still does that
this does not (jEdit-parity panels, PIDE markup colouring, Sledgehammer sendback).

## License

[BSD 3-Clause](LICENSE), the same license Isabelle itself uses.

No Isabelle sources are vendored here: `etc/symbols` is read at runtime from whichever
distribution `isabelle.home` points at, so nothing in this repository is a derivative
work of Isabelle. Matching its license is a convenience for reuse, not an obligation.
