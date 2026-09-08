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
- [~] feature equality with isabelle/jedit
  - done: PIDE markup, Output, State, Sledgehammer, Symbols, Documentation, Preview,
    spell checker, sendback, session abbrevs, panel margins
  - **all 32 of the 32 `PIDE/*` messages are now in use**, so the LSP surface is exhausted
  - the premise that jEdit features run through the LSP turns out to be wrong:
    `src/Tools/jEdit/` contains no reference to LSP anywhere. jEdit embeds PIDE directly
    in its own JVM; the language server is a peer front end that re-exposes a subset. So
    each remaining panel needs protocol messages written by hand
  - [x] Query (find_theorems / find_consts): jEdit builds
    `Query_Operation(..., "find_theorems", ...)` and the server already builds
    `Query_Operation(..., "sledgehammer", ...)`. Server side on the `vscode-query-panel`
    branch of mirror-isabelle, **built and verified** against a real prover
    (find_theorems "_ + _" -> 1239 theorems). Client ships behind `isabelle.queryPanel`,
    off by default since released Isabelle does not answer those messages.
    Build recipe in GAPS.md; a patched copy currently sits at
    `C:\Users\yanni\Isabelle\Isabelle2025-2-query` (2.3 GB, safe to delete)
  - [x] Theories + Timing: both are views of one `Document_Status.Nodes_Status`, so one
    server component feeds both. `vscode-theories-panel` branch of mirror-isabelle,
    **built and verified** (16 commands to 100%, per-command timings, goto_command).
    Client ships as **native TreeViews** behind `isabelle.theoriesPanel`
  - [x] Syslog: needs nothing. The server's `syslog_messages` consumer calls
    `channel.log_writeln` = `window/logMessage`, which lands in the Isabelle output
    channel. jEdit needs a dockable because it has no such thing
  - [x] Info: needs nothing. VS Code hovers already show what that dockable shows
  - [x] fixed on the way: the client never handled *incoming* `PIDE/caret_update`, so
    every "Locate" button was a silent no-op. Counting 32/32 message names in use was the
    wrong metric -- the unit of "implemented" is a direction, not a message
  - [x] fixed on the way: Preview was rendered by embedding a whole Browser_Info document,
    whose inlined `isabelle.css` hardcodes a white page and won the cascade over ours
  - [x] found by asking how the Query panel compares to VS Code's own symbol search:
    the server advertises **no symbol provider of either kind**, so Ctrl+Shift+O, the
    Outline view, breadcrumbs and Ctrl+T were all empty. Supplied client-side in
    `src/outline.ts`; needed no upstream change. Careful: this changed which lines
    sticky scroll pins, so `viewport.ts` now follows the outline too
  - [x] reported: installing a theme recoloured only *unchecked* code. PIDE decorations
    carry Isabelle's palette and a decoration colour overrides the theme. Now served as
    semantic tokens (`src/semantic_tokens.ts`) with custom types mapped to TextMate
    scopes, so themes apply; `isabelle.markupColors: isabelle` restores the palette
  - [x] reported: Theories rows truncated. Grouped by session, so the label loses its
    redundant prefix, and the bar moved to the tooltip where there is room
  - still needing new protocol design: Monitor, Debugger, Simplifier trace, Raw output,
    Protocol, Graphview
  - note: the client targets the **development** tree, not Isabelle2025-2, which has no
    `PIDE/goto_command` at all (see GAPS.md for the four divergences found by building)
- [ ] compare to lean extension and see if we can use any of their UX
  - not started. Candidates seen while reading vscode-lean4 during the spike:
    gutter progress bars (`taskgutter.ts`) for per-command elaboration status, and its
    abbreviation help/"show all abbreviations" command
  - note their Infoview is itself a webview, so it is not an argument for native widgets
- [ ] compare to features of the python vscode extension and see whether any feature is useful for isabelle as well.
  - [ ] find references
- [x] symbols view: option to jump to category
  - category dropdown above the filter box; not visually confirmed yet
- [ ] status bar widget
- [ ] when opening an isabelle language file, the isabelle lsp should be started without opening the isabelle panel first.
- [x] bug when cursor jumps around glyphs: it also jumps over a preceeding whitespace
  - the caret *offsets* were always right; the trajectory across `A \<and> B` is
    19 -> 18 -> 12 -> 11, exactly one visual unit per press. The bug was where the caret
    got **drawn**
  - the glyph was a `before` attachment on the escape range. Attachment content is laid
    out inside the span of the character it attaches to, and VS Code derives a column's x
    by measuring the DOM up to that point -- so a `before` glyph on the range start counts
    towards the *preceding* boundary. The caret for the escape start was therefore drawn
    to the right of the glyph: one press of Left looked like it did nothing, and the next
    looked like it skipped the glyph and the space in front of it together
  - pinned down by selecting *only the space* before a glyph: the highlight visibly
    covered the glyph too (`test/probe_caret.js`). Fixed by attaching as `after`
- [x] strg+hover underlines clickable symbols, but this doesn't happen for glyphs although they are clickable
  - `textDecoration` is the only decoration option taking raw CSS, so it is how one
    smuggles in a property the API does not expose. Writing `'none; font-size: ...'` also
    *sets* `text-decoration: none`, which was never intended and landed on the same
    element as VS Code's own goto-definition class, suppressing every underline the
    editor draws over a symbol
  - fixed by starting the string with `;`, which makes the text-decoration declaration
    empty so the CSS parser drops just that one and keeps the rest


### To be decided

- [~] status and other panels not as html but native widgets
  - the honest options are a TreeView (structural, poor fit for pretty-printed proof
    state) or a read-only virtual document via TextDocumentContentProvider
  - the virtual-document route looks strongest: it gets real editor behaviour for free,
    including find, selection, the Isabelle font, and our own symbol rendering, none of
    which a webview gets. Cost is losing clickable sendback/hyperlinks unless they are
    re-added as document links
  - **first evidence in**: Theories and Timing are TreeViews and it was clearly the right
    call -- they are lists of named things with a status, which is exactly a TreeView's
    shape, and keyboard nav, type-to-filter, theme icons and tooltips came for free
  - that does not transfer to State/Output, whose content is pretty-printed markup rather
    than a list. Those remain the virtual-document question