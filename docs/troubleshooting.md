# Behaviours that look like bugs

Five things that were reported, or looked wrong, and turned out to have precise causes:
two in how a glyph is drawn, one in how PIDE reports a theory whose imports have not
loaded yet, one in how decoration colours fight a colour theme, one in how the prover
schedules Sledgehammer.

Extracted from `GAPS.md`, which now carries only the gap analysis itself.

## Where a glyph is drawn, and why the caret looked wrong

Symbol rendering hides the escape text and supplies the glyph as an attachment. It was a
`before` attachment on the escape range, which produced a bug worth recording because the
logic was never wrong: pressing Left across `A \<and> B` walks 19 -> 18 -> 12 -> 11,
exactly one visual unit per press.

Attachment content is laid out inside the span of the character it attaches to, and VS
Code derives a column's x by measuring the DOM up to that point. A `before` glyph on the
range start therefore counts towards the *preceding* boundary, so the caret for the
escape's start was drawn to the right of the glyph. One press of Left appeared to do
nothing and the next appeared to skip the glyph and the space in front of it together.

Selecting only the space before a glyph made it visible: the highlight covered the glyph
too. Moving to an `after` attachment simply mirrored the fault -- the glyph then counted
towards the *following* boundary, and the space after a glyph was swallowed instead.

Neither attachment can be right, because the content is emitted outside whichever
boundary it names. The fix is to stop asking one attachment to cover the whole escape:
the range is split, all but its final character is hidden, and the glyph attaches
`before` that last character. Columns `start..end-1` then collapse ahead of the glyph and
`end` lands after it, so selecting the space on either side highlights one blank cell with
the glyph outside it. It took three attempts, which is why the geometry is written down.

The same file had a second latent defect. `textDecoration` is the only decoration option
that takes raw CSS, so it is how one smuggles in a property the API does not expose --
but `'none; font-size: ...'` also *sets* `text-decoration: none`, on the very element VS
Code underlines to show a name is clickable. Starting the string with `;` leaves that
declaration empty, so the parser drops it and keeps the rest.

## A failure that is not one: unresolved imports

Opening a workspace briefly showed a theory as *failed*, which then cleared once its
dependencies loaded. The status was not wrong. Dependency resolution is asynchronous, so a
theory opened before its imports are loaded has a failing **header** -- `imports Mid`
cannot be resolved -- and PIDE reports that as a failed command like any other. Reproduced
with a same-session import chain:

```
25.6s  loading=true   (no nodes yet)
26.3s  loading=true   Work.Top=10% FAILED:1 init:false tot:10
27.3s  loading=false  Work.Mid=100% init:true | Work.Top=100% init:true
```

On a large project the middle state lasts long enough to look like a real failure. Nothing
in the protocol let a client tell the two apart, so `PIDE/theories_response` now carries
`loading` (resolution still in flight) and each node carries `initialized` (did the header
go through). A node counts as *settling* only when both hold, which is what makes the
suppression safe in each direction: `loading` is temporal, so a genuinely bad import
surfaces as soon as resolution finishes rather than being hidden for the session, and
`initialized` is per node, so a proof that really failed elsewhere is never suppressed.

## Ctrl+hover over a glyph

The editor marks a name as clickable by underlining it, and that never reached a rendered
symbol. The underline is a decoration on the *text*, which here is collapsed to nothing,
while the glyph lives in an attachment span that another decoration cannot style -- so the
underline was drawn, invisibly, under a zero-width string.

There is no API for "the user is holding Ctrl". But VS Code asks the definition provider
for a location precisely when deciding whether to draw that link, so the
`provideDefinition` middleware is the signal, and it carries the exact position. The glyph
is then moved onto a second decoration type whose own attachment carries the underline.
The mark is applied only when the server actually answers with a location, so a glyph is
never made to advertise a jump that does not exist, and it is withdrawn shortly after the
last request -- there is no "hover ended" event.

