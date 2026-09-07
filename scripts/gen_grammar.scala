// Regenerate syntaxes/isabelle-grammar.json from a distribution's own keyword table.
//
// The grammar is not hand-written: Isabelle generates it from the keywords of a built
// session, so it stays in step with the logic. Upstream does this inside
// `isabelle component_vscode_extension`, which also runs yarn and vsce; this calls just
// the grammar half.
//
// Run it against the target distribution, adjusting the output path:
//
//   isabelle scala < scripts/gen_grammar.scala
//
// The TextMate scopes it produces (comment.block.isabelle, string.quoted.*, keyword.*)
// give instant highlighting before the prover attaches, and give general spell-checking
// extensions something to scope to.

isabelle.vscode.Component_VSCode.build_grammar(
  isabelle.Options.init(),
  isabelle.Path.explode("syntaxes"))
