theory Trace
  imports Main
begin

(* Fixture for suite30: both features need something real to act on.

   simp_trace_new suspends the simplifier at each rewrite step and waits for an answer,
   which is what makes PIDE/simplifier_trace_response carry a question at all. The
   simplification below is deliberately trivial: the point is that it rewrites, not that
   it is hard. *)

declare [[simp_trace_new mode=full]]

lemma traced: "(x::nat) + 0 = x"
  by simp

declare [[simp_trace_new mode=normal]]

(* thy_deps emits a graphview markup element in its command output, which is what
   PIDE/graphview_response decodes. Main's dependency graph is large enough to be a
   real test of the layout and small enough to arrive quickly. *)

thy_deps

end
