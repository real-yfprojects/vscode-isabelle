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
| Query (find_theorems, find_consts) | `Query_Operation(PIDE.editor, view, "find_theorems", ...)` | **the same class the server already uses for Sledgehammer**, with a different operation name. Implemented on the `vscode-query-panel` branch of mirror-isabelle |
| Theories | `PIDE.session.phase`, per-node status | one message carrying `Document_Status.Nodes_Status`. Implemented on the `vscode-theories-panel` branch |
| Timing | timing data off `Document.Snapshot` | **the same message** -- both dockables are views of one `Nodes_Status`. Same branch |
| Syslog | `PIDE.session.syslog.content()` | **nothing: already delivered.** The server's `syslog_messages` consumer calls `channel.log_writeln`, which is `window/logMessage`, which VS Code shows in the Isabelle output channel |
| Info | shows tooltip content in a dockable | **nothing: VS Code hovers already do this**, and unlike jEdit they need no dedicated panel |
| Monitor | ML statistics plus `session.protocol_command("ML_Heap.full_gc")` | protocol plumbing and a chart; the largest of these |
| Debugger, Simplifier trace | interactive ML-level protocols, not just a data feed | one substantial set of messages each, plus UI with state |
| Raw output, Protocol | `session.raw_output_messages`, `session.all_messages` | messages, but these debug Isabelle itself; `isabelle vscode_server -L FILE -v` already logs the protocol |
| Graphview | a Swing graph renderer over `Graph_Display` | messages plus a graph renderer in a webview |

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

### Reproducing the build

No Mercurial and no component downloads are needed. The APIs the branch uses
(`Query_Operation`, `JSON.strings`, `Notification0`) all exist in Isabelle2025-2, so it
backports onto a released distribution, which already has every component:

1. Copy the distribution (about 2.3 GB) and clear the read-only attributes robocopy
   preserves, or the sources cannot be edited.
2. Apply the branch's three source changes plus the `etc/build.props` entry. That entry is
   easy to miss and is what the source list is taken from; without it the module is not
   compiled at all and `language_server.scala` fails with `Not found: type VSCode_Query`.
3. `isabelle scala_build -f` in the copy.
4. Point `isabelle.home` at the copy, set `isabelle.queryPanel`, and run `test/suite15.js`
   with `ISABELLE_QUERY_HOME` set to it. The suite skips itself when that is unset.

The same recipe applies to `vscode-theories-panel`, driven by `test/suite17.js` with
`ISABELLE_PATCHED_HOME` set. Both branches can be applied to one copy. Mind the four
divergences listed above when backporting: they are compile errors, except
`PIDE/goto_command`, which fails silently at run time.

Pin `ISABELLE_IDENTIFIER` for the copy so `ISABELLE_HOME_USER` does not overlap with the
working installation's settings, preferences and heaps.

### Theories and Timing

Both jEdit dockables are views of a single `Document_Status.Nodes_Status`, recomputed from
the snapshot on every `commands_changed`; only the presentation differs. So the
`vscode-theories-panel` branch adds one server component feeding both:

```
PIDE/theories_request        -- recompute and publish now
PIDE/theories_set_threshold  { threshold }      -- seconds
PIDE/theories_response       { phase, threshold, current, nodes, commands }
```

Node entries carry `Document_Status.Node_Status.json`, which already existed, plus the
theory name, its `Overall_Status` and its cumulated and maximum command time. Command
entries are the notable timings of the theory the caret is in -- only that one, because
command ids resolve only against the caret's snapshot, which is the restriction
`Timing_Dockable` works under too.

Two jEdit controls have no counterpart and are deliberately absent. **Purge** acts on
jEdit's own buffer set, whereas VS Code models follow `didOpen`/`didClose`. **Continuous
checking** is jEdit's `editor_continuous_checking`; the nearest option here is
`vscode_caret_perspective`, which `VSCode_Resources` reads once at startup, so a live
toggle would mean making those options mutable. The client instead exposes
`isabelle.continuousChecking`, which passes `-o vscode_caret_perspective=0` and restarts
the server.

These two are **TreeViews, not webviews** -- the only native panels here. That is not a
style preference: both dockables are lists of named things with a status, which is the
shape a TreeView has, and going native buys keyboard navigation, type-to-filter,
theme-coloured icons and hover tooltips that a webview would have to reimplement. The
pretty-printed panels stay webviews because their content is Isabelle markup, not a list.

Verified end to end against the patched build (`test/suite17.js`): a small theory reported
16 commands reaching 100% with no failures, per-command timings, and `PIDE/goto_command`
navigating to one of them.

### Symbol search: what the server does not advertise

