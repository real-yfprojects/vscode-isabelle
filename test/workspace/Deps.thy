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

(* locale_deps takes the other route, Graph_Display.display_graph_old: `browser` markup
   around the old Graph Browser text format, which the server has to parse itself. Own
   locales, so there is a known diamond to look for among Main's. *)

locale DepsA = fixes a :: nat
locale DepsB = DepsA + fixes b :: nat
locale DepsC = DepsA + fixes c :: nat
locale DepsD = DepsB + DepsC

locale_deps

end
