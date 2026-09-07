# Gap analysis: this extension vs. official Isabelle/VSCode

What the official client does that this prototype does not, and which of those gaps
genuinely require a patched editor.

**Conclusion up front.** The fork exists for exactly **two** capabilities — a custom file
encoding and bundled fonts. Everything else in the official client is ordinary extension
code that runs unmodified in stock VS Code. Both of those two have workarounds, so a
stock-VS-Code Isabelle client is feasible; what remains is unwritten UI, not a missing
capability.

Measured against Isabelle2025-2 and VS Code 1.136.1.

---

## 1. What the fork actually patches

From `$ISABELLE_HOME/src/Tools/VSCode/patches/` and `component_vscodium.scala`:

| Patch | Purpose | Capability reason? |
|---|---|---|
| `isabelle_encoding.ts` + `.patch` | injects a `UTF-8-Isabelle` encoding into VSCodium's `encoding.ts` | **yes — encoding** |
| fonts → `app/out/vs/base/browser/ui/fonts` + `@font-face` appended to `workbench.css` | ships the Isabelle DejaVu faces inside the editor | **yes — fonts** |
| `symbols.json` written beside those fonts | the symbol table the extension reads at runtime | no — incidental placement |
| `product.json` checksum rewrite | updates the recorded checksum of `workbench.desktop.main.css` after the font CSS is appended | no — consequence of the above |
| `cli.patch`, `vscodium.patch` | branding and build plumbing | no |

That last row is independently informative: the fork must rewrite a checksum in
`product.json` because VS Code integrity-checks `workbench.desktop.main.css`. The same
mechanism covers `workbench.desktop.main.js`, which is where the encoding table lives —
so patching an *installed* VS Code after the fact would trip the "installation appears
corrupt" banner. Building a fork is the only stable way to get the encoding in.

## 2. Status of every feature

### Works today, no fork

| Feature | How |
|---|---|
| Diagnostics, hover, completion, goto-definition, document highlight | standard LSP, wired automatically by `vscode-languageclient` |
| **Sledgehammer / `try0` sendback** | **standard LSP code actions — verified, needs no PIDE-specific code** |
| Caret perspective | `PIDE/caret_update`; without it PIDE processes nothing |
| Unicode symbol display | viewport decorations over an ASCII buffer |
| Sub/superscript, bold | decorations on control symbols |
| Symbol input (`\forall` → `\<forall>`) | rewriter + completion, table from `etc/symbols` |
| Unicode-safe saving | `onWillSaveTextDocument` normaliser |
| Symbol-atomic caret motion | rebound motion commands + `wordSeparators`/`wordPattern` |
| **PIDE markup colouring and status** | `PIDE/decoration` → editor decorations, palette ported from Isabelle's own `text_color` defaults |
| **Output panel** | webview over `PIDE/dynamic_output` |
| **State panel** | webview over `PIDE/state_*`, with Update / Auto / Locate |
| **Symbols palette** | webview over the `etc/symbols` table; click inserts the escape |
| **Sledgehammer panel** | webview over `PIDE/sledgehammer_*`: prover list, run, cancel, locate, status |
| **Spell checker** | underlining arrives as a `spell_checker` decoration; the five dictionary commands are registered |

Sendback deserves emphasis because the original brief listed it as a gap. Isabelle2025
exposed it as LSP code actions, so it arrives for free. Asking for code actions on a
`try0` line returned six: `by simp`, `by presburger`, `by fastforce`, `by force`,
`by auto`, `by linarith`, each carrying a `newText` that rewrites the line.

### The LSP surface is now fully consumed

**All 32 of the 32** `PIDE/*` messages the server defines are in use. Verified
mechanically by diffing the message names in `lsp.scala` against those in `src/*.ts`.

Nothing further is reachable from a client without changing the server, which brings us
to the next section.

For reference, the official extension contributes 8 commands, 4 views, 3 configuration
properties, and **0 keybindings**.

### What jEdit still has, and why it is out of reach

The natural assumption is that Isabelle/jEdit is an LSP client and its panels therefore
ought to be reachable. It is not. **`src/Tools/jEdit/` contains no reference to LSP at
all.** jEdit is a Scala application that embeds PIDE in its own JVM and drives it through
`PIDE.session` directly. The language server in `src/Tools/VSCode/src/` is a *peer* front
end that embeds PIDE the same way and re-exposes a chosen subset over LSP.

So jEdit features do not "run through the LSP"; each one someone wanted in VS Code had to
be given protocol messages by hand. The underlying machinery is shared, which is what makes
the remaining work small rather than deep:

| jEdit dockable | Mechanism it uses | What exposing it would take |
|---|---|---|
| Query (find_theorems, find_consts) | `Query_Operation(PIDE.editor, view, "find_theorems", ...)` | **the same class the server already uses for Sledgehammer**, with a different operation name. Implemented on the `vscode-query-panel` branch of mirror-isabelle |
| Theories | `PIDE.session.phase`, per-node status | new messages for session phase and node status |
| Timing | timing data off `Document.Snapshot` | new messages; snapshot data is already server-side |
| Monitor | ML statistics plus `session.protocol_command("ML_Heap.full_gc")` | protocol plumbing and a chart; the largest of these |
| Debugger, Simplifier trace, Syslog, Raw output, Protocol, Info, Graphview | assorted direct PIDE APIs | one set of messages each |

Query is the one worth having, and the cheapest: `Query_Dockable` builds
`new Query_Operation(PIDE.editor, view, "find_theorems", ...)` while `VSCode_Sledgehammer`
builds `new Query_Operation(server.editor, (), "sledgehammer", ...)`. Only the name differs.
The branch adds one generic set of messages, so further operations cost a list entry:

