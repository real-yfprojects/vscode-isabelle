# Gap analysis: this extension vs. official Isabelle/VSCode

What the official client does that this prototype does not, and which of those gaps
genuinely require a patched editor.

**Conclusion up front.** The fork exists for exactly **two** capabilities — a custom file
encoding and bundled fonts. Everything else in the official client is ordinary extension
code that runs unmodified in stock VS Code. Both of those two have workarounds, so a
stock-VS-Code Isabelle client is feasible; what remains is unwritten UI, not a missing
capability.

Measured against Isabelle2025-2 and VS Code 1.136.1.

---

## 1. What the fork actually patches

From `$ISABELLE_HOME/src/Tools/VSCode/patches/` and `component_vscodium.scala`:

| Patch | Purpose | Capability reason? |
|---|---|---|
| `isabelle_encoding.ts` + `.patch` | injects a `UTF-8-Isabelle` encoding into VSCodium's `encoding.ts` | **yes — encoding** |
| fonts → `app/out/vs/base/browser/ui/fonts` + `@font-face` appended to `workbench.css` | ships the Isabelle DejaVu faces inside the editor | **yes — fonts** |
| `symbols.json` written beside those fonts | the symbol table the extension reads at runtime | no — incidental placement |
| `product.json` checksum rewrite | updates the recorded checksum of `workbench.desktop.main.css` after the font CSS is appended | no — consequence of the above |
| `cli.patch`, `vscodium.patch` | branding and build plumbing | no |

That last row is independently informative: the fork must rewrite a checksum in
`product.json` because VS Code integrity-checks `workbench.desktop.main.css`. The same
mechanism covers `workbench.desktop.main.js`, which is where the encoding table lives —
so patching an *installed* VS Code after the fact would trip the "installation appears
corrupt" banner. Building a fork is the only stable way to get the encoding in.

## 2. Status of every feature

### Works today, no fork

| Feature | How |
|---|---|
| Diagnostics, hover, completion, goto-definition, document highlight | standard LSP, wired automatically by `vscode-languageclient` |
| **Sledgehammer / `try0` sendback** | **standard LSP code actions — verified, needs no PIDE-specific code** |
| Caret perspective | `PIDE/caret_update`; without it PIDE processes nothing |
| Unicode symbol display | viewport decorations over an ASCII buffer |
| Sub/superscript, bold | decorations on control symbols |
| Symbol input (`\forall` → `\<forall>`) | rewriter + completion, table from `etc/symbols` |
| Unicode-safe saving | `onWillSaveTextDocument` normaliser |
| Symbol-atomic caret motion | rebound motion commands + `wordSeparators`/`wordPattern` |
| **PIDE markup colouring and status** | `PIDE/decoration` → editor decorations, palette ported from Isabelle's own `text_color` defaults |
| **Output panel** | webview over `PIDE/dynamic_output` |
| **State panel** | webview over `PIDE/state_*`, with Update / Auto / Locate |
| **Symbols palette** | webview over the `etc/symbols` table; click inserts the escape |
| **Sledgehammer panel** | webview over `PIDE/sledgehammer_*`: prover list, run, cancel, locate, status |
| **Spell checker** | underlining arrives as a `spell_checker` decoration; the five dictionary commands are registered |
| **Theories / Timing panels** | native TreeViews over `PIDE/theories_*` (`vscode-theories-panel` branch) |
| **Navigating to a command** | `PIDE/goto_command` out, `PIDE/caret_update` back in |
| **Outline, breadcrumbs, folding, `Ctrl+T`** | client-side, from a lexical scan of the theory |
| **Session picker** | ROOT files parsed client-side; sets `logic`/`logicRequirements`/`sessionDirs` and restarts |
| **Startup and heap-build progress** | the server's own build output relayed into a notification |

Sendback deserves emphasis because the original brief listed it as a gap. Isabelle2025
exposed it as LSP code actions, so it arrives for free. Asking for code actions on a
`try0` line returned six: `by simp`, `by presburger`, `by fastforce`, `by force`,
`by auto`, `by linarith`, each carrying a `newText` that rewrites the line.

### The LSP surface is now fully consumed

