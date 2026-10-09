This documents tracks features and tasks that might already be tracked in other places. This file serves a place for quick note taking.

### Release
- [x] cursor on try -> infoview no longer shows goal, same for other proof methods or then (and possibly more, test for further cases)
- [x] find references -- `textDocument/references` on the extended server
    (`vscode_entities.scala`), test: suite51. Shift+F12, Shift+Alt+F12 and Go to References
    come from `vscode-languageclient` with no client code. Scope: every node PIDE has loaded
    (open theories and what they import, as far as checked); an entity of the session image
    adds its source file as the declaration. Identity is the *binding position*, not the
    markup serial: `lemma fixes x shows` reads `x` twice with two serials, and
    `definition c` binds the constant and its equation's fixed variable at one token. Runs
    off the message loop (~150 ms over `HOL-Library.Multiset` loaded from source)
  - [x] in theories nobody has checked: **Find All References, Checking Dependent
    Theories** (editor context menu; `src/dependents.ts`, test: suite52).
    `PIDE/dependents` picks the workspace's unloaded `.thy` files that import where the
    entity is bound (also indirectly, by their headers) and spell its name;
    `PIDE/check_theories` loads them as *required* models (a plain theory model is not:
    `File_Format.registry.is_theory` means ROOT/BibTeX, so without that PIDE knows the
    commands but never runs them) and is polled for progress; then the ordinary search
    runs. They stay loaded, so later edits upstream re-check them, as in jEdit's
    Theories panel. Misses a theory that uses the entity only through notation; project
    theories in the session image are listed, not searched (that is the build-database
    idea, not done)
- [ ] Rename symbol
  - groundwork done: `VSCode_Entities.occurrences` returns each occurrence with its markup
    (kind, internal name, def or ref) and binding, so `prepareRename`/`rename` need no new
    search, and `isabelle.checkDependentTheories` (uri, position) gets the unchecked
    theories that may use the name checked first. Still to decide: refuse when a dependent
    failed to check or is in the session image; refuse when the binding is in the image or in a
    read-only node (binding source `file:`, or a model with `external_file` that is not
    open); a qualified reference (`Refs_A.double`) must keep its qualifier, so replace
    only the base name at the end of each range; derived names (`double_def`, `double.simps`)
    are separate entities on purpose (base-name guard) and would need their own pass
- [x] completion preview types/statements for lemmas -- `completionItem/resolve` on the
    extended server: the item VS Code shows gets the statement of a fact (all of its theorems,
    the first as the detail), the type of a constant or of a fixed variable, from the hover's
    query (`vscode_hover.ML`) in the context the names come from. Test: suite65
- [x] code skeletons -- light bulb and ghost text (`skeleton_provider.ts`; server:
    `vscode_skeletons.ML` on the `vscode-skeletons` mirror branch), tests: suite60 (pure),
    suite61, suite62
  - [x] cases: Isabelle's own outline after `proof (induct/cases ...)`, a sendback the
    stock server already sends as a code action; now titled and kinded, and ghost text on
    the blank line below
  - [x] instantiations: the definitions still missing and `instance proof ... qed`, also as
    ghost text
  - [x] Isar sketch of a pending goal, subgoal blocks after `apply` (light bulb only); a
    placeholder `sorry`/`oops` after it is replaced
  - [ ] `fun`/`primrec` equations and `case ... of` terms per constructor
