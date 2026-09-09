theory Deps
  imports Main
begin

(* Fixture for suite30's graph half.

   thy_deps emits its graph through Graph_Display.display_graph, which writeln's an
   Active graphview markup element carrying the encoded graph as its body. That is what
   PIDE/graphview_response finds in the command results and decodes.

   Separate from Trace.thy because the traced proof there suspends the simplifier, and a
   suspended command stops everything after it in the same theory from running. *)

thy_deps

end