Underlining in place was chosen over expanding the escape to raw text. Expanding would
also work, and would show what you are jumping from, but `\<and>` is eight columns wider
than the glyph: the line reflows under the pointer, the character being hovered moves, and
the next request arrives for a different position.

## Colour themes and checked text

PIDE markup was painted with decorations whose colours come from `src/colors.ts` --
Isabelle's `text_color` defaults, which are themselves VS Code's Dark+/Light+ values. A
decoration `color` overrides everything, so installing a theme recoloured only the text
PIDE had not reached yet: unchecked code followed the theme through the TextMate grammar,
and checked code snapped back to what looked like the default theme. It was the Isabelle
palette winning.

Semantic tokens are the mechanism built for this. `src/semantic_tokens.ts` serves the
`text_*` categories as tokens the editor colours from the theme, and the `text_*`
decorations are then *not* applied -- the two are mutually exclusive by construction,
since a decoration would override the theme again.

Themes do not know Isabelle's categories, so each custom token type is declared in
`package.json` with a `superType` and a `semanticTokenScopes` mapping to ordinary
TextMate scopes (`keyword.control`, `variable.other`, ...). A theme that has never heard
of Isabelle then styles them by rules it already has. `main` is deliberately not
tokenised: it is Isabelle's plain-text colour, and leaving it alone is what lets the
theme's editor foreground show through.

None of this shows unless semantic highlighting is on. `editor.semanticHighlighting.enabled`
defaults to `configuredByTheme`, and a theme that does not declare it -- Breeze Dark, for
one -- turns it off, which left checked text with the TextMate grammar only: no
free/bound/schematic distinctions, no constants or types. So the extension defaults it to
`true` for Isabelle files alone (`configurationDefaults` in `package.json`). To opt out,
set it for `[isabelle]` in your settings. `isabelle.markupColors: isabelle` restores the
palette for anyone who prefers it.

Keywords use token types of their own (`isabelleCommand`, `isabelleMinorKeyword`,
`isabelleAsmKeyword`, `isabelleImproper`), each mapped to the scope the grammar gives the
same words, so a keyword does not change colour when checked. They avoid the standard
`keyword` type on purpose: an extension can remap a standard type for every language, and
the Lean 4 extension does (`keyword` to `keyword.other`), which turned every checked
Isabelle command orange in Breeze Dark. To colour one category yourself, name its type in
`editor.semanticTokenColorCustomizations`, e.g. `"isabelleImproper": "#ED1515"` for
jEdit's red `apply`.

## Edits that wait for Sledgehammer

While Sledgehammer ran, a proof edited near the caret showed nothing new -- no error, no
goal -- until Sledgehammer was done, about 20 s later. An edit in its first two seconds
went through, which made it look intermittent. The cause is in the prover's scheduling,
so Isabelle/jEdit and Isabelle's own language server behave the same.

Sledgehammer forks all its prover slices at once (`Par_List.map`, 24 per worker thread),
and a forked task inherits the priority of the task that forks it. The panel's query runs
in the print's task, which `Command.run_process` enrolls with priority 0, whatever the
query was registered with. The proof of an edited command is forked too
(`Proof.future_terminal_proof`, `Toplevel.future_proof`), at priority ~1: the lowest in
Pure. So the queue ran every slice forked before the edit first. The first two seconds go
through because Sledgehammer is still filtering facts and has forked nothing yet.

It is the order, not a shortage of workers: none is held for long (a slice runs its
external prover for 1--7 s, and a trace of the processes showed at most five at once), but
each freed worker took the next slice. Lowering the query's registered priority changes
nothing either, for the reason above. So the extended server loads
`vscode_sledgehammer.ML` as a prelude, which registers the panel's query again, unchanged
except that Sledgehammer runs in a task of its own at priority ~2, below everything the
document's checking forks. Measured on the same theory, an edit took 0.8--3 s to check
throughout two whole runs, against up to 28 s before; Cancel still reaches the run and its
slices, since they are subtasks of the print's exec. `suite53` checks both, and that a
proof is still found.