`ServerCapabilities` lists `hoverProvider`, `definitionProvider`,
`documentHighlightProvider` and `codeActionProvider` -- and **no symbol provider of
either kind**. So `Ctrl+Shift+O`, the Outline view, breadcrumbs and `Ctrl+T` were all
empty for theories. Verified rather than assumed: `executeDocumentSymbolProvider`
returned `undefined` and `executeWorkspaceSymbolProvider` returned zero results for a
name that was plainly in the file.

That is a plain LSP gap, not an Isabelle one: no PIDE message is involved, only a reading
of the source. `src/outline.ts` supplies all four from one lexical scan that tracks
comment, string and cartouche nesting -- necessary because prose is exactly where the
word "lemma" turns up most, and `text <open>... lemma ...<close>` must not become an
outline entry.

This does **not** overlap with the Query panel, though both are "search":

| | `Ctrl+T` | `find_theorems` |
|---|---|---|
| Scope | `.thy` files in the workspace | the loaded session image -- `Main` and everything below it, which lives in a heap, not in files |
| Query | fuzzy name | term patterns (`"_ + _"`), `name:`, `intro`/`elim`/`dest`/`simp` |
| Matching | text | unification against the statement, up to instantiation |
| Answers | "where is the lemma called X" | "what lemma has this shape" -- when you do not know the name |

One consequence worth recording, because it is the sort of thing that silently regresses:
`editor.stickyScroll.defaultModel` prefers the outline, then a folding provider, then
indentation. Registering these providers therefore **changed which lines are sticky**, so
`viewport.ts` -- which predicts sticky lines to decorate them -- had to switch to the
outline as well. Left alone it would have quietly reintroduced the partly-coloured sticky
header it was written to fix.

### Where a glyph is drawn, and why the caret looked wrong

Symbol rendering hides the escape text and supplies the glyph as an attachment. It was a
`before` attachment on the escape range, which produced a bug worth recording because the
logic was never wrong: pressing Left across `A \<and> B` walks 19 -> 18 -> 12 -> 11,
exactly one visual unit per press.

Attachment content is laid out inside the span of the character it attaches to, and VS
Code derives a column's x by measuring the DOM up to that point. A `before` glyph on the
range start therefore counts towards the *preceding* boundary, so the caret for the
escape's start was drawn to the right of the glyph. One press of Left appeared to do
nothing and the next appeared to skip the glyph and the space in front of it together.

Selecting only the space before a glyph made it visible: the highlight covered the glyph
too. Attaching the glyph as `after` puts it inside the range from both sides.

The same file had a second latent defect. `textDecoration` is the only decoration option
that takes raw CSS, so it is how one smuggles in a property the API does not expose --
but `'none; font-size: ...'` also *sets* `text-decoration: none`, on the very element VS
Code underlines to show a name is clickable. Starting the string with `;` leaves that
declaration empty, so the parser drops it and keeps the rest.

### A failure that is not one: unresolved imports

Opening a workspace briefly showed a theory as *failed*, which then cleared once its
dependencies loaded. The status was not wrong. Dependency resolution is asynchronous, so a
theory opened before its imports are loaded has a failing **header** -- `imports Mid`
cannot be resolved -- and PIDE reports that as a failed command like any other. Reproduced
with a same-session import chain:

```
25.6s  loading=true   (no nodes yet)
26.3s  loading=true   Work.Top=10% FAILED:1 init:false tot:10
27.3s  loading=false  Work.Mid=100% init:true | Work.Top=100% init:true
```

On a large project the middle state lasts long enough to look like a real failure. Nothing
in the protocol let a client tell the two apart, so `PIDE/theories_response` now carries
`loading` (resolution still in flight) and each node carries `initialized` (did the header
go through). A node counts as *settling* only when both hold, which is what makes the
suppression safe in each direction: `loading` is temporal, so a genuinely bad import
surfaces as soon as resolution finishes rather than being hidden for the session, and
`initialized` is per node, so a proof that really failed elsewhere is never suppressed.

### Ctrl+hover over a glyph

The editor marks a name as clickable by underlining it, and that never reached a rendered
symbol. The underline is a decoration on the *text*, which here is collapsed to nothing,
while the glyph lives in an attachment span that another decoration cannot style -- so the
underline was drawn, invisibly, under a zero-width string.

There is no API for "the user is holding Ctrl". But VS Code asks the definition provider
for a location precisely when deciding whether to draw that link, so the
`provideDefinition` middleware is the signal, and it carries the exact position. The glyph
is then moved onto a second decoration type whose own attachment carries the underline.
The mark is applied only when the server actually answers with a location, so a glyph is
never made to advertise a jump that does not exist, and it is withdrawn shortly after the
last request -- there is no "hover ended" event.

Underlining in place was chosen over expanding the escape to raw text. Expanding would
also work, and would show what you are jumping from, but `\<and>` is eight columns wider
than the glyph: the line reflows under the pointer, the character being hovered moves, and
the next request arrives for a different position.

