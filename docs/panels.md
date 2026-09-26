# Panel design notes

How the panels that needed new protocol messages were built, what each one's
messages look like, and the bugs found on the way. The gap analysis itself keeps only
the one-line verdict for each; this is the detail behind it.

Extracted from `GAPS.md`.

## Infoview

jEdit's Output and State dockables in one view, after Lean's infoview. The Output dockable
shows every message of the command at the caret, and the State dockable shows its proof
state. The State dockable can stay on one command, can be repeated, and can jump back to
its command. In the infoview those last three abilities become **pins**. It has a live
section for the command at the cursor, which **Pause** can freeze, and any number of
pinned commands below it.

```
PIDE/infoview_request                         -- publish now
PIDE/infoview_pin         { id, uri, line, character }
PIDE/infoview_unpin       { id }
PIDE/infoview_set_margin  { margin }
PIDE/infoview_response    { live?, pins: [ { id?, uri, line, command, source, status,
                                             goals, messages, stale? } ] }
```

`goals` and `messages` are HTML, formatted to the one margin the view reports.

**The goals are already there.** The server starts the prover with
`editor_output_state=true`, so every command's results carry its proof state.
`Editor.output` then drops the state unless the *editor's* copy of that option is set.
`VSCode_Infoview` keeps both halves and splits them with `Protocol.is_state`, putting
urgent messages first, as `Editor.output` does. No print function or overlay is involved.

**A pin holds on to a place, not only a command.** `Query_Operation`, which the State panel
pins with, holds a `Command`. Editing that command replaces it with a new one, and from
then on the panel shows the old command's last output forever
(`query_operation.scala`, the `removed` case). An infoview pin keeps both the command and
the offset where it started. While the command is in the node, the offset follows it.
Once an edit replaces it, the command now at that offset becomes the pin's. The pin is
marked `stale` only when its theory is closed or nothing is found there.

**Pause is the client's.** The server keeps publishing, and the client holds the live
section back until Resume. It shows that something changed in the meantime.

**A stock server gets a weaker infoview rather than none.** The client asks with
`PIDE/infoview_request`, which a stock server logs as `### IGNORED`. Without an answer it
builds the same view from what the stock server does send:

- the messages from `PIDE/dynamic_output`;
- the live goals from a `State_Panel` instance with auto-update on;
- each pin from another instance with auto-update off.

A pin made this way shows the proof state only, and does not follow edits. For the
messages to come without the state, the client always passes
`-o editor_output_state=false`. That sets the editor's copy of the option and leaves the
prover's alone, which matters because jEdit users often have it on in their preferences.
Without the flag the goals would appear in both blocks.

A stock server's HTML cannot be split in the client, although it would be simpler.
`Browser_Info.make_html` gives classes only to colours, not to message kinds, so no
`state_message` element survives into the HTML.

**One notification handler per method.** `vscode-jsonrpc` keeps one handler per method,
and disposing any registration deletes whatever handler holds that method at the time.
The handshake listener therefore has to be gone before the extended backend registers
its own. Otherwise tearing down the handshake silently unsubscribes the view.

**Two hosts**, as with the Graph view:

- a view in the bottom panel, which VS Code lets the user drag into either side bar;
- an editor tab, which **Open in Editor** puts beside the theory.

Each page is loaded once, and later bodies are posted into it. An update therefore
keeps the scroll position and which blocks are collapsed; the other panels here lose
both on every update, because they replace `webview.html`.

Tested by `suite44` (the page body, pure), `suite6` (the stock backend) and `suite45`
(the extended one, including a pin that follows its command through an edit).

## Simplifier trace

The one jEdit dockable that is a *conversation* rather than a view. With
`declare [[simp_trace_new mode=full]]` the simplifier suspends at a rewrite step and waits
for an answer, so the panel's buttons are not commands to run -- they are what the proof
is blocked on. That is the whole value of it: a plain `simp_trace` of a looping simpset is
thousands of lines with no way to stop at the interesting one.

```
PIDE/simplifier_trace_request       -> _response { auto_update, pending, question }
PIDE/simplifier_trace_reply         { serial, answer }
PIDE/simplifier_trace_auto_update   { enabled }
PIDE/simplifier_trace_clear_memory
PIDE/simplifier_trace_show          -> _full { entries }
```

Three things the protocol has to respect, none of them obvious from the dockable:

- **A reply quotes a serial**, because by the time the user clicks, the trace may have
  moved on. The panel disables the buttons the moment one is pressed rather than waiting
  for the response, since a second click would answer a question the prover has passed.
- **Only the first question is answerable.** The simplifier is suspended at exactly one
  point and the rest are queued behind it, so the response carries the count as well as
  the head. Without it a backlog reads as the trace being finished.
- **Answers come from the question**, never from a fixed list. A rewrite step offers
  Continue/Skip and their variants; a *hint failure* offers Redo/Exit instead. Assuming
  the step answers would send one the prover does not accept at that point.

`trace_events` republishes even when auto-update is off: a new question means the proof is
now blocked, which is precisely when a stale panel is worst. `Session`'s outlets are each
separately typed, so this needs three consumers rather than one.

Auto-update itself has to publish on *both* edges. It is server-owned state that reaches
the client only inside the response, so refreshing just when it is switched on left the
panel's checkbox reading "on" after the user turned it off -- the one piece of panel state
a client cannot work out for itself, and so the one where a missing publish is invisible
until something asserts on it.

The client half ships behind `isabelle.simplifierTrace` (default off), like the Query
panel, so a stock distribution does not show a view that can never fill.

