# Contributing

You need Node.js, VS Code and an Isabelle2025-2.

```sh
npm install
npm run build        # compiles the extension and brings the extended server's jar up to date
```

`npm run build` is `npm run compile` (or `watch`, for the extension alone) plus a check of
the jar: a second when the server's source hasn't changed since its last build, a few
minutes of Isabelle/Scala compile when it has. An installation of the extension that runs
from this folder, like a link in `~/.vscode/extensions`, picks up both: the extension on
**Developer: Reload Window**, the server on **Isabelle: Restart Server**.

## Trying your changes

Press **F5** in VS Code, or run `npm run dev`. Both compile the extension and open an
Extension Development Host on [test/workspace](test/workspace), using a separate profile
in `.dev-profile/`. Your normal VS Code settings and extensions are left alone. That
profile turns on the extended server and the experimental panels.

The launcher uses the Isabelle the extension would find (`ISABELLE_HOME`, or the newest one
in `~/Isabelle`), with the extended server, `server/Isabelle2025-2.jar` (see
[Getting Started, step 2](README.md#2-turn-on-the-extended-server-optional-recommended)).
It rebuilds that jar first whenever the server's source has changed since the last build,
which takes a few minutes; otherwise it starts right away. The source is your checkout of
the server at `../mirror-2025-2` if you have one (or wherever `ISABELLE_SERVER_SOURCE`
points), else the commit in `server/Isabelle2025-2.ref`. To use a hand-patched Isabelle
instead, set `ISABELLE_PATCHED_HOME`.

## Tests

The tests drive a real VS Code, and most of them a real Isabelle too. They find Isabelle
the same way the extension does. VS Code is taken from its usual install location, or
downloaded into `.vscode-test/` if it isn't installed.

```sh
npm run test:unit                   # suites without a prover, fast
node test/runAll.js                 # the full regression set, 3 at a time
node test/runAll.js suite4 suite16  # only these
npm test -- suite6.js               # one suite, output straight to the terminal
```

Set `ISABELLE_TEST_JOBS` to change how many suites `runAll.js` runs at once. Each suite
starts its own VS Code and, usually, its own Isabelle, so more than 3 at a time tends to
cause timeouts.

The suites for the experimental panels (`suite15`, `17`, `30`, `33`, `36`), for indentation
(`suite37`) and for inner-syntax colours (`suite39`) run against the
extended server when its jar is built, and skip themselves otherwise. Setting
`ISABELLE_PATCHED_HOME` points them at a hand-patched Isabelle instead.

Some suites are not in the regression set:

| Suites | What they need |
|---|---|
| `suite24` | The extended server, plus a project with two sessions in `ISABELLE_TEST_PROJECT` |
| `suite3`, `7`, `10`, `11`, `13`, `20`, `22` | Nothing, but they only keep a window open for screenshots. They check nothing on their own. |
| `suite8` | A performance measurement, not a pass/fail test |

CI ([.github/workflows](.github/workflows)) runs the unit suites, builds the extended
server, then runs the regression set against a released Isabelle with that jar on Linux,
macOS and Windows, and builds the `.vsix` with the same jar in it.

## Changing the language server

The extended server is branch `vscode-2025-2` of
[mirror-isabelle](https://github.com/real-yfprojects/mirror-isabelle): the Isabelle2025-2
release plus our changes. Work in a checkout of that branch at `../mirror-2025-2`
(`git worktree add ../mirror-2025-2 vscode-2025-2` in your mirror-isabelle clone): the dev
launcher then builds the jar from it, uncommitted changes included. The tests use whatever
jar is there, so after changing the server run `npm run build` or the launcher once, or
build by hand:

```sh
scripts/build-server-jar.sh ~/Isabelle/Isabelle2025-2 ../mirror-2025-2
```

To ship a change, commit and push it there, then put the new commit in
`server/Isabelle2025-2.ref`. CI builds the packaged jar from that commit.

Two kinds of change can't ship this way, because the jar carries only compiled code: new
system options (read them with a fallback, as the completion options do) and new Scala
services. [docs/building.md](docs/building.md) has the details, and how the branch relates
to the ones proposed upstream.

## Packaging

```sh
npm run package      # writes isabelle-pide-stock.vsix
```

## Generated files

Two files are generated from an Isabelle distribution rather than written by hand. Rerun
the scripts when moving to a new Isabelle release:

- `syntaxes/isabelle-grammar.json` comes from Isabelle's keyword and symbol tables:
  `echo ':load scripts/gen_grammar.scala' | isabelle scala`, from the repository root.
  The outer half matches upstream's grammar. What it adds is inner syntax, so terms in
  `"…"` and `‹…›` are not one string. `suite38` checks the result.
- `src/colors.ts` comes from the colour palette of the official Isabelle/VSCode:
  `node scripts/gen_colors.js <isabelle-dir> src/colors.ts`

## Further reading

[docs/](docs/) has the notes on how things work and why:
[GAPS.md](docs/GAPS.md) compares the extension with the official Isabelle/VSCode and jEdit,
[building.md](docs/building.md) covers the extended server and its branches,
[sessions.md](docs/sessions.md) explains session images,
[panels.md](docs/panels.md) covers the panel design, and
[troubleshooting.md](docs/troubleshooting.md) lists behaviour that looks like a bug but isn't.
