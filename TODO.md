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
  - [x] reported: a failure shown right after opening a workspace, clearing once the
    dependencies had loaded. Not a wrong status -- PIDE really does report a failed
    command, because dependency resolution is asynchronous and a theory opened before
    its imports are loaded has a *failing header* (`imports Mid` cannot be resolved).
    Reproduced with a same-session import chain: `Work.Top=10% FAILED:1` at 32.6s,
    `Work.Top=100%` at 33.7s; on a large project that window is long
  - the response now carries `loading` (server still resolving) and per-node
    `initialized`. Both are needed: `loading` is temporal so a genuinely bad import
    still surfaces once resolution settles, and `initialized` is per node so a real
    proof failure elsewhere is never suppressed
- [x] reported: Theories rows truncated. Grouped by session, so the label loses its
    redundant prefix, and the bar moved to the tooltip where there is room
  - still needing new protocol design: Monitor, Debugger, Simplifier trace, Raw output,
    Protocol, Graphview
  - note: the client targets the **development** tree, not Isabelle2025-2, which has no
    `PIDE/goto_command` at all (see GAPS.md for the four divergences found by building)
- [x] reported: viper-roots re-verifies every theory on startup. Measured: of its 123
    theory files, exactly **1** was in the heap image. Two causes, one per side.
  - the client never asked for a project session: `isabelle.logic` defaults to `HOL` and
    nothing overrode it, so the server booted `-l HOL`. All heaps were built and current
    and the seven component directories were already registered -- only the name was wrong
  - the obvious workaround was itself broken: `-R` selected the *named* session for the
    pre-build check, whose heap exists, so the check passed and `session_heaps` then
    demanded the synthetic `S_requirements(PARENT)` nobody built. Merged from
    `vscode-requirements-build` into `vscode-theories-panel`
  - measured frontiers for viper-roots: `-R ViperAbstract` caches 17 theories,
    `-R SimpleViperFrontEnd` 25, `-R ViperAbstractRefinesTotal` 47, `-R MainResults` 52.
    Three of those resolve to a *real* prebuilt heap rather than a synthetic image, so
    they need no build and work even without the `-R` fix
- [x] session picker: status bar item + **Isabelle: Select Session Image**, ROOT files
    parsed in-process (`isabelle sessions` prints only names, and every route to the
    directories and parents costs ~20s of JVM start -- too slow for a picker)
  - the recommendation is the **lowest** open session, not the one owning the focused
    file. `-R S` bakes S's closure into an immutable heap, so editing below the frontier
    is checked in isolation while everything above keeps the stale copy
  - editing a theory inside the image is warned about, since it is the one failure with
    no other signal: `find_theory` resolves a path without consulting `loaded_theory`, so
    the file opens as a normal live node and checks as you type -- only the results above
    it are quietly stale
  - the chosen session's ROOT directory is registered in `sessionDirs`: two of
    viper-roots' own sessions sit in subdirectories of a component and are invisible to
    Isabelle without `-d`. Redundant entries are safe (`load_root_files` dedupes by
    canonical file)
  - not done: flagging which choices need a heap build. It depends on the image
    `Sessions.background` computes, and nothing short of a full session-structure load
    says whether that heap exists -- `isabelle build -n -R S` answers a different question
    (it builds ancestors) and takes 23s. The server reports its own build via
    `build_started`, which is honest and costs nothing
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
  - that was necessary but not sufficient: the glyph lives in an *attachment span*, which
    another decoration cannot style, so the editor's underline was landing on the
    zero-width text beneath it
  - the trigger turned out to exist after all. VS Code asks the definition provider for a
    location exactly when deciding whether to draw the Ctrl+hover link, so the
    `provideDefinition` middleware is the signal. The glyph moves onto a second decoration
    whose own attachment carries the underline, and only when the server actually answers
    with a location -- otherwise a glyph would advertise a jump that is not there
  - underlining in place rather than expanding the escape: expanding reflows the line
    under the pointer, moving the character being hovered
  - `test/workspace/Hover.thy` is there to check it by hand
  - confirmed working for glyphs, but **not** for `=` or `+`, which Ctrl+click still
    navigated. Those are plain ASCII, so none of the above touches them -- the underline
    there is the editor's own. Isabelle answers a definition request with a bare
    `Location` and no `originSelectionRange`, so VS Code derives the highlight from the
    *word* at that position, and our `wordPattern` matched only escapes and alphanumeric
    identifiers. Click needs a position and worked; underline needs a range and had none.
    Fixed by adding a symbolic-operator alternative, which also makes double-click select
    `-->` and `::` sensibly
- [ ] expose isabelle cygwin terminal in vscode
- [ ] in theory view parent items should also have the update spinner animation if chilren are running
- [ ] delimiters (e.g. \<open>...\<close>) shouldn't be part of the word (e.g. when double clicking or using ctrl+left/right to jump between words)
- [ ] VSCode Getting Started Guide for the extension, including how to install and configure Isabelle, how to use the extension, and how to troubleshoot common issues.

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