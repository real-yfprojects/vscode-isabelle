# Isabelle/PIDE for stock VS Code

Isabelle/PIDE client for unmodified VS Code - no need to use a dedicated Isabelle fork of VSCodium

![Finding a function with Ctrl+T, proving a lemma by induction while the infoview follows,
typing ==> and seeing ⟹, completing lemma names, and jumping into HOL's List.thy](docs/demo.gif)

*Recorded with the [extended server](#2-turn-on-the-extended-server-optional-recommended)
turned on.*

Currently the Isabelle project ships with a fork of VSCodium that implements very
limited Isabelle language support. This extension brings more than jEdit parity
in terms of Isabelle support as a standard VS Code extension that can be added
to your existing installation.
Since Isabelle source files do not support full Unicode math glyphs, this
extension renders these glyphs properly while leaving the ASCII representation
in your `.thy` files.

## Features

- *Writing*: renders math glyphs from ASCII sources; symbol shorthands, Isar and inner syntax (e.g. HOL) completion;
  Isar and inner syntax highlighting (with semantic colours†); types and messages on hover; auto-indentation†; normalise any accidental actual Unicode characters to ASCII
- *Checking*: continuous live PIDE verification; goals and messages at the cursor in one infoview, with pinned goals (that follow your edits†); cache session management
- *Proving*: sledgehammer, find theorems† and simplifier trace† panels, overview over checked theories and timing†
- *Navigating*: outline, breadcrumbs, indexed code symbols, code folding, go to definition, find references† (across theories, by identity rather than name, also in theories not yet checked), Graph View† for theory, class, locale and code dependencies
- *Docs*: preview, documentation panel

† = these features need a patch to the Isabelle LSP. See [step 2](#2-turn-on-the-extended-server-optional-recommended).

## Getting Started

Once installed, VS Code opens a short walkthrough that goes through the steps below
and a tutorial theory to try things on. **Isabelle: Get Started** opens it again.

### Requirements

- VS Code 1.85 or newer
- [Isabelle2025-2](https://isabelle.in.tum.de/). You only need the distribution itself,
  not the VSCodium that comes with it.

### 1. Install the extension

Search for "Isabelle/PIDE" in the Extensions view and install the one by yfprojects. From
a terminal: `code --install-extension yfprojects.vscode-isabelle`.

Each release's `.vsix` is also on the
[Releases page](https://github.com/real-yfprojects/vscode-isabelle/releases), for
**Extensions: Install from VSIX…**.

### 2. Turn on the extended server (optional, recommended)

Some features need messages that Isabelle's language server doesn't send yet. The
extension comes with an extended version of the server that adds them. It gives you:

- the Query panel (find theorems and constants)
- the Theories and Timing views
- the Simplifier Trace and Graph View panels
- Go to Command
- session images for projects whose sessions import from outside their parent session
  (see step 5)
- automatic indentation, as in Isabelle/jEdit: pressing Enter indents the new line and
  re-indents the one you left, typing a space after a keyword like `qed` or `show` moves
  that line into place, and **Format Selection** re-indents the selected lines. `apply`
  lines are indented by the number of open subgoals. To turn off indentation while
  typing, set `editor.formatOnType` to off for Isabelle.
- colours for the rest of a checked term: constants, type names, classes, operators
  and numerals each get their own theme colour, not only the variables
- checking that keeps up while Sledgehammer runs: without the extended server, a proof
  you edit meanwhile is checked only when Sledgehammer is done

To turn it on, open the Settings (`Ctrl+,`, or `Cmd+,` on macOS), search for
**Isabelle: Extended Server** and tick the box. When VS Code asks, click
**Reload Window**.

There's nothing to download, and your Isabelle installation isn't changed: the extension
only starts Isabelle's language server with its additions in front. Your proofs are
checked by the same Isabelle as before. To switch back, untick the box.

This works with Isabelle2025-2. With any other version, the extension shows a warning and
starts the standard server.

### 3. Install the Isabelle fonts

Many Isabelle symbols, such as script letters and bold digits, are missing from ordinary
monospace fonts and show up as boxes. Isabelle ships fonts that cover all of them. You'll
find them in your Isabelle installation under `contrib/isabelle_fonts-*/ttf/`.
Install all the `.ttf` files in that folder:

- **Windows:** select them, right-click, *Install*
- **macOS:** open them in Font Book
- **Linux:** copy them to `~/.local/share/fonts/` and run `fc-cache -f`

Then restart VS Code and add this to your user `settings.json`
(**Preferences: Open User Settings (JSON)**):

```json
"[isabelle]": {
  "editor.fontFamily": "'Isabelle DejaVu Sans Mono', monospace"
}
```

This changes the font for Isabelle files only. The infoview uses the font automatically
once it is installed.

### 4. Open a theory

Open a folder with your theories and open a `.thy` file. The extension starts Isabelle in
the background and begins checking the text around your cursor. Errors appear as squiggles
and in the Problems view. The **Isabelle Infoview**, in the bottom panel, shows the goals
and messages of the command at the cursor. **Pin** keeps a command's goals in view while
you work elsewhere, and **Pause** stops the view from following the cursor. You can drag
the view into a side bar, or open it in an editor tab beside the theory with the
**Open in Editor** button in its title bar.

To find Isabelle, the extension first checks `$ISABELLE_HOME`. After that it looks for a
folder named like `Isabelle2025-2` in `~/Isabelle`, your home folder and `C:\` on Windows,
or in your home folder, `/opt` and `/usr/local` on Linux. If yours is somewhere else, set
`isabelle.home` to the folder containing `bin/isabelle`. On macOS that is
`/Applications/Isabelle2025-2.app/Contents/Resources/Isabelle2025-2`.

### 5. Pick a session for your project

By default Isabelle starts with the HOL session. That's fine for a few standalone
theories. In a project with its own `ROOT` file, though, everything that isn't part of HOL
gets checked from scratch each time Isabelle starts. For a larger project, that takes
minutes.

To avoid that, run **Isabelle: Select Session Image**, or click the session name in the
status bar. It lists the sessions defined in your workspace's `ROOT` files. Pick the
session you're working in. If you edit theories in several sessions, pick the lowest one,
meaning the one the others build on. Everything that session depends on is then loaded
from a prebuilt image, and only your own theories are checked live. If you later edit a
theory that is part of the image, the extension warns you, because that change won't
reach the verification cache the other theories build upon.

The first start after choosing a session builds its image, which takes a while. Later
starts reuse it.

With a stock Isabelle2025-2, building the image fails for sessions that import theories
from outside their parent session: the server reports a missing heap image. The extended
server from step 2 fixes this. [docs/sessions.md](docs/sessions.md) explains how the
images work.

## Other VS Code extensions

[Isabelle-VSCode](https://github.com/Arthur742Ramos/Isabelle-VSCode) is another
extension for unmodified VS Code. It's still an alpha and, at the time of writing, not on the
Marketplace yet. It also uses Isabelle's own language server for live checking. Beyond that
they're built differently:

- **Symbols.** This is the difference you're most likely to notice. To show `∀` instead
  of `\<forall>`, Isabelle-VSCode has a command that writes the Unicode characters into
  the file, and nothing converts them back when you save. Everything keeps working in the
  editor, since the language server accepts both forms, but `isabelle build` rejects the
  file. This extension never writes Unicode into the file: the glyphs are only drawn over
  the ASCII text, and any Unicode you paste is converted back when you save.
- **Interface to Isabelle.** Isabelle-VSCode ships its own backend, written in Scala,
  that uses Isabelle's Headless API next to the language server. That gives it things the
  language server doesn't offer, such as proof minimisation, without changing Isabelle.
  In contrast, this extension talks only to the language server, which it extends with patches written to be proposed to Isabelle itself.
  Once they're merged, the features are part of Isabelle's language server, so any
  editor that speaks the protocol can use them, and this extension needs no backend of
  its own to keep in step with Isabelle's internals.
- **Without a running prover.** Both highlight syntax, show the outline and find
  lemmas with `Ctrl+T` before Isabelle starts. Isabelle-VSCode does more at that stage:
  it highlights other uses of a name, jumps to local definitions, and lists `sorry`s.
- **Isabelle versions.** Isabelle-VSCode supports Isabelle 2019 and later. This extension
  targets Isabelle2025-2.
- **Installing.** Isabelle-VSCode needs Java 21 for its backend. Its per-platform `.vsix`
  files include one. This extension uses the Java that comes with Isabelle.

If you need an older Isabelle, or want more to work before the prover starts, give
Isabelle-VSCode a try.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for building the extension, running it from
source and running the tests.

## License

[BSD 3-Clause](LICENSE), the same license Isabelle itself uses.

The extended server (step 2) is Isabelle's own Scala code with this extension's changes
applied: the sources are branch `vscode-2025-2` of
[mirror-isabelle](https://github.com/real-yfprojects/mirror-isabelle), and the packaged
extension contains the compiled result. Both are covered by Isabelle's license, reproduced in
[server/ISABELLE-COPYRIGHT](server/ISABELLE-COPYRIGHT).

The extension's icon is a redraw of the cubes in the Isabelle logo, which was designed by
Franziska Wenzel and comes with the Isabelle distribution under the same license. This
extension is not made or endorsed by the Isabelle developers.
