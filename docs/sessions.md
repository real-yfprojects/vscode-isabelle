# Sessions, heaps and what is cached

Why the server re-checks theories on every start, what a session image actually holds,
how to choose one, and the failure modes around picking it.

Extracted from `GAPS.md`, which now carries only the gap analysis itself.

## What is cached between restarts

**There is no theory cache.** The whole mechanism is one line of `Resources.import_name`:

```scala
if (loaded_theory(theory)) Document.Node.Name.loaded_theory(theory)
```

An import already in the heap image resolves to a *nodeless* name, so the document model
has nothing to check. Everything else resolves to a file and becomes a live node,
elaborated from source on every start. Timestamps and the build database play no part.
jEdit is identical -- it just makes you choose a session at launch, which is the step this
client used to skip.

Reported as "the LSP reverifies all theories on startup although they didn't change".
Measured against viper-roots by probing `Sessions.background` with the real options: of
its **123** theory files, exactly **one** was in the image. Two independent causes.

**The client never asked for a project session.** `isabelle.logic` defaulted to `HOL` and
nothing overrode it, so the server ran `-l HOL`. Every project heap was built and current,
and all seven component directories were already registered in `etc/components`, so no
`-d` was even needed. Only the logic name was wrong.

**And `-R`, the obvious fix, was broken.** `Language_Server.build_session` built
`Sessions.Selection.session(logic)` -- the name asked for -- while `init` loaded heaps for
`session_background.session_name`, which under `session_requirements` is a synthetic
`NAME_requirements(ANCESTOR)` holding exactly the imported theories. The named session's
heap already existed, so the pre-build check reported "nothing to do" and `session_heaps`
then demanded a heap nobody had built:

```
REQS  session_name = MainResults_requirements(ViperAbstract)
REQS  heaps wanted = FAILED: Missing heap image for session "..."
build_session builds Selection.session(logic) = MainResults
```

jEdit is unaffected because `Session.build` selects `resources.session_base.session_name`.
Fixed on `vscode-requirements-build`, now merged into `vscode-theories-panel`.

### Choosing the frontier

`-R S` caches S's import closure and leaves S's own theories live. Measured for
viper-roots:

| `-R` | image | project theories cached | prebuilt? |
|---|---|---:|---|
| `ViperCommon` | `ViperCommon_requirements(HOL)` | 1 | no |
| `ViperAbstract` | `ViperCommon` | 17 | **yes** |
| `SimpleViperFrontEnd` | `ViperAbstract` | 25 | **yes** |
| `TotalViperSemantics` | `TotalViperSemantics_requirements(TotalViperDeps)` | 30 | no |
| `ViperAbstractRefinesTotal` | `ViperAbstractRefinesTotalDeps` | 47 | **yes** |
| `MainResults` | `MainResults_requirements(ViperAbstract)` | 52 | no |

Three resolve to a *real* prebuilt heap rather than a synthetic requirements image, so
they need no build and work even without the `-R` fix.

The choice is **not** "the session owning the file you have open". A heap is an immutable
snapshot compiled against the text as it stood. Edit something inside it and your edit is
checked in isolation while every theory above keeps the stale copy. **The frontier must
sit below everything you intend to edit**, so the recommendation is the *lowest* session
currently open.

### Editing into the heap is invisible

`Resources.find_theory` resolves a path through `sessions_structure.session_directories`
and **never consults `loaded_theory`**. So a theory inside the image still opens as an
ordinary live, file-backed node and re-checks as you type. It looks completely normal.
What does not happen is anything downstream noticing.

That makes it the one failure here with no signal at all, so the client supplies one: on
the first edit to such a file it says so and offers the frontier that fixes it, chosen to
clear every open session at once rather than warn again on the next file. Computing "what
is in the image" follows **both** edges `Sessions.background` follows -- the parent chain
*and* the `sessions` clause. `MainResults` reaches `SimpleViperFrontEnd` only through the
latter, so a parent-only walk would call it live and never warn.

### The picker

The session is fixed for the life of the process: `session_name` and
`session_requirements` are constructor fields of `Language_Server` read once in `init`,
LSP `initialize` happens once per process, and `shutdown` clears the session with no path
back. Changing session therefore means restarting the server.

`src/sessions.ts` parses the ROOT files in the workspace directly rather than asking
Isabelle. `isabelle sessions` prints only names, and every route to the directories and
parents -- `isabelle sessions -D`, a dry-run build -- costs a JVM start plus a full
structure load, measured at ~20s. No picker can spend that. The grammar subset needed is
small and `Sessions.session_entry` fixes the clause order, which is what makes a linear
scan sound. Validated against the real tree: 14 sessions, cross-checked clean against
`isabelle sessions -a`.

