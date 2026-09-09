theory Trace
  imports Main
begin

(* Fixture for suite30: both features need something real to act on.

   The `interactive` keyword is load-bearing and easy to miss: it is a separate flag in
   the attribute, defaulting to false (Simplifier_Trace.interactive_parser), and without
   it a step is downgraded to simp_trace_log and never sends a request. mode=full alone
   produces a trace that logs and never asks, so the panel would sit empty forever.

   The simplification below is deliberately trivial: the point is that it rewrites, not
   that it is hard. *)

declare [[simp_trace_new interactive mode=full]]

lemma traced: "(x::nat) + 0 = x"
  by simp

declare [[simp_trace_new mode=normal]]

(* thy_deps emits a graphview markup element in its command output, which is what
   PIDE/graphview_response decodes. Main's dependency graph is large enough to be a
   real test of the layout and small enough to arrive quickly. *)

thy_deps

end