```
PIDE/query_operations_request -> _response { operations }
PIDE/query_request  { operation, args }
PIDE/query_cancel   { operation }
PIDE/query_locate   { operation }
PIDE/query_status   { operation, message }
PIDE/query_output   { operation, content }
```

The client half ships behind `isabelle.queryPanel` (default off), so a stock distribution
does not get a view that silently does nothing; enabled against released Isabelle, it
reports the server as unsupported rather than waiting.

That branch is **not built**. This tree's VSCode module does not compile against a released
Isabelle2025-2 classpath -- 76 errors from unrelated API drift (`Delay_Ops`, `Output.Kind`,
`Isabelle_Platform.Bash_Context`, `Doc.Entry.print(style = ...)`) -- and building Pure from
the checkout needs a component environment the repository does not carry. Type-checking
attributes none of those errors to the files the branch touches, and `vscode_query.scala`
reports none at all, but that is evidence rather than proof.

### Genuinely needs the fork — or a workaround

| Capability | Why no extension can do it | Workaround used here |
|---|---|---|
| **Custom `UTF-8-Isabelle` file encoding** | `vscode.d.ts` documents a closed list of 50 encodings and states an unsupported name silently falls back to the default. There is no `registerEncoding`, `EncodingProvider`, or contribution point. The implementation is compiled into the checksummed `workbench.desktop.main.js`. | keep the buffer ASCII and render Unicode with decorations, so no second representation exists to desynchronise |
| **Bundled fonts** | extensions cannot ship fonts (microsoft/vscode#181157, closed as not-planned) | install Isabelle's own TTFs system-wide and set `editor.fontFamily`. Fonts, unlike encodings, *are* an OS-level resource — this is a real fix, not a hack. It is also mandatory: 102 of the 439 codepoints in `etc/symbols` are above U+FFFF |

## 3. One upstream bug, and how it is avoided

`PIDE/decoration` itself is **not** affected — markup colouring works on Isabelle2025-2.
(An earlier draft of this document claimed otherwise; that was wrong.) What breaks is the
*panel* path: with `vscode_html_output=false`, every output event fails with

```
*** Session consumer failure: "isabelle.vscode.Dynamic_Output"
*** Bad JSON value: isabelle.vscode.LSP$$$Lambda/0x...
```

`LSP.Dynamic_Output.apply` and `State_Output.apply` call `decorations.map(_.json)`, but
`Decoration.json` takes a `JFile` parameter, so an eta-expanded lambda lands in the JSON.

Already fixed upstream by `c1a8c7bcf2`, which splits `json_entries` (a value) from
`notification(file)`. Its commit message notes the split was restored because it is
"required for unproven Neovim experiments" — i.e. for exactly this class of
non-VSCodium client.

This extension therefore defaults to `vscode_html_output=true`, which takes the branch
passing `None` for decorations. That both avoids the bug and hands the panels ready-made
HTML, which is what a webview wants anyway — so the workaround costs nothing.

## 4. What is measured vs. inferred

Verified by running it:

- `isabelle build` rejects literal Unicode, for ordinary *and* control symbols
- `isabelle vscode_server` runs headless over stdio and drives fine from a stock client
- the server applies `Symbol.encode` to editor text, so a Unicode buffer would also work
- sendback arrives by *two* independent paths: as LSP code actions on the goal line
  (a `by simp` action appears there), and as `<sendback>` elements inside
  `PIDE/sledgehammer_output`, which the panel turns into clickable buttons. Clicking one
  round-trips `sledgehammer_sendback` -> `sledgehammer_insert` and edits the theory.
  An earlier note here claimed the panel stream carried progress only; that was wrong,
  the automated poll simply gave up before the final message arrived
- Isabelle's spell-checker underlining needs no client code: it arrives as an ordinary
  `spell_checker` decoration through `PIDE/decoration`
- decoration cost, symbol rendering alone with no server: ~1.7 ms viewport-scoped vs
  17 ms whole-document (5 k ranges) and 233 ms on a 144 k-line file; linear in range
  count, flat in file size
- decoration cost with the server attached, 9 k-line theory, interleaved rounds: only
  one difference exceeds the noise floor -- whole-document PIDE markup (29-55 ms typing,
  41-63 ms scroll) against everything else (~4-18 ms). Viewport scoping is a real win;
  the remaining differences, symbol rendering included, are not measurable here
- a formatter or `onWillSave` participant can force ASCII onto disk, but always rewrites
  the buffer too, so it cannot serve as a round-trip encoding layer
- PIDE markup decorations arrive and are applied (8 types, 22 ranges on a small theory)
- the Output and State panels receive content; the State panel reports `1. P ⟹ P`
- the extension's own behaviour, in the six integration suites

Not verified:

- **Linux and macOS.** Only the Windows/Cygwin launch path has actually run
- the panels still listed as missing in §2
- any decoration cost below ~20 ms. The language server processes in the background
  throughout, moving the baseline by more than the effects being compared; resolving
  finer differences would need a quiesced server, which this harness cannot guarantee

## 5. If this were taken further

In rough order of value per effort:

1. **Build and test the `vscode-query-panel` branch**, then turn `isabelle.queryPanel`
   on by default. Everything else on the jEdit list needs new protocol messages designed
   from scratch; this one is already written and only needs a build environment.
2. **A `.vsix` and CI** — plus testing the non-Windows launch path.
5. **Upstream `Content.recode_symbols`** — the server already computes exactly the edits
   the save normaliser needs, but the method is dead code, referenced nowhere. Exposing
   it over LSP would let clients share one implementation.