Three things that were not obvious:

- **A ROOT in the workspace is not necessarily visible to Isabelle.** Two of viper-roots'
  own sessions live in subdirectories of a component rather than in the component itself,
  so they are absent from `isabelle sessions -a` entirely. Offering them unregistered
  would hand over a choice that fails at startup, so the picker adds the chosen session's
  ROOT directory to `sessionDirs`. A redundant `-d` is harmless: `load_root_files` keys
  `seen_roots` by canonical file and drops the repeat.
- **`-d` must be converted to Cygwin form on Windows.** Isabelle's `Path.explode` rejects
  a native path, and `vscode_server` exits 1 before replying to `initialize`. Only the
  launcher path had ever been converted; the `-d` list had not, which stayed invisible for
  as long as nobody had `sessionDirs` set.
- **The build happens inside `initialize`**, so `client.start()` does not resolve until it
  finishes -- a first start against a missing image is minutes of silence. There is no
  structured progress channel: `Channel.progress` writes through `window/logMessage` into
  the output channel. `src/build_progress.ts` therefore wraps that channel, forwards every
  line unchanged, and relays the few that say what is happening into a notification.
- **And the build emitted nothing to relay.** `Language_Server.build_session` takes
  `build_progress: Progress = new Progress` -- the base class, whose `output` is a no-op --
  and `init` never passed it, even though it had already built
  `channel.progress(verbose = true)` for the `build_started`/`build_failed` one-liners. So
  `Build.build` ran with a silent sink and the per-theory `progress.theory` calls in
  `Pure/Build/build_job.scala` went nowhere. A cold `-R MainResults` was ~20 minutes
  showing one line, then either success or `prover process remains inactive!`, with no way
  to tell a slow proof from a hang. Fixed by passing `build_progress = progress`. Because
  that progress is a `Progress.Status`, the fix also brings in the long-running-command
  lines (`command "..." running for 45s (line N of theory T)`), which are the actual
  stuck-vs-slow signal. `-v` is unrelated: it only sets `Channel`'s JSON-RPC message
  logging. Per-theory lines stay out of the *notification* on purpose -- see `suite26.js`,
  which pins that chatter rewritten every few milliseconds is worse than none.
- **A start that cannot succeed was retried forever.** With no `errorHandler` in
  `clientOptions`, the client used `DefaultErrorHandler`, which stops only when five closes
  land inside three minutes and otherwise drops the oldest timestamp and restarts. That
  assumes a restart is cheap. Here it costs the heap build, because the build runs inside
  `initialize` -- ~20 minutes against viper-roots -- so the three-minute window never closed
  and a `sorry` that failed the requirements image had the extension rebuilding, failing and
  restarting for hours. Two of those builds then overlapped and collided:
  `[SQLITE_CONSTRAINT_PRIMARYKEY] ... isabelle_sources.session_name, isabelle_sources.name`,
  because `Store.write_session_info` inserts a session's source rows outright and trusts
  `clean_session_info` to have cleared them -- one writer per session record is an
  assumption the loop broke. `src/restart_policy.ts` keys on whether the server ever
  reached Running instead of on wall-clock: a failed start is reported and not retried,
  a crash after a healthy start restarts, capped by count with no window to reset it.
  Pinned by `suite28.js`.

What the picker deliberately does **not** show is whether a choice needs a heap build.
That depends on the image `Sessions.background` computes, and nothing short of a full
structure load says whether it exists. `isabelle build -n -R S` answers a different
question -- it builds *ancestors*, reports "nothing to build" for a session whose
requirements image is missing, and takes 23s. The server reports its own build through
`build_started`, which is honest and free.

### `-i` does not do what its name suggests

`include_sessions` (`-i`) only widens the *selection* so those sessions are known for name
resolution and completion: `selected_sessions1` is built from `session1 :: session ::
include_sessions`, but the background base stays `deps1(session1)`. It makes sessions
visible; it does not cache them.

### A superseding ROOT cannot widen the live set

Defining a second session that re-claims an existing session's directory fails on a global
check -- `Duplicate use of directory`, raised while building the session structure over
**every** session in **every** loaded ROOT, not just the selected ones. A directory belongs
to exactly one session, globally. `-A` (`session_ancestor`) moves the cut point, and a
scratch session in a *new* directory works, but neither makes an already-owned theory
editable and cached at once -- those are opposites by construction.

### Multiple sessions in one server

Not an LSP-layer question. One `Session` is one ML process is one heap, and two heaps
cannot coexist in a process. Supporting N would mean N prover processes plus routing, and
it still would not help: session A's ML process cannot see live edits to a theory in
session B. The constraint is that a heap is an immutable snapshot of an entire ML state.

