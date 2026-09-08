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
- **PIDE markup** — syntax colouring and processing status from `PIDE/decoration`.
  Colouring is served as **semantic tokens**, so the active colour theme applies to
  checked text just as it does to unchecked text; processing status, message underlines
  and overview marks stay decorations, which no theme has an opinion about. Set
  `isabelle.markupColors` to `isabelle` for Isabelle's own `text_color` palette instead
  (then `isabelle.textColorOverrides` applies).
- **Panels** — Output and State as webviews over `PIDE/dynamic_output` and `PIDE/state_*`,
  plus a Symbols palette whose entries come from `etc/symbols`. The State panel has
  Update / Auto-update / Locate.
- **Theories and Timing** — the session's theories with per-command status, and the
  slowest commands of the theory you are in. These two are TreeViews rather than
  webviews: both are lists of named things with a status, so going native buys keyboard
  navigation, type-to-filter and theme-coloured icons for free. Behind
  `isabelle.theoriesPanel`, since the server side is the `vscode-theories-panel` branch.
- **Sledgehammer** — a panel to drive the search (prover list, run, cancel, locate,
  progress), with proof suggestions as clickable buttons that insert the method into the
  proof. The same suggestions also appear as LSP code actions under the lightbulb.
- **Spell checker** — Isabelle checks the prose in comments and `text ‹…›` blocks, by
  PIDE markup category rather than by syntax, so antiquotations inside prose are excluded.
  The underlining needs no client code; the five dictionary commands are registered.
  Set `isabelle.spellChecker` to `false` to turn it off and use a general spell-checking
  extension instead.
- **Outline, breadcrumbs, folding and `Ctrl+T`** — the language server advertises no
  symbol provider of either kind, so these are supplied client-side from a lexical scan
  of the theory that tracks comment, string and cartouche nesting. Note this searches
  *names in your files*; the Query panel's `find_theorems` searches the loaded session
  image by unifying a term pattern, which is what you want when you don't know the name.
- **Syntax highlighting** — a TextMate grammar generated from the distribution's own
  keyword table, so colouring appears before the prover attaches. PIDE markup layers on
  top where it has information. The scopes (`comment.block.isabelle`, `string.quoted.*`)
  are also what general spell-checking extensions need to target prose.

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

### Not re-checking your imports on every start

Isabelle caches whole sessions as heap images, not individual proofs. There is no cache
of checked theories at all: an import already in the image resolves to a nodeless name
and is never re-checked, and everything else is elaborated from source on every start.
The stock default `-l HOL` therefore re-checks every theory in a project workspace, each
time. jEdit behaves the same way -- it just makes you choose a session at launch.

Run **Isabelle: Select Session Image** (or click the session in the status bar). It reads
the ROOT files in the workspace and offers their sessions in dependency order, then
restarts the server with `-R` and registers the ROOT's directory so the session resolves.

Which one to pick is not "the session owning the file I have open". `-R S` bakes S's whole
import closure into an immutable heap, so anything you edit down there is checked in
isolation while every theory above it keeps the stale copy. **The frontier must sit below
everything you intend to edit**, so the picker recommends the *lowest* session you have
open, and warns if you edit a theory that is inside the current image.

The equivalent settings, if you would rather write them yourself:

```jsonc
"isabelle.logic": "ViperCommon",
"isabelle.logicRequirements": true,
"isabelle.sessionDirs": ["/path/to/project"]
```

The first start builds the image and takes a while; later ones reuse it. Whether a build
is needed depends on the image `Sessions.background` computes -- a synthetic
`S_requirements(PARENT)` whenever S imports beyond its parent, otherwise the parent's own
heap, which is often already built. The server reports the build when it starts. Note
that the synthetic case needs the `-R` fix from mirror-isabelle: released Isabelle builds
the wrong session under `-R` and fails with a missing heap image. See [GAPS.md](GAPS.md).

## Performance

Both decoration systems -- symbol rendering and PIDE markup -- are scoped to
`editor.visibleRanges` ± `isabelle.renderMarginLines`. This matters most for PIDE: the
server sends markup for the whole document, over 51000 ranges on a 9000-line theory.

Measured on a synthetic 9006-line theory with the language server attached, five
configurations interleaved across three rounds (VS Code 1.136):

| configuration | typing median | scroll median |
|---|---:|---:|
| no decorations at all | ~4–17 ms | ~1–16 ms |
| symbol rendering only | ~3–16 ms | ~1–13 ms |
| viewport PIDE only | ~6–18 ms | ~3–18 ms |
| **viewport PIDE + symbols (default)** | ~4–16 ms | ~2–20 ms |
| whole-document PIDE + symbols | **29–55 ms** | **41–63 ms** |

