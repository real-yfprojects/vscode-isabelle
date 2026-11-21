Quick notes on open features and tasks; some may also be tracked elsewhere. Finished items
are removed -- their write-ups live in git history (`git log -p -- TODO.md`) and in `docs/`.

### Release
- [ ] Go to Def in InfoView
- [ ] Isabelle panels in the left side bar all have the same name
- [ ] auto close `\<open>` and `\<comment>`
- [ ] highlight which proof a `qed` belongs to on hover/cursor
- [ ] Agents add a description to tool calls as the first argument, which the Claude Code
  panel displays
- [ ] check that warnings are displayed in the Problems panel correctly (e.g. the `sat_set`
  warning isn't shown)

### High
- [ ] `ML_Heap.share_common_data ()` button to recover RAM
- [ ] Hanging PIDE: not pinned down why line 648 hadn't started at 18:10. Unconfirmed
  candidate in the source: after an edit, the theory's new run waits for its previous run to
  end (`deps = delay :: Execution.active_tasks name`). That run can't be interrupted
  (`interrupts = false`) and only notices it was superseded between two commands, so a
  command that never returns holds up the new run
- [ ] Rename symbol
  - groundwork done: `VSCode_Entities.occurrences` returns each occurrence with its markup
    (kind, internal name, def or ref) and binding, so `prepareRename`/`rename` need no new
    search; `isabelle.checkDependentTheories` (uri, position) checks the unchecked theories
    that may use the name first
  - to decide: refuse when a dependent failed to check or is in the session image; refuse
    when the binding is in the image or in a read-only node (binding source `file:`, or a
    model with `external_file` that is not open)
  - a qualified reference (`Refs_A.double`) must keep its qualifier: replace only the base
    name at the end of each range
  - derived names (`double_def`, `double.simps`) are separate entities on purpose
    (base-name guard) and would need their own pass
- [ ] Improve Query panel
- [ ] Lags while typing
  - [ ] VS Code sometimes reports the window stopped responding -- not reproduced (typing
    into a 9k-line theory and into a copy of `HOL-Library.Multiset` while checked: no
    renderer task over 50 ms)
  - [ ] delayed letters -- not reproduced. Key-to-screen 16-19 ms median on a 9k-line
    theory (bare profile), 18-31 ms with the prover busy, 29-42 ms (max 113 ms) with the full
    user profile of 90 extensions, where the extension host stalled up to 256 ms at the top
    of the file
- [ ] Agents
  - [ ] Copilot: check the tools picker on a VS Code with `registerMcpServerDefinitionProvider`
  - [ ] a headless fallback for agents without a window (`isabelle server` kept alive)

### Medium
- [ ] profiling: optimizing verification/loading time of your project
- [ ] code formatting / prettier extension
- [ ] extension user docs so that Copilot/Claude can answer usage questions
- [ ] compare with https://github.com/Arthur742Ramos/Isabelle-VSCode#-features and decide
  what we are missing (see Low for what was already compared)
- [ ] compare with the Lean extension for UX ideas. Candidates from vscode-lean4: gutter
  progress bars per command (`taskgutter.ts`), its abbreviation help / "show all
  abbreviations" command
- [ ] code skeletons: `fun`/`primrec` equations and `case ... of` terms per constructor
- [ ] hover gaps
  - [ ] no type on the symbol of a binder or other notation with a parse translation
    (`∀`, `λ`, `{x. _}`, `[a, b]`), nor anywhere in a term that failed to check
  - [ ] descriptions of proof methods: Pure doesn't export a method's or attribute's
    comment (`Method.get_methods` is private), so the prelude cannot read it

### Low
- [ ] feature parity with Isabelle/jEdit. Still missing: Monitor, Debugger, Simplifier
  trace, Raw output, Protocol, Graphview. jEdit embeds PIDE directly, so each needs new
  protocol messages (all 32 `PIDE/*` messages are already in use)
- [ ] compare with the Python VS Code extension for features useful to Isabelle
- [ ] ideas from `Arthur742Ramos/Isabelle-VSCode`
  - [ ] **Sledgehammer proof minimization** (`isabelle.minimizeSledgehammerProof`): client
    side only now, since a job takes any parameters, a fact override and a subgoal
    (`PIDE/sledgehammer_job_start`). Read the facts of the method call at the cursor, run a
    job with `only:` those facts, the method as prover (`provers = metis`) and `minimize`,
    replace the call with the proof found
  - [ ] **proof-gap audit for `sorry` and `oops`**: a lexical scan published to Problems,
    working without the prover, reusing the nesting tracker in `src/outline.ts`. PIDE marks
    a fired `sorry` (`background_bad`, keep that), but `oops` emits no report at all, and a
    decoration can't be listed, counted or walked with F8
  - [ ] **syntactic LSP before the session is up** (low value: outline, folding, symbols
    and build progress already work without the server). Shape: a `vscode-syntactic`
    mirror branch that answers `initialize` at once, builds on a background thread so
    `shutdown` can cancel it (today the build blocks the single-threaded message loop),
    and serves `documentSymbol` from `Document_Structure.parse_sections` with the session
    background's `overall_syntax` (`bootstrap_syntax` knows only headings). Pitfalls:
    buffer and replay `didOpen`/`didChange`/`didClose` while inactive, answer requests
    empty instead of throwing, queue PIDE notifications, report a build failure by
    notification. `src/outline.ts` stays as the fallback and also feeds workspace symbols
    and sticky scroll
- [ ] double-click selects delimiters as part of the word (Ctrl+arrows are done).
  VS Code uses only `editor.wordSeparators` here and offers no hook; workaround: a
  mouse-kind selection listener narrowing a selection equal to the built-in word
- [ ] slow startup when the session image needs building: nothing prover-backed works
  until the heap exists. A smaller image first doesn't help (open theories import from the
  session being built). Cheap improvement: cancelling the build on restart/session switch,
  see the `vscode-syntactic` entry above
- [ ] code completion: names the command itself introduces (its `fixes`, `obtain`, bound
  variables) and a locale target's names (`lemma (in loc)`) aren't offered; no types in
  the detail
- [ ] ML cartouches are opaque until checked; upstream's `isabelle-ml-grammar.json` could
  be embedded for them
- [ ] stale session: offer rebuilding in the edit-time warning (`checkStaleEdit`) too, not
  only in the status bar -- needs the edit saved first
- [ ] Isabelle output panel doesn't always update when the cursor moves or files are edited
- [ ] file rename / move support (updates theory name and references)

### Manual (human) work
- [ ] Test query
- [ ] Test `(*` auto closing
- [ ] PR to upstream
  - [ ] review and clean up changes to upstream
  - [ ] contact upstream maintainers on the mailing list
  - [ ] submit the PR
- [ ] notify the other VS Code extension developers about our parallel work

### To be decided
- [ ] State/Output panels as native widgets instead of HTML. A read-only virtual document
  (TextDocumentContentProvider) looks strongest: find, selection, the Isabelle font and our
  symbol rendering for free; sendback/hyperlinks would have to come back as document links.
  (Theories and Timing as TreeViews worked well, but they are lists, unlike pretty-printed
  proof state)