### Colour themes and checked text

PIDE markup was painted with decorations whose colours come from `src/colors.ts` --
Isabelle's `text_color` defaults, which are themselves VS Code's Dark+/Light+ values. A
decoration `color` overrides everything, so installing a theme recoloured only the text
PIDE had not reached yet: unchecked code followed the theme through the TextMate grammar,
and checked code snapped back to what looked like the default theme. It was the Isabelle
palette winning.

Semantic tokens are the mechanism built for this. `src/semantic_tokens.ts` serves the
`text_*` categories as tokens the editor colours from the theme, and the `text_*`
decorations are then *not* applied -- the two are mutually exclusive by construction,
since a decoration would override the theme again.

Themes do not know Isabelle's categories, so each custom token type is declared in
`package.json` with a `superType` and a `semanticTokenScopes` mapping to ordinary
TextMate scopes (`keyword.control`, `variable.other`, ...). A theme that has never heard
of Isabelle then styles them by rules it already has. `main` is deliberately not
tokenised: it is Isabelle's plain-text colour, and leaving it alone is what lets the
theme's editor foreground show through.

One caveat is honest to state: `editor.semanticHighlighting.enabled` defaults to
`configuredByTheme`, so a theme that opts out gets the TextMate grammar only, losing the
free/bound/schematic distinctions. `isabelle.markupColors: isabelle` restores the palette
for anyone who prefers it.

### What is cached between restarts, and the -R bug

Isabelle's cache is the heap image. On startup the server runs
`Build.build(build_heap = true)` for the session named by `-l`: if that image is current
nothing is rebuilt, and every theory inside it is loaded rather than re-checked. Anything
*above* the image is re-elaborated on every start -- PIDE keeps no on-disk cache of
command results.

So to stop your imports being re-checked you want them inside an image. Plain `-l NAME`
is the wrong tool for that when you are editing NAME's own theories: they are then in the
image too, and PIDE treats them as loaded rather than editable. `-R NAME` is the right
one -- it builds an image of NAME's *requirements*, so imports come from a heap while
your files stay live. That is `isabelle.logicRequirements`.

`-R` did not work at all. `Language_Server.build_session` built
`Sessions.Selection.session(logic)` -- the name asked for -- while `init` loaded heaps for
`session_background.session_name`, which under `session_requirements` is a synthetic
`NAME_requirements(ANCESTOR)` session holding exactly the imported theories. So it built
one session and looked for the heap of another:

```
REQS  session_name = Work_requirements(HOL)
REQS  heaps wanted = FAILED: Missing heap image for session "Work_requirements(HOL)"
build_session builds Selection.session(logic) = Work
```

Isabelle/jEdit is unaffected because `Session.build` selects
`resources.session_base.session_name`. The `vscode-requirements-build` branch of
mirror-isabelle makes `build_session` do the same; the server then reports
`Welcome to Isabelle/Work_requirements(HOL)` and the imports really are cached.

### Which Isabelle this client targets

Building the branches against a released Isabelle2025-2 turned up four places where the
development tree has moved on. They matter because the client speaks to the *development*
server, so a released distribution is not a supported target:

| Development tree | Isabelle2025-2 |
|---|---|
| `PIDE/goto_command` (and `Goto_File`, `Goto_Source_File`) | **absent entirely** -- the client's navigation has no server to talk to |
| `Channel.Delay` | `Delay.last(t, channel.Error_Logger)` |
| `Nodes_Status.command_timings` keyed by `Document_ID.Command` | keyed by `Command`; no `Snapshot.get_command` |
| `this.class_name` | `getClass.getName` |

The first is the load-bearing one, and it was found the hard way: `suite17` asserted that
the caret moved after `PIDE/goto_command` and it never did, because the released server
does not handle that message at all.

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
- the extension's own behaviour, in the six integration suites

Not verified:

- **Linux and macOS.** Only the Windows/Cygwin launch path has actually run
- the panels still listed as missing in §2
- any decoration cost below ~20 ms. The language server processes in the background
  throughout, moving the baseline by more than the effects being compared; resolving
  finer differences would need a quiesced server, which this harness cannot guarantee

## 5. If this were taken further

In rough order of value per effort:

1. **Build and test the `vscode-query-panel` branch**, then turn `isabelle.queryPanel`
   on by default. Everything else on the jEdit list needs new protocol messages designed
   from scratch; this one is already written and only needs a build environment.
2. **A `.vsix` and CI** — plus testing the non-Windows launch path.
5. **Upstream `Content.recode_symbols`** — the server already computes exactly the edits
   the save normaliser needs, but the method is dead code, referenced nowhere. Exposing
   it over LSP would let clients share one implementation.
