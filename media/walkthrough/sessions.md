# Session images

A **session** is a group of theories named in a `ROOT` file. The session image is
what Isabelle loads at start: everything in it comes from a prebuilt heap and is
never checked again. Everything else is checked from source on every start.

- Pick the session you edit, or the lowest one if you edit several.
- The first start with a new session builds its image. That can take a while;
  later starts reuse it.
- If you edit a theory that is inside the image, the status bar warns you.

Also: the status bar item's tooltip, [Show Output Log](command:isabelle.showOutput)
when something goes wrong, and an [Isabelle terminal](command:isabelle.openTerminal)
with `isabelle` on the path.

More in [docs/sessions.md](https://github.com/real-yfprojects/vscode-isabelle/blob/main/docs/sessions.md).