- [x] information on hover -- a query of the extended server (`vscode_hover.ML`,
    `vscode_hover_info.scala` on the mirror branch) asks the context of the command for
    what the markup only names. Tests: suite54 (server), suite49 (pure)
  - [x] type hints: fixed variables at their binding sites (`fixes`, `fix`, `obtain`,
    `case (C x)`), the declared type of a constant beside the type at the occurrence
    - [x] click to jump to type definition: hovers are HTML (`htmlHovers`), every name
      with a definition linked to it
    - [x] in the infoview: each atom of a goal has its type as a title
    - [ ] no type at all on the symbol of a binder or other notation with a parse
      translation (`∀`, `λ`, `{x. _}`, `[a, b]`), nor anywhere in a term that failed to check
  - [x] theorem statement: facts, with a selection (`assms(2)`), local facts, case names
    (`?case` and the case's assumptions)
  - [x] schematic variable contents: `?thesis`, `?case`, `let ?x`
  - [x] abbreviations: what they stand for, as an equation over their arguments
    (`sq x ≡ x * x`, `x ≠ y ≡ ¬ x = y`), also on notation for one (`≠`)
  - [ ] descriptions/explanations for proof methods: the comment of a method or attribute
    is not exported by Pure (`Method.get_methods` is private), so the prelude cannot read it
- [x] While sledgehammer runs, the PIDE doesn't update around the cursor -- in Isabelle, not
    the client: Sledgehammer's prover slices ran at priority 0, above the proofs PIDE forks
    (~1), so an edited proof waited for every queued slice (~20 s). The extended server
    loads `vscode_sledgehammer.ML`, which runs the panel's Sledgehammer at ~2. Stock
    server and jEdit unchanged. Test: suite53 (also Cancel, and that proofs are found)


### High
- [x] LLM integration into vscode copilot or claude -- MCP tools served by the extension
    (`src/agent/`, docs/agents.md), on the extended server's `PIDE/agent_*` requests
    (`vscode_agent.scala`, `vscode_agent.ML`, mirror branch `vscode-agent`). Tests: suite63
    (transport, pure), suite64 (tools against the prover)
  - [x] both transports checked with the official MCP TypeScript SDK client (1.32): stdio
    through the relay, as Claude Code connects, and Streamable HTTP with the token, as
    Copilot does; `claude mcp list` reads the `.mcp.json` the setup writes
  - [ ] Copilot: check the tools picker on a VS Code with `registerMcpServerDefinitionProvider`
  - [ ] a headless fallback for agents without a window (`isabelle server` kept alive)
- [x] search in isabelle output panel (e.g. for print_classes) -- a find bar in the
    infoview (Ctrl+F, or the title bar's search button; `src/find_bar.ts`, docs/panels.md),
    since a webview view gets no find widget. Test: suite66 (matching, pure)
- [ ] Improve Query panel
- [ ] Lags and performance while typing
  - [ ] Sometimes vscode reports that the window stops responding -- not reproduced:
    typing into a 9k-line theory and into a copy of `HOL-Library.Multiset` while it is
    checked, the renderer had no task over 50 ms
  - [ ] while vscode does respond to cursor inputs, keyboard inputs are delayed and especially backspace is delayed and even reordered after other keyboard inputs
    - [x] Backspace reordered: Backspace, Delete, the arrows and the word keys were
      extension commands everywhere, so a Backspace ran after the letters typed behind
      it (`abc⌫d` at 25 ms/key gave `abc` in 7-12 of 15 tries). Now rebound only next
      to a rendered symbol and, for word motion, on lines with `\`, `<` or `>`
      (context keys in `atomic.ts`); a symbol a native key cuts in half is deleted
      whole. 0 of 15 after. Tests: suite4
    - [x] the whole theory was re-parsed per keystroke for the sticky lines
      (`settledOutline`, test: suite19), and a workspace without a ROOT file walked
      per edit (test: suite69)
    - [ ] letters themselves: not reproduced. Key-to-screen time measured with real
      keystrokes: 16-19 ms median on a 9k-line theory (bare profile; no difference
      without symbols, semantic tokens, PIDE markup, minimap or suggestions, nor at
      top/end of file); 18-31 ms with the prover keeping 60-76% of all cores busy
      (Multiset, whole-theory checking); 29-42 ms, max 113 ms with the full user
      profile (90 extensions, Infoview open), where the renderer does about twice the
      work (decorations, minimap decorations, bracket parsing). A large proof state
      changes nothing (only 10 subgoals are printed). The extension host stalled up
      to 256 ms typing at the top of the file with the full profile, which is what a
      key bound to an extension command waits for
    - [x] under prover load (HOL-Analysis from source), the extension's display work
      caused most extension-host stalls (7-59 per typing round, up to 441 ms, against 1-3
      with symbols, markup and semantic tokens off). The stalls sat in `postMessage` to
      the window, and the extension sent ~10 messages per keystroke that changed
      nothing: PIDE markup cleared empty types again on every update, symbol rendering
      re-sent all five types, the context keys flipped twice per keystroke. Now each is
      sent only when it changes (symbols: always after an edit on a line with symbols),
      and the sticky outline is rebuilt once typing pauses. 0 such messages per round
      after; 1-2 stalls of at most ~60 ms in most rounds. Tests: suite4
    - [x] Left/Right stepped into a rendered symbol when the context key lagged
      (found while measuring): carried on to its other edge (`repairStep`, suite4)
- [x] Sledgehammer is slow and may stop when the file is edited -- jobs on the extended
    server (`vscode_sledgehammer.ML`, `VSCode_Sledgehammer`, `src/sledgehammer_jobs.ts`;
    docs/panels.md). It stopped because typing the next step edits the hammered command (a
    word that is not yet a keyword joins the span before it) and the run was a print of that
    command. A job only takes the proof state and runs in a root group of its own, results as
    protocol messages; several at once (`isabelle.sledgehammer.maxParallel`), positions
    followed by the client, CodeLens and quick fix per result, **Sledgehammer All sorrys**
    (also from the light bulb of a `sorry`),
    optional `autoSorry`. Faster: `max_proofs = 1` and cancel at the first proof,
    `falsify = smart`, `cache_dir`. The agent tool runs on the same jobs. Tests: suite67
    (pure), suite68, suite64

### Medium
- [ ] profiling - optimizing verification/loading time of your project
- [ ] code formatting / prettier extension
- [ ] extension user docs s.t. copilot/claude can help you with usage questions
- [ ] Look at these features: https://github.com/Arthur742Ramos/Isabelle-VSCode#-features and decide which we are missing.
- [ ] compare to lean extension and see if we can use any of their UX
  - not started. Candidates seen while reading vscode-lean4 during the spike:
    gutter progress bars (`taskgutter.ts`) for per-command elaboration status, and its
    abbreviation help/"show all abbreviations" command
  - note their Infoview is itself a webview, so it is not an argument for native widgets
  - [x] their `\` abbreviations: `src/shorthands.ts` adapts a short table *by meaning in
    Isabelle* (`\to` is `\<Rightarrow>`, `\imp` is `\<longrightarrow>`), never shadowing an
    Isabelle name (`\a` stays `\<a>`, not their alpha). Pairs keyed by the opening half
    (`\[[` -> `\<lbrakk>|\<rbrakk>`) because VS Code auto-closes brackets; `\_x`/`\^d`
    sub/superscripts; hover shows every way to type a symbol;
    `isabelle.input.customShorthands`. Tests: suite34 (pure), suite35 (editor)

### Low

- [~] feature equality with isabelle/jedit
  - done: PIDE markup, Output, State, Sledgehammer, Symbols, Documentation, Preview,
    spell checker, sendback, session abbrevs, panel margins
  - **all 32 of the 32 `PIDE/*` messages are now in use**, so the LSP surface is exhausted
  - the premise that jEdit features run through the LSP turns out to be wrong:
    `src/Tools/jEdit/` contains no reference to LSP anywhere. jEdit embeds PIDE directly
    in its own JVM; the language server is a peer front end that re-exposes a subset. So
    each remaining panel needs protocol messages written by hand
  - still needing new protocol design: Monitor, Debugger, Simplifier trace, Raw output,
    Protocol, Graphview
  - note: the client targets the **development** tree, not Isabelle2025-2, which has no
    `PIDE/goto_command` at all (see GAPS.md for the four divergences found by building)
- [ ] compare to features of the python vscode extension and see whether any feature is useful for isabelle as well.
- [~] compare to `Arthur742Ramos/Isabelle-VSCode` (MIT, `0.1.0-alpha.6`), an independent
    stock-VS-Code client. Opposite bet on the same problem: it ships its own Scala backend
    (`dev.isabelle.vscode.server`, 26 files) driving Isabelle's **Headless** API and treats
    `isabelle vscode_server` as an optional relay. So it reaches PIDE operations without
    patching Isabelle, at the cost of owning a bridge against Isabelle's internal Scala
    API. 120 `src/` files, 103 unit specs, 60 commands, 8 per-platform `.vsix` with
    Temurin 21 bundled
  - it has no encoding story, and that is the one thing we already got right. Its
    `src/semantic/convertSymbolsCommand.ts` rewrites the buffer to literal glyphs and
    calls the transform "lossless"; its PIDE abbrev completion inserts `λ` and `⟹` (its
    own fixtures assert those expansions); `onWillSave` appears nowhere in its 2682-line
    `extension.ts`. Re-verified the consequence on Isabelle2025-2 -- a `.thy` holding a
    literal `∀` fails `isabelle build` with `Inner lexical error ... at "?x::nat. x = x"`.
    Their Convert-to-Unicode followed by their own Build command is a failure
  - not worth taking: the AI repair seam; their theory-graph TreeView, which parses
    `imports` client-side and is superseded by the real graphview on `vscode-graphview`
  - [ ] **Sledgehammer proof minimization.** They expose
    `isabelle.minimizeSledgehammerProof`: shrink the fact list of an existing method call
    at the cursor. Assumed at first this was free because it rides the same
    `Query_Operation` the panel already drives -- it is not.
    `src/HOL/Tools/Sledgehammer/sledgehammer_commands.ML:399` (mirror-isabelle) does `val [provers_arg, isar_proofs_arg, try0_arg] =
    args` and hard-codes `hammer_away ... runN`, with `minimize` fixed inside the
    six-entry `override_params`. So the LSP surface is capped by an ML pattern match, not
    by PIDE, and this needs a mirror branch like Query and Theories did: widen
    `LSP.Sledgehammer_Request` past three strings and thread a mode plus a fact list
    through to `sledgehammer_prover_minimize.ML`. That is also why *they* get it for free
    -- the Headless backend never goes through the query operation
    (`backend/.../SledgehammerWithPideHandler.scala`)
    - groundwork done: a Sledgehammer job takes any parameters, a fact override and a
      subgoal (`PIDE/sledgehammer_job_start`), so this needs no server change any more. What
      is left is client-side: read the facts of the method call at the cursor, run a job with
      `only:` those facts, the method as the prover (`provers = metis`) and `minimize`, and
      replace the call with the proof found
  - [ ] **syntactic LSP capabilities before the session is up** -- first filed as "copy
    their offline tier", which conflated two different things. *Zero-install* (no Isabelle
    on the machine) can never be served by the server, since `isabelle vscode_server` is a
    tool of the distribution; that residue is small and probably not worth building at all.
    *Prover not up yet* is the other one, and it belongs in the server, not in TypeScript
  - **low priority: the gap is much smaller than first written here.** This entry used to
    say a cold session is "tens of minutes with no LSP surface whatsoever". True of the
    *server*, false for the *user*: `activate` registers outline, folding, Ctrl+T, symbol
    rendering, abbrevs and the TextMate grammar before `startClient()`, and
    `build_progress.ts` shows the build as a notification. Both landed on 09-08, a day
    before this entry. So the branch buys correctness and a clean lifecycle, not usability,
    and does nothing for the real pain (no prover until the heap exists -- see the startup
    item at the bottom of this file)
  - what the server side still gets wrong: `language_server.scala:219` is
    `def session = session_.value getOrElse error("Server inactive")`, and the heap build
    runs *inside* `init`, on the **single-threaded message loop** (`start` → `loop` →
    `handle`). Nothing else is read until the build ends -- including `shutdown`, so
    restarting or switching session mid-build cannot stop the build; the client has to
    `killTree` the server. That is the concrete gain of moving the build off the loop:
    `shutdown` can cancel it
  - `ServerCapabilities` (`lsp.scala:157`) advertises six things: sync, completion, hover,
    definition, documentHighlight, codeAction. No `documentSymbolProvider`,
    `foldingRangeProvider` or `selectionRangeProvider`. Its `completionProvider` trigger
    characters are already built from `Symbol.symbols` at initialize time, so serving from
    static distribution data is established precedent in that same object
  - `src/outline.ts` reimplements code Isabelle already ships:
    `Document_Structure.parse_sections(syntax, node_name, text)` (`src/Pure/Isar/`) takes
    raw text and returns a block tree from `syntax.parse_spans` -- no snapshot, no session,
    no ML process. Its only consumer in the tree is jEdit's `isabelle_sidekick.scala`.
    Arthur742Ramos also rewrote it in TypeScript, calling `documentSymbol`
    "upstream-blocked in Isabelle 2025-2"
  - **`bootstrap_syntax` is not enough on its own**: it knows only the headings, `text`,
    `theory`/`begin`/`end` and `ML` (`thy_header.scala:38`), so an outline from it is
    headings only. The useful syntax is the session background's `overall_syntax`, which
    `Sessions.background` computes *before* the build starts -- so it is available seconds
    in, not after the build
  - shape if done: a `vscode-syntactic` mirror branch. Reply to `initialize` at once, run
    build + `Isabelle_Process.start` on a background thread still reporting via
    `build_started`, and let `shutdown` cancel it. The pitfalls found on reading:
    `didOpen`/`didChange`/`didClose` arriving while inactive must be **buffered and
    replayed** (today they would throw and be lost -- the client sends them as soon as
    `initialize` answers); requests must be **answered empty** rather than throwing (a
    throw in `handle` writes no reply at all, leaving the request pending forever); PIDE
    notifications like `abbrevs_request` sent right after start need queueing too; and a
    build failure can no longer be an `initialize` error, so the client's failure path
    (`reportStartupFailure`) needs a notification instead
  - `src/outline.ts` stays as the fallback for released Isabelle, and is only *disabled*
    when the server advertises `documentSymbolProvider` (both registered = duplicate
    rows). It also feeds the workspace-symbol provider and sticky scroll
    (`viewport.ts`), so a server outline has to cover those before the TS one can go
  - `find references` is done on `vscode-2025-2` instead (see Release), from PIDE markup,
    so it needs checked theories; theirs is a name-based workspace scan that works cold but
    is not scope-aware. A cold fallback would belong here, not in the markup search
  - [ ] **proof-gap audit for `sorry` and `oops`.** First dismissed as already covered by
    PIDE; that is true for exactly half of it. `sorry` runs `Skip_Proof.report`, which
    emits `Markup.markup (Markup.bad ()) "Skipped proof"`, and `Markup.BAD` survives
    `Rendering.background_elements` through `VSCode_Rendering` (which subtracts only
    `ENTITY` and the active elements) into `PIDE/decoration` as `background_bad` --
    `src/pide_decorations.ts` already draws it. `oops` is
    `Outer_Syntax.command ... (Scan.succeed Toplevel.forget_proof)` in `Pure.thy:1011`
    and emits no report at all, so PIDE never mentions it
  - a decoration is not an audit either way: it cannot be listed or counted, F8 does not
    walk it, it exists only for open *and checked* files, and it says nothing before the
    prover attaches -- which is when "does this project still have gaps" is worth asking
  - their `src/audit/proofGapScanner.ts` is a lexical scan that skips comments, cartouches
    and strings and publishes to Problems with no prover running. Ours can reuse the
    nesting tracker `src/outline.ts` already has, so the scan itself is nearly free. Keep
    the PIDE decoration as well: it is the authority on a `sorry` that actually *fired*,
    including ones reached through `apply` scripts the lexer cannot see
  - [ ] **per-platform packaging and releases.** They ship `.vsix` assets per platform
    with a CI and release workflow; we have `npm run dev` and a checkout. The bundled-JRE
    half does not apply to us -- we spawn `isabelle vscode_server`, which runs on
    Isabelle's own JDK, so there is nothing to bundle. What is left is the `.vsix` build,
    a version story, and installing without cloning
  - the awkward part is ours alone: four panels answer only on a patched Isabelle, so a
    release has to state which features a released distribution serves and which need a
    mirror branch. GAPS.md has the recipe; a release needs the one-paragraph version
- [~] delimiters (e.g. \<open>...\<close>) shouldn't be part of the word (e.g. when double clicking or using ctrl+left/right to jump between words)
  - done for Ctrl+arrow and Ctrl+Backspace/Delete: rebound in `atomic.ts`, VS Code's own
    word rules run over units in `words.ts`, a rendered symbol being one unit
  - [ ] double-click: VS Code uses only `editor.wordSeparators` for it (never `wordPattern`),
    and offers no hook. Workaround would be a mouse-kind selection listener that narrows
    a selection equal to the built-in word around the preceding click
- [ ] when starting up with a session selected that hasn't been build yet, startup takes ages and the only progress update you get are in the isabelle extension output panel. You have to wait an eternity until you can use the extension. Can we detect a rebuild and run it in the background while using the lsp with a smaller theory that doesn't need rebuild. When the cache build has finished we can restart the lsp with the session. This is just one idea for a fix. Think whether there is a better/cleaner.more seemless way.
  - partly outdated: build progress now shows as a notification (`build_progress.ts`), and
    outline/folding/symbols work without the server. What remains is that nothing
    prover-backed works until the heap exists, and that is not avoidable by the server
  - the "smaller image first" idea looks worse than it sounds: the open theories import
    from the session being built, so the prover would elaborate all of them from source,
    competing with the build for CPU, and the switch at the end restarts it and throws
    that work away
  - the cheap real improvement is cancellation: see the `vscode-syntactic` entry above --
    today a restart or session switch mid-build can only kill the server
- [~] Code completion -- `vscode-completion` mirror branch + client dedupe, `test/suite33.js`
  - server: templates are snippets (caret inside `\<open>|\<close>`, `@{|}`), item kinds
    by source (fact, constant, method, keyword, symbol, file...), `sortText` keeps
    Isabelle's ranking, word characters no longer commit a unique item
  - semantic names were almost never offered: `semantic_completion` is `None` while the
    snapshot is outdated, which is every keystroke. The server now reuses the last
    complete list the prover reported when the word only grew, and otherwise waits for
    the prover off the message loop, at most `vscode_completion_delay` (0.5s)
  - VS Code's own model: lists are returned whole (not prefix-narrowed), `isIncomplete`
    only until a complete list covers the word, no letters as trigger characters, no
    `filterText` for words -- so VS Code filters as you type and fuzzily (`addMono` finds
    `add_set_mono`). The prover's lists are capped at `vscode_completion_limit` (1000)
    instead of `completion_limit` (40); quick suggestions are on inside strings/cartouches
  - client: server `\name` symbol items dropped (ours match substrings and show the
    glyph); session abbrevs left to the server while it runs
  - inner syntax: the prover names only a name it rejects, and a word being typed is a
    free variable, so a term got symbols and abbrevs only. A query operation
    (`vscode_completion.ML`, loaded from the jar as a prelude of the prover -- no heap of
    its own) lists every constant, fixed variable and type name visible after the command
    before the caret's. The server asks once per such command and filters the list the
    way VS Code does, so later keystrokes need no prover; within a type, type names only.
    Not offered: names the command itself introduces (its `fixes`, `obtain`, bound
    variables), a locale target's names (`lemma (in loc)`); no types in the detail

- [x] proper auto indent
- [x] syntax highlighting in "" (e.g. in HOL)
  - the grammar (`scripts/gen_grammar.scala`) scopes `"…"` and term cartouches as inner
    syntax rather than one string; prose, ML, file names and the theory header keep theirs
  - the extended server adds `semantic_*` markup (constants, types, classes, operators,
    numerals), which Isabelle's palette leaves plain
  - [ ] ML cartouches are opaque until checked; upstream's `isabelle-ml-grammar.json`
    could be embedded for them

- [~] on stale session allow rebuilding the session as an alternative to switching
  - done in the status bar: a stale image offers "Rebuild: restart the server", since a
    start rebuilds whatever changed. Not yet in the edit-time warning
    (`checkStaleEdit`), which still offers only switching -- a rebuild there would need
    the edit saved first
- [ ] isabelle output panel doesn't always update when cursor is moved/files are edited
- [ ] File rename / move support (updates theory name and references)
- [x] sledgehammer expose smart mode properly -- Isar proofs off/smart/on in the panel (jobs)
- [x] better sledgehammer progress display -- the panel lists each job with where it runs,
    its state and running time; a CodeLens above its command or `sorry` too

### Manual (human) work
- [ ] Test query
- [ ] Test (* auto closing
- [ ] PR to upstream
  - [ ] review and cleanup changes to the upstream
  - [ ] contact upstream maintainers on mailing list
  - [ ] submit the PR
- [ ] notify the other vscode extension developers about our parallel work

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
