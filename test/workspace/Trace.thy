theory Trace
  imports Main
begin

(* Fixture for suite30's simplifier trace half.

   Two things here are load-bearing and neither is visible from the jEdit dockable.

   `interactive` is a separate flag in the attribute, defaulting to false
   (Simplifier_Trace.interactive_parser). Without it a step is downgraded to
   simp_trace_log and never sends a request, so the panel sits empty forever.

   And the traced proof must be the LAST command in the file. With `interactive` the
   simplifier really does suspend -- a batch build of this theory sits on the `by` for as
   long as you let it -- so anything after it is never processed. thy_deps lives in
   Deps.thy for exactly that reason. *)

declare [[simp_trace_new interactive mode=full]]

lemma traced: "(x::nat) + 0 = x"
  by simp

end