Read those as ranges, not point estimates. Only one conclusion survives the noise, and
it survives cleanly -- every sample of the last row is worse than every sample of every
other row:

> **Viewport-scoping PIDE markup is a large, real win. Every other difference here is
> below the measurement noise floor.**

In particular symbol rendering has no measurable cost once PIDE is scoped. An earlier
version of this file claimed it was the dominant remaining cost; that was a misreading of
a single noisy run. The noise comes from the language server processing in the background
throughout, which moves the baseline by more than the effects being compared -- the
much-quoted 1.7 ms figure for symbol rendering was measured with no server attached at
all, and is not comparable.

`isabelle.pideMarkup`, `isabelle.pideViewportScope` and `isabelle.renderSymbols` each turn
one piece off, which is how the table above was produced.

## Development

```
npm install
npm run compile
npm run dev                      # interactive: Extension Development Host against a patched build
node test/runTest.js suite.js    # Step 1: server, diagnostics, hover
node test/runTest.js suite2.js   # Step 2: symbols, rendering, input, save, motion
node test/runTest.js suite3.js   # visual: holds a window open for a screenshot
node test/runTest.js suite4.js   # reveal boundaries, selection, motion decisions
node test/runTest.js suite5.js   # sendback arrives as LSP code actions
node test/runTest.js suite6.js   # PIDE markup, Output panel, State panel
node test/runTest.js suite7.js   # visual: panels and palette, for a screenshot
node test/runTest.js suite16.js  # theory status rendering, preview HTML stripping
node test/runTest.js suite18.js  # outline, folding and Ctrl+T through VS Code's own APIs
node test/runTest.js suite19.js  # the theory scanner, nesting, and sticky-scroll lines
node test/runTest.js suite21.js  # PIDE markup to semantic tokens
node test/runTest.js suite23.js  # markup colouring end to end, both modes
```

Two suites need a *patched* Isabelle and skip themselves otherwise: `suite15.js` (Query,
`ISABELLE_QUERY_HOME`) and `suite17.js` (Theories/Timing, `ISABELLE_PATCHED_HOME`).
[GAPS.md](GAPS.md) has the recipe for building one.

`npm run dev` (or **F5** → *Run Extension*) is the interactive counterpart: it seeds a
throwaway VS Code profile under `.dev-profile/` — pointed at a patched build and with the
Theories/Query views enabled — then opens an Extension Development Host on `test/workspace`.
It finds the patched build from `ISABELLE_PATCHED_HOME`, else `ISABELLE_QUERY_HOME`, else an
`~/Isabelle/Isabelle<year>-<n>-{query,theories,patched}` directory.

The suites drive a real VS Code against a real Isabelle; they are integration tests,
not unit tests, and need an Isabelle distribution present.

## Status

Prototype. [GAPS.md](GAPS.md) analyses this against the official Isabelle/VSCode: the
fork exists for exactly two capabilities (a custom file encoding and bundled fonts),
both worked around here.

PIDE markup colouring and the Output, State, Symbols, Sledgehammer, Documentation and
Preview panels are implemented, along with the spell-checker commands, session
abbreviations and panel margins. **Every `PIDE/*` message the released server defines is in
use, in both directions**, so nothing further is reachable without changing Isabelle itself.

What jEdit still has beyond this is out of reach for a different reason than the encoding
was: jEdit is not an LSP client at all, but a peer front end embedding PIDE directly, so
each panel needs protocol messages written by hand. Two branches of mirror-isabelle do
that, both built and verified against a real prover:

- `vscode-query-panel` — find_theorems / find_consts, client behind `isabelle.queryPanel`
- `vscode-theories-panel` — theory status and timing, client behind `isabelle.theoriesPanel`

Both default to off, since a released Isabelle answers none of those messages. Of what is
left, **Syslog and Info turn out to need nothing at all**: the server already routes its
syslog through `window/logMessage` into the Isabelle output channel, and VS Code hovers
already do what jEdit's Info dockable does. Monitor, Debugger, Simplifier trace, Raw
output, Protocol and Graphview remain; [GAPS.md](GAPS.md) works through what each costs.

## License

[BSD 3-Clause](LICENSE), the same license Isabelle itself uses.

No Isabelle sources are vendored here: `etc/symbols` is read at runtime from whichever
distribution `isabelle.home` points at, so nothing in this repository is a derivative
work of Isabelle. Matching its license is a convenience for reuse, not an obligation.
