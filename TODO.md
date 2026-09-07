This documents tracks features and tasks that might already be tracked in other places. This file serves a place for quick note taking.

- [x] compatibility with spell checking extensions
  - ships a TextMate grammar (`syntaxes/isabelle-grammar.json`), generated from a
    distribution's own keyword table by `scripts/gen_grammar.scala`. It gives general
    spell checkers real scopes to target: `comment.block.isabelle`, `string.quoted.*`
  - `isabelle.spellChecker: false` turns Isabelle's own checker off (`-o
    spell_checker=false`) so the two do not double-underline
  - the grammar also buys instant highlighting before the prover attaches; verified that
    it composes with PIDE markup rather than fighting it (grammar is the base layer,
    PIDE decorations override where they have markup)
- [ ] feature equality with isabelle/jedit
  - done: PIDE markup, Output, State, Sledgehammer, Symbols, spell checker, sendback
  - missing: Documentation panel, Preview panel, Query panel (find_theorems /
    find_consts), Theories/session status, Timing, Monitor
  - 22 of the 32 `PIDE/*` protocol messages are in use; see GAPS.md
- [ ] compare to lean extension and see if we can use any of their UX
  - not started. Candidates seen while reading vscode-lean4 during the spike:
    gutter progress bars (`taskgutter.ts`) for per-command elaboration status, and its
    abbreviation help/"show all abbreviations" command
  - note their Infoview is itself a webview, so it is not an argument for native widgets
- [ ] status and other panels not as html but native widgets
  - the honest options are a TreeView (structural, poor fit for pretty-printed proof
    state) or a read-only virtual document via TextDocumentContentProvider
  - the virtual-document route looks strongest: it gets real editor behaviour for free,
    including find, selection, the Isabelle font, and our own symbol rendering, none of
    which a webview gets. Cost is losing clickable sendback/hyperlinks unless they are
    re-added as document links
- [x] symbols view: option to jump to category
  - category dropdown above the filter box; not visually confirmed yet
