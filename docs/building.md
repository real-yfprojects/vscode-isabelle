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
 +- vscode-indent                         (indentation; cherry-picked from vscode-2025-2)

main                                       (all of the above, merged)

8d9ad3f298  (the Isabelle2025-2 release, on master's history)
 +- vscode-2025-2                         (the backport users run; see below)
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

### The release branch: what users run

The Isabelle2025-2 release is commit `8d9ad3f298` of the mirror ("refer to
Isabelle2025-2", tagged as changeset `89701cf1768e`, the release's `ISABELLE_ID`), and its
sources are byte-identical to the distribution's. Branch `vscode-2025-2` starts there and
carries the backport as ordinary commits, so there is one place for it and git does the
bookkeeping:

```
e9d097fc51 Indent Isar text on ENTER, after a keyword, and on Format Selection
1fb089268c Fall back to the default completion options when they are undeclared
07729686c2 Make VS Code completion follow VS Code's model, ...   (cherry-picked from main)
83ee62f24f more robust Event_Timer.request: ...                   (cherry-picked from upstream)
611ffd078e Backport PIDE/goto_command from the development tree   (part of upstream c6e10a50c9)
fd119bbc53 Send parent, kind and outcome with each simplifier trace entry   (cherry-picked)
4039a52662 Render simplifier trace content as the State panel does         (cherry-picked)
e398362add Backport the VSCode server changes on main to Isabelle2025-2   (main at 2861562116)
8d9ad3f298 refer to Isabelle2025-2;
```

Work on the language server happens in a worktree of this branch (`git worktree add
../mirror-2025-2 vscode-2025-2`), against the release it will ship on. A change goes to the
development-tree branches by cherry-pick when it is proposed upstream; the conflicts to
expect are the divergences in the table below. For the next release, start a new branch
from its release commit and cherry-pick again.

To try a change, build the jar from the worktree as it stands and run the suites against
a stock distribution with `isabelle.extendedServer` on (suite36 does exactly that):

```
scripts/build-server-jar.sh <path to Isabelle2025-2> ../mirror-2025-2
```

To ship it, commit on `vscode-2025-2`, push, and move `server/Isabelle2025-2.ref` in this
repository to the new commit. CI builds the packaged jar from that commit.

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
   target to 21 is enough for `lib/classes/isabelle.jar`. The Java components built after
   it, the graph browser first, then stop at `invalid source release: 25` (localized:
   `Ungültiges Quellrelease`) from `-source 25 -target 25` in `ISABELLE_JAVAC_OPTIONS`;
   lower those too if they matter.
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



## The extended server users get

Users do not build anything. The extension ships `server/<IDENTIFIER>.jar` -- the
release's `lib/classes/isabelle.jar`, recompiled with the backport -- and the
`isabelle.extendedServer` setting starts `vscode_server` with that jar at the head of
`CLASSPATH`. `getsettings` seeds `ISABELLE_CLASSPATH` from `CLASSPATH` before any
component appends to it, so every `isabelle.*` class loads from the jar and none from
the distribution, which is never written to. Verified with `-verbose:class` against a
stock Isabelle2025-2: `isabelle.Isabelle_Tool` loads from the prepended jar.

The extension uses the jar only when `etc/ISABELLE_IDENTIFIER` names the release it was
built for, since Scala classes compiled against one release do not link against another.
Anything else falls back to the standard server with a warning.

### What is in it

The commit named in `server/Isabelle2025-2.ref`, currently the tip of `vscode-2025-2`
above: `main` of mirror-isabelle, including the completion work, plus the two
`vscode-simplifier-trace` commits not yet merged there -- adapted to the release as in the
table above -- and indentation (onTypeFormatting and rangeFormatting, jEdit's indentation
rule), which was written on this branch first. And two things from the development tree
that 2025-2 lacks:
`PIDE/goto_command`, and upstream's `f425404488`, without which one failing delayed event
kills the JVM's only timer thread and with it every later delayed event of the server
(output, caret updates, panel updates), while the server otherwise stays up.

### A limit: no new Scala services

Isabelle collects Scala services from a record inside *every* jar on the classpath
(`Classpath.services`), and the distribution's `isabelle.jar` stays on it, behind this
one. A jar built with the usual `services` entry therefore registers every service twice,
and the prover dies at startup with `Exception- DUP "echo" raised` -- which is what the
first build of this jar did, reported by the server only as `Return code: 127`. So the
jar is built without a services record: the distribution's record names the same classes,
and they load from this jar, which comes first. The build script refuses a backport that
changes the services list, since this arrangement cannot carry that.

### A limit: no new system options

Only compiled code travels in the jar. Isabelle reads the declarations of system options
from each component's `etc/options` at run time (`Options.init`), and the environment
cannot add a component: `getsettings` resets `ISABELLE_COMPONENTS`. So a backported change
that declares a new option -- the completion work does, `vscode_completion_delay` and
`vscode_completion_limit` -- fails against a stock distribution as soon as the option is
read, with `Unknown option`. Such a change has to fall back to a default when
`options.defined(name)` is false before it can go onto `vscode-2025-2`; `1fb089268c` does
that for completion, as a release-branch commit, since the development tree has the
declarations. Keep the defaults there in step with `etc/options`.

The one component a user always has besides the distribution is `$ISABELLE_HOME_USER`
(`~/.isabelle/Isabelle2025-2`), and its `etc/options` is read too. Declaring options by
writing there would work, but it edits the user's Isabelle settings for every tool, jEdit
included, and has to merge with whatever the user keeps there; the fallback is simpler.

### Building the jar

```
scripts/build-server-jar.sh <path to Isabelle2025-2> [<checkout of vscode-2025-2>]
```

With `--if-stale` it builds only when the jar was not made from exactly this source --
the commit, a checkout's uncommitted changes and new files, and the script itself, hashed
into `server/<IDENTIFIER>.jar.source` after each build; the dev launcher runs it that way on
every start. With a checkout it builds that tree as it stands; without one it fetches the
commit in
`server/Isabelle2025-2.ref` -- one commit, no history, and of its tree only the Scala and
Java sources and `etc/build.props` (`MIRROR_URL` overrides where from). Either way it
writes `server/Isabelle2025-2.jar` in a few minutes and only reads the distribution: the
sources go into a scratch component, and Isabelle's own `Setup build` compiles that
component alone with the distribution's toolchain. On Windows it re-runs itself under the
distribution's Cygwin bash, after fetching, since that Cygwin has no git. CI builds the
jar the same way in the `package` job and checks that it lands in the `.vsix`.