**All 32 of the 32** `PIDE/*` messages the server defines are in use. Verified
mechanically by diffing the message names in `lsp.scala` against those in `src/*.ts`.

Nothing further is reachable from a client without changing the server, which brings us
to the next section.

For reference, the official extension contributes 8 commands, 4 views, 3 configuration
properties, and **0 keybindings**.

### What jEdit still has, and why it is out of reach

The natural assumption is that Isabelle/jEdit is an LSP client and its panels therefore
ought to be reachable. It is not. **`src/Tools/jEdit/` contains no reference to LSP at
all.** jEdit is a Scala application that embeds PIDE in its own JVM and drives it through
`PIDE.session` directly. The language server in `src/Tools/VSCode/src/` is a *peer* front
end that embeds PIDE the same way and re-exposes a chosen subset over LSP.

So jEdit features do not "run through the LSP"; each one someone wanted in VS Code had to
be given protocol messages by hand. The underlying machinery is shared, which is what makes
the remaining work small rather than deep:

| jEdit dockable | Mechanism it uses | What exposing it would take |
|---|---|---|
| Query (find_theorems, find_consts) | `Query_Operation(PIDE.editor, view, "find_theorems", ...)` | **done** -- the same class the server already uses for Sledgehammer, with a different operation name. `vscode-query-panel` branch, built and verified |
| Theories | `PIDE.session.phase`, per-node status | **done** -- one message carrying `Document_Status.Nodes_Status`. `vscode-theories-panel` branch |
| Timing | timing data off `Document.Snapshot` | **done** -- the same message; both dockables are views of one `Nodes_Status`. Same branch |
| Syslog | `PIDE.session.syslog.content()` | **nothing: already delivered.** The server's `syslog_messages` consumer calls `channel.log_writeln`, which is `window/logMessage`, which VS Code shows in the Isabelle output channel |
| Info | shows tooltip content in a dockable | **nothing: VS Code hovers already do this**, and unlike jEdit they need no dedicated panel |
| Monitor | ML statistics plus `session.protocol_command("ML_Heap.full_gc")` | **declined** -- see below |
| Debugger | breakpoints and frame evaluation for Isabelle/ML | **declined** -- see below |
| Simplifier trace | an interactive question/answer protocol, not a data feed | **done** -- `vscode-simplifier-trace` branch, verified live; see below |
| Raw output, Protocol | `session.raw_output_messages`, `session.all_messages` | messages, but these debug Isabelle itself; `isabelle vscode_server -L FILE -v` already logs the protocol |
| Graphview | a Swing graph renderer over `Graph_Display` | **done** -- `vscode-graphview` branch, verified live; see below |

Query is the one worth having, and the cheapest: `Query_Dockable` builds
`new Query_Operation(PIDE.editor, view, "find_theorems", ...)` while `VSCode_Sledgehammer`
builds `new Query_Operation(server.editor, (), "sledgehammer", ...)`. Only the name differs.
The branch adds one generic set of messages, so further operations cost a list entry:

```
PIDE/query_operations_request -> _response { operations }
PIDE/query_request  { operation, args }
PIDE/query_cancel   { operation }
PIDE/query_locate   { operation }
PIDE/query_status   { operation, message }
PIDE/query_output   { operation, content }
```

The client half ships behind `isabelle.queryPanel` (default off), so a stock distribution
does not get a view that silently does nothing; enabled against released Isabelle, it
reports the server as unsupported rather than waiting.

That branch is **built and verified**. The dev tree as a whole still does not compile
against a released classpath, but the branch's own files do, and they were exercised
against a real prover:

```
PIDE/query_operations_request -> { operations: [find_theorems, find_consts] }
PIDE/query_request { operation: find_theorems, args: ["5", "false", "\"_ + _\""] }
PIDE/query_status  { message: "Finished" }
PIDE/query_output  -> find_theorems "_ + _" found 1239 theorem(s) (5 displayed)
```

### What closing each gap took

One row per gap that is now closed. The design notes behind them — the protocol message
shapes, the bugs found on the way, and what each is verified against — are in
[docs/panels.md](docs/panels.md).