Two things about the attribute are load-bearing and neither is visible from the dockable.
`interactive` is a *separate* flag defaulting to false, so `mode=full` alone downgrades
every step to `simp_trace_log` and the panel waits forever on a trace that only logs; the
form that works is `declare [[simp_trace_new interactive mode=full]]`. And a traced proof
genuinely suspends, so no command after it in the same theory is ever processed -- which
is why suite30's fixture keeps the traced lemma last and puts `thy_deps` in its own file.

## Graph view

Draws what `thy_deps`, `class_deps`, `locale_deps` and `code_deps` produce.
Pull, not push: nothing appears unless a theory asks for it. `thm_deps` is not on that
list: it prints a text list of theorems (`Thm_Deps.pretty_thm_deps`), in jEdit too.

Shown in a view, or as an editor tab (**Open in Editor**). A webview *view* can move
between the side bars and the panel but never into the editor area, and a wide graph
needs that width, so the tab is a separate `WebviewPanel` rendered from the same state.

```
PIDE/graphview_request -> _response { graph?: { nodes, edges }, error? }
```

Two things had to be built rather than reused.

**There is no click-to-open path.** jEdit opens its dockable from an `Active.Handler` --
the `graphview` markup is an active area in the output that the user clicks. `Active`
lives in `src/Tools/jEdit/src/active.scala` and has no counterpart on this side, so the
server walks the current command's results looking for `Markup.GRAPHVIEW` itself. A
command with no graph publishes an empty response rather than nothing, or moving the caret
off a `thy_deps` would leave the previous graph on screen looking current.

**There is no reusable layout.** `src/Tools/Graphview/layout.scala` produces coordinates
for a Java2D canvas, so `graphview_layout.ts` implements a layered layout instead:
longest-path layering, then barycentre ordering, then placement. Layering is the half that
decides correctness -- an edge that does not point downwards makes the picture lie about
the dependency -- and it must be longest-path rather than shortest, or a node with parents
at different depths is drawn level with one of its own ancestors. Ordering is the half
that decides readability and is NP-hard done properly, so four barycentre passes is where
the returns flatten.

The server applies `transitive_reduction_acyclic`, as jEdit does: `thy_deps` on a real
project is dense with edges implied by others. It throws on a cycle, so the failure is
reported to the panel rather than taking it down, and the layout tolerates a cycle anyway
rather than recursing forever.

Drawn as inline SVG in theme colours. Node names are text out of a theory, so they are
escaped rather than interpolated.

**The graph element is wrapped.** `Graph_Display.display_graph` emits through
`YXML.output_markup_elem`, which builds an `XML.wrap_elem`, so the tree is

```
XML.Elem(Markup("xml_elem", ("xml_name", "graphview") :: props),
  XML.Elem(Markup("xml_body", Nil), <encoded graph>) :: <visible text>)
```

Its own markup name is `xml_elem`, never `graphview`. Searching results for the
`GRAPHVIEW` name alone therefore matches nothing and descends into the visible text
instead of the graph -- an empty panel beside an Output pane that plainly says "See
graph". jEdit never meets this because its `Active.Handler` receives an element the
rendering layer has already resolved, so its pattern is not the shape raw command results
have. Match `XML.Wrapped_Elem` first.

**`locale_deps` speaks the old format.** It calls `Graph_Display.display_graph_old`,
which emits `browser` markup, not `graphview`, around the old Graph Browser's text
format, one node per line:

```
"name" "ident" "dir" + "path" > "parent_ident" ... ;
```

jEdit never parses it; its `Active.Handler` writes it to a file and starts `isabelle
browser`. The server reads it back into the same `Graph_Display.Graph` as the new format,
so matching `GRAPHVIEW` alone drew nothing for `locale_deps`.


## Theories and Timing

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
checking** is jEdit's `editor_continuous_checking`, which switches checking on and off.
The server has no such switch: it always checks, from the top of a theory down to
`vscode_caret_perspective` lines (default 50) below the caret, an option `VSCode_Resources`
reads once at startup. The client exposes `isabelle.checkWholeTheory`, which passes
`-o vscode_caret_perspective=0` (check to the end) and restarts the server. It used to be
called `isabelle.continuousChecking`, after jEdit, which suggested that checking stops
when it is off; that name is deprecated but still read when the new one is not set.

These two are **TreeViews, not webviews** -- the only native panels here. That is not a
style preference: both dockables are lists of named things with a status, which is the
shape a TreeView has, and going native buys keyboard navigation, type-to-filter,
theme-coloured icons and hover tooltips that a webview would have to reimplement. The
pretty-printed panels stay webviews because their content is Isabelle markup, not a list.

Verified end to end against the patched build (`test/suite17.js`): a small theory reported
16 commands reaching 100% with no failures, per-command timings, and `PIDE/goto_command`
navigating to one of them.

## Symbol search: what the server does not advertise

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


## Testing these against a live prover

`test/suite30.js` drives both panels end to end, against the extended server (or a
patched build in `ISABELLE_PATCHED_HOME`), and skips when there is neither. What it establishes is recorded in
`GAPS.md` §4; two mechanics of the suite itself belong here.

**It has to wait for a *question*, not merely for a response.** The server answers a
request immediately, long before the theory has been elaborated, so a poll that accepts
the first response passes while proving nothing.

**The answers are read off the question**, and against `HOL` a rewrite step offers
`continue`, `continue_trace`, `continue_passive`, `continue_disable` and `skip`. Asserting
a fixed list instead would pass on a rewrite step and fail on a hint failure, which offers
Redo/Exit.
