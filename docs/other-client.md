# Isabelle-VSCode (Arthur742Ramos): notes

The comparison as it stood before the README was rewritten, kept for the evidence behind
the encoding claim. Written against `0.1.0-alpha.6`.

[Arthur742Ramos/Isabelle-VSCode](https://github.com/Arthur742Ramos/Isabelle-VSCode) (MIT,
`0.1.0-alpha.6`) attacks the same problem and makes the opposite architectural bet. It
ships its own Scala backend that drives Isabelle's **Headless** API directly and treats
`isabelle vscode_server` as an optional relay; this client drives the released server and,
where the protocol runs out, patches Isabelle itself. So it reaches PIDE operations the
LSP does not expose -- proof minimization, for instance -- without touching Isabelle, at
the cost of maintaining a bridge against Isabelle's internal Scala API. Nothing here can
diverge from what PIDE says, but the LSP surface is the ceiling.

It is the more finished *product*: eight per-platform `.vsix` builds with a bundled JRE, a
release pipeline, and a large tier of syntactic features that work before -- or entirely
without -- a prover.

The one difference worth knowing before choosing is the encoding. It has no equivalent of
the presentation-only rendering and the save-time normaliser described above: its
`Convert Symbols to Unicode` command rewrites the buffer to literal glyphs, `Insert Symbol`
inserts them one at a time, and no save participant converts them back -- the inverse
command exists, but running it is left to the user. Completion is the exception: both its
offline symbol completion and its PIDE abbrev completion insert the ASCII token. The
deeper reason is that it has no rendering layer at all -- no `contentText` decorations, no
inlay hints, its decorations being PIDE status and error squiggles -- so glyphs in the
buffer are the only way to read a theory in symbols there. Which is silent while you work:
they survive interactive checking, because the server re-encodes whatever the editor
sends, while the file on disk stops building.
Verified against Isabelle2025-2 by running their own `symbolsToUnicode` over a theory and
building both forms with the same `isabelle build -d <root> <session>` their own build
runner constructs: the ASCII original succeeds, the converted file fails with
`Inner lexical error ... at "?x::nat. x = x"`.