| Gap | Closed by | The finding worth keeping |
|---|---|---|
| Query (`find_theorems`, `find_consts`) | `vscode-query-panel`, behind `isabelle.queryPanel` | one generic `PIDE/query_*` set, so further operations cost a list entry |
| Theories + Timing | `vscode-theories-panel`, behind `isabelle.theoriesPanel` | both dockables are views of one `Nodes_Status`. Shipped as native TreeViews — the only ones here |
| Simplifier trace | `vscode-simplifier-trace`, behind `isabelle.simplifierTrace` | `mode=full` alone only *logs*; `interactive` is a separate flag, and the panel waits forever without it |
| Graph view | `vscode-graphview` | `Graph_Display` wraps the graph in `xml_elem`; matching `GRAPHVIEW` alone finds nothing. It survived every unit test |
| Sendback | nothing — LSP code actions | exposed twice over: code actions on the goal line *and* `<sendback>` in the panel stream |
| Syslog | nothing — `window/logMessage` | already lands in the Isabelle output channel |
| Info | nothing — VS Code hovers | jEdit needs a dockable only because it has no hovers |
| Outline, breadcrumbs, `Ctrl+T` | `src/outline.ts`, client-side | the server advertises **no** symbol provider of either kind. Registering one changed which lines sticky scroll pins, so `viewport.ts` had to follow |
| PIDE colours vs. themes | `src/semantic_tokens.ts` | a decoration `color` overrides a theme, so installing one recoloured only *unchecked* code. Semantic tokens are the mechanism built for this |
| Incoming `PIDE/caret_update` | `src/caret.ts` | 32/32 message *names* in use was the wrong metric — the unit of "implemented" is a direction, not a message. Every Locate button had been a silent no-op |

### Two dockables deliberately not implemented

**Monitor** is a live chart of ML runtime statistics -- future tasks, worker threads, GC
counts, heap size, program code and stack, thread states, times (`ML_Statistics`'s field
groups) -- plus buttons firing `ML_Heap.full_gc` and `ML_Heap.share_common_data`.

It diagnoses *the prover's* health, not the user's proof. It answers "why is this machine
thrashing" and lets you reclaim memory on a large session, which matters to someone tuning
Isabelle itself and almost never to someone writing Isar. Against that it wants a
statistics stream plus a charting UI: the largest effort here for the smallest audience.
Anyone who needs the numbers can get them from the session's own logs.

**Debugger** is a real breakpoint debugger for **Isabelle/ML** -- `toggle_breakpoint`,
thread contexts, stack frames, and evaluating ML expressions inside a suspended frame.

The distinction that decides it: this debugs the ML implementing tactics, methods and
commands. It does *not* debug proofs. A user whose `simp` misbehaves is served by the
simplifier trace, not by this; the audience is people writing new proof methods or working
on Isabelle internals. It is also the most stateful UI of the set, needing a stack view, a
variables view, breakpoint gutter decorations and an evaluation console.

Worth recording for whoever revisits this: VS Code implements the Debug Adapter Protocol,
so it is the one gap where the editor would supply most of the UI. That lowers the cost
without changing who wants it. If Isabelle/ML development in VS Code ever becomes a goal,
this is the entry point, and mapping `Debugger` onto DAP is the design to reach for rather
than a bespoke panel.

### How the branches relate, and how to build them

Moved to [docs/building.md](docs/building.md): how the `mirror-isabelle` feature branches
are stacked, the two build routes (backporting a branch onto a released distribution, and
compiling the mirror tree itself), and the four places where the development tree has
moved on from Isabelle2025-2 — which is why a released distribution is not a supported
target.

### Rendering quirks, sessions and heaps

Two clusters that grew out of this analysis but are not gaps, moved out:

- [docs/troubleshooting.md](docs/troubleshooting.md) — where a glyph is drawn and why the
  caret looked wrong, the "failure" that is really an unresolved import, Ctrl+hover over a
  glyph, and why installing a theme recoloured only unchecked code.
- [docs/sessions.md](docs/sessions.md) — that there is no theory cache, how to choose an
  `-R` frontier, why editing into the heap is invisible, and what the picker can and
  cannot tell you.

### Genuinely needs the fork — or a workaround

