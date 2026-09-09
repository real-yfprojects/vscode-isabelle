# Building and backporting

How the server-side branches in the `mirror-isabelle` tree relate to each other, how to
build them, and which Isabelle they target.

Extracted from `GAPS.md`, which now carries only the gap analysis itself.

## How the mirror branches relate

They are **stacked, not independent**, which matters when picking one up:

```
master                                     (clean mirror of upstream Isabelle)
 +- vscode-query-panel                    (Query)
 +- vscode-requirements-build             (the -R build fix)
 +- vscode-theories-panel                 (Theories/Timing)
     merged: vscode-requirements-build
      +- vscode-simplifier-trace          (+ build progress, + Simplifier trace)
          +- vscode-graphview             (+ Graph view)

main                                       (all of the above, merged; install from here)
```

The feature branches exist to be proposed upstream one at a time, so they stay separate
and each keeps its own history. They were stacked because each was developed against the
last, not because the features depend on each other, so anyone upstreaming them should
expect to split them apart again.

`main` is the integration branch and the one to install from: `vscode-graphview` merged
with `vscode-query-panel`, which is everything. It is deliberately *not* `master` --
`master` stays a clean mirror of upstream so it can be pulled and the feature branches
rebased onto it without dragging the merges along. Merging the two conflicted only in
`language_server.scala`, in four places that are all purely additive (each panel's
declaration, `init`, `exit` and message-dispatch case), so both sides are kept.

Verified by building: Isabelle/Scala compiles from the merged tree and
`lib/classes/isabelle.jar` carries `VSCode_Query`, `VSCode_Theories`,
`VSCode_Simplifier_Trace`, `VSCode_Graphview` and `Language_Server` together.

## Reproducing the build

There are two routes, and which one applies depends on whether the change backports.

### Backporting a branch onto a released distribution

No Mercurial and no component downloads are needed. The APIs the query branch uses
(`Query_Operation`, `JSON.strings`, `Notification0`) all exist in Isabelle2025-2, so it
backports onto a release, which already has every component:

1. Copy the distribution (about 2.3 GB) and clear the read-only attributes robocopy
   preserves, or the sources cannot be edited.
2. Apply the branch's source changes plus the `etc/build.props` entry. That entry is easy
   to miss and is what the source list is taken from; without it the module is not
   compiled at all and `language_server.scala` fails with `Not found: type VSCode_Query`.
3. `isabelle scala_build -f` in the copy.
4. Point `isabelle.home` at the copy, set `isabelle.queryPanel`, and run `test/suite15.js`
   with `ISABELLE_QUERY_HOME` set to it. The suite skips itself when that is unset.

The same recipe applies to `vscode-theories-panel`, driven by `test/suite17.js` with
`ISABELLE_PATCHED_HOME` set. Both branches can be applied to one copy. Mind the four
divergences listed below when backporting: they are compile errors, except
`PIDE/goto_command`, which fails silently at run time.

Pin `ISABELLE_IDENTIFIER` for the copy so `ISABELLE_HOME_USER` does not overlap with the
working installation's settings, preferences and heaps.

### Compiling the mirror tree itself

Backporting stops working once a change depends on development-tree APIs, and it never
type-checks the tree the change actually lives in. Compiling the mirror directly is
possible without downloading the component set, by borrowing the release's, but four
things get in the way and none of them are obvious:

1. **Line endings.** With `core.autocrlf=true` -- the default on a Windows checkout --
   every shell script in the tree is CRLF, and `bin/isabelle` dies at
   ``syntax error near unexpected token `do'``. `git archive` honours autocrlf too, so
   exporting needs it off explicitly:
   `git -c core.autocrlf=false archive HEAD | tar -x -C <dest>`. This also keeps the
   working tree untouched.
2. **No components.** A source checkout has no `contrib/`: no JDK, no Scala, nothing. A
   directory junction to a release's `contrib` supplies them, and the release's
   `contrib/...` lines from its `etc/components` have to be appended to the tree's own
   `etc/components`, which lists only built-in source components.
3. **Version skew, in `etc/settings`.** The borrowed toolchain is older than the tree
   expects (jdk-21 and scala-3.3.4 against the jdk-25 and scala-3.3.8 in
   `Admin/components/main`), which shows up as two unrelated-looking failures:
   `Unrecognized option: --sun-misc-unsafe-memory-access=allow`, a JDK 24+ flag in
   `ISABELLE_JAVA_SYSTEM_OPTIONS`, and `25 is not a valid choice for
   -java-output-version` in `ISABELLE_SCALAC_OPTIONS`. Dropping the flag and lowering the
   target to 21 is enough.
4. **The setup jar is a prebuilt component**, and `src/Tools/Setup/etc/build.props` says
   `no_build = true`, so `scala_build` will not refresh it. The borrowed one predates the
   tree's `Environment.java` and produces a genuinely baffling error --
   `Found: Boolean | Null, Required: Boolean` on `Environment.is_windows()`, whose Java
   signature is a primitive `boolean`. Under `-Yexplicit-nulls` an older jar's signature
   reads as nullable. Compile the tree's own `src/Tools/Setup/src/*.java` (FlatLaf, in the
   release's contrib, is needed for `GUI_Setup`), `jar cfe ... isabelle.setup.Setup`, and
   point a local component at it rather than writing into the borrowed `contrib`.

What remains excluded is `src/Pure/System/scalajs.scala`, which needs a Scala.js component
the release does not ship, and with it `component_vscode_extension.scala` and its entry in
`isabelle_tool.scala`. Both are packaging tools for the VSCodium extension; the language
server references neither. So this route type-checks all of Isabelle/Scala except the
Scala.js packaging path -- which is what a server-side change needs -- but it is not a
substitute for a full component set if the change touches those files.


## Which Isabelle this client targets

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