| Capability | Why no extension can do it | Workaround used here |
|---|---|---|
| **Custom `UTF-8-Isabelle` file encoding** | `vscode.d.ts` documents a closed list of 50 encodings and states an unsupported name silently falls back to the default. There is no `registerEncoding`, `EncodingProvider`, or contribution point. The implementation is compiled into the checksummed `workbench.desktop.main.js`. | keep the buffer ASCII and render Unicode with decorations, so no second representation exists to desynchronise |
| **Bundled fonts** | extensions cannot ship fonts (microsoft/vscode#181157, closed as not-planned) | install Isabelle's own TTFs system-wide and set `editor.fontFamily`. Fonts, unlike encodings, *are* an OS-level resource — this is a real fix, not a hack. It is also mandatory: 102 of the 439 codepoints in `etc/symbols` are above U+FFFF |

## 3. One upstream bug, and how it is avoided

`PIDE/decoration` itself is **not** affected — markup colouring works on Isabelle2025-2.
(An earlier draft of this document claimed otherwise; that was wrong.) What breaks is the
*panel* path: with `vscode_html_output=false`, every output event fails with

```
*** Session consumer failure: "isabelle.vscode.Dynamic_Output"
*** Bad JSON value: isabelle.vscode.LSP$$$Lambda/0x...
```

`LSP.Dynamic_Output.apply` and `State_Output.apply` call `decorations.map(_.json)`, but
`Decoration.json` takes a `JFile` parameter, so an eta-expanded lambda lands in the JSON.

Already fixed upstream by `c1a8c7bcf2`, which splits `json_entries` (a value) from
`notification(file)`. Its commit message notes the split was restored because it is
"required for unproven Neovim experiments" — i.e. for exactly this class of
non-VSCodium client.

This extension therefore defaults to `vscode_html_output=true`, which takes the branch
passing `None` for decorations. That both avoids the bug and hands the panels ready-made
HTML, which is what a webview wants anyway — so the workaround costs nothing.

## 4. What is measured vs. inferred

Verified by running it:

- `isabelle build` rejects literal Unicode, for ordinary *and* control symbols
- `isabelle vscode_server` runs headless over stdio and drives fine from a stock client
- the server applies `Symbol.encode` to editor text, so a Unicode buffer would also work
- sendback arrives by *two* independent paths: as LSP code actions on the goal line
  (a `by simp` action appears there), and as `<sendback>` elements inside
  `PIDE/sledgehammer_output`, which the panel turns into clickable buttons. Clicking one
  round-trips `sledgehammer_sendback` -> `sledgehammer_insert` and edits the theory.
  An earlier note here claimed the panel stream carried progress only; that was wrong,
  the automated poll simply gave up before the final message arrived
- Isabelle's spell-checker underlining needs no client code: it arrives as an ordinary
  `spell_checker` decoration through `PIDE/decoration`
- decoration cost, symbol rendering alone with no server: ~1.7 ms viewport-scoped vs
  17 ms whole-document (5 k ranges) and 233 ms on a 144 k-line file; linear in range
  count, flat in file size
- decoration cost with the server attached, 9 k-line theory, interleaved rounds: only
  one difference exceeds the noise floor -- whole-document PIDE markup (29-55 ms typing,
  41-63 ms scroll) against everything else (~4-18 ms). Viewport scoping is a real win;
  the remaining differences, symbol rendering included, are not measurable here
- a formatter or `onWillSave` participant can force ASCII onto disk, but always rewrites
  the buffer too, so it cannot serve as a round-trip encoding layer
- PIDE markup decorations arrive and are applied (8 types, 22 ranges on a small theory)
- the Output and State panels receive content; the State panel reports `1. P ⟹ P`
- the extension's own behaviour, in the integration and unit suites
- **a real prover starts on Linux, macOS and Windows**, in CI: the `integration` job
  downloads a release and runs the whole regression, 15/15 on each. Affordable only
  because an Isabelle release ships prebuilt Pure and HOL images -- building a heap first
  would cost half an hour before the first assertion. Three things had to be true that
  were not obvious: the download host 301-redirects https to http and curl will not
  follow that; a released Windows bundle ships Cygwin *uninitialized*, and the extension
  bypasses the launcher that would normally initialize it; and `toCygwinPath` used the
  host's path resolver, so it silently could not convert a Windows path from a POSIX host
  -- which is the one thing its platform argument exists for
- **the Simplifier trace and Graph view panels, end to end** (`test/suite30.js`, skipped
  unless `ISABELLE_PATCHED_HOME` points at a build carrying the components): a question
  arrives with the prover's own answers and answering it advances to the next queued one;
  `simplifier_trace_show` returns the assembled trace, which reaches it by a different
  server path than questions take; auto-update round-trips in *both* directions, which is
  what caught a missing publish on the disable edge; `thy_deps` on `Main` decodes to 100
  nodes and 140 edges, and moving the caret off the command clears it rather than leaving
  a stale graph looking current. One claim there is weaker than it looks: `clear_memory`
  is shown to be accepted and to republish, **not** to have discarded the simplifier's
  memoised answers
- **the Theories and Timing panels** against the patched build (`test/suite17.js`):
  16 commands reaching 100% with no failures, per-command timings, and `PIDE/goto_command`
  navigating to one of them
- **that the server advertises no symbol provider**, rather than assuming it from the
  source: `executeDocumentSymbolProvider` returned `undefined` and
  `executeWorkspaceSymbolProvider` zero results for a name plainly in the file

Both panel branches were written from the jEdit dockables and the Isabelle sources, which
is exactly the kind of reading that is convincing and wrong -- the `xml_elem` wrapping bug
survived every unit test and every re-reading of the source. A fixture cannot answer the
only question a protocol has, *does the server send what the client expects to receive*,
which is why the live-prover suites carry more weight here than their line count suggests.
- **session caching, by probe rather than inference**: `Sessions.background` loaded with
  the real options reports 1 project theory in the image under the shipped default and
  17-52 under the various `-R` frontiers; `-R MainResults` raises `Missing heap image` on
  an unpatched build, reproducing the bug exactly
- the ROOT parser against the real tree: 14 sessions, cross-checked against
  `isabelle sessions -a` with no session Isabelle knows missed
- `isabelle build -n -R MainResults` reports nothing to build in 23s, confirming it
  answers a different question than the picker needs

Not verified:

- ~~the merged `-R` fix, by compilation~~ -- **now verified**: Isabelle/Scala builds from
  the mirror tree with zero errors and `lib/classes/isabelle.jar` carries
  `Language_Server`, `LSP` and `VSCode_Theories`. See "Compiling the mirror tree itself"
  above. The build stops afterwards on `isabelle_graphbrowser.jar` (`invalid source
  release: 25`, javac given `-source 25` under the borrowed JDK 21), which is a Java
  component the language server does not touch
- **whether `ThemeIcon.color` reaches a quick pick.** `vscode.d.ts` documents it as
  "currently only used in `TreeItem`", so the recommended session's star may render in the
  default foreground rather than gold. The star itself renders either way
- the panels still listed as missing in §2
- any decoration cost below ~20 ms. The language server processes in the background
  throughout, moving the baseline by more than the effects being compared; resolving
  finer differences would need a quiesced server, which this harness cannot guarantee

## 5. If this were taken further

In rough order of value per effort:

1. **Get the CI `integration` job green.** Packaging and cross-platform CI are **done**:
   `npm run package` produces a 98 KB vsix (34 files: `out/`, `syntaxes/`, the language
   configuration, `media/`, LICENSE, README -- no sources, no harness), and
   `.github/workflows/ci.yml` compiles and runs the pure suites on Linux, macOS and
   Windows plus a packaging job. The `integration` job that downloads a release and runs
   the full regression off Windows has not had a green run yet; until it does, the
   non-Windows *launch* path is untested rather than covered.
2. **Turn `isabelle.queryPanel` on by default** once the branch it needs is upstream or
   routinely built. The client half is written and verified; it stays off so a stock
   distribution does not get a view that silently does nothing. The same applies to
   `isabelle.simplifierTrace`.
3. **Upstream `Content.recode_symbols`** — the server already computes exactly the edits
   the save normaliser needs, but the method is dead code, referenced nowhere. Exposing
   it over LSP would let clients share one implementation.

Monitor and Debugger are declined; see "Two dockables deliberately not implemented".

Raw output and Protocol are deliberately not on this list: they debug Isabelle itself, and
`isabelle vscode_server -L FILE -v` already logs the protocol.
