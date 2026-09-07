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

Sendback deserves emphasis because the original brief listed it as a gap. Isabelle2025
exposed it as LSP code actions, so it arrives for free. Asking for code actions on a
`try0` line returned six: `by simp`, `by presburger`, `by fastforce`, `by force`,
`by auto`, `by linarith`, each carrying a `newText` that rewrites the line.

### Missing, but plainly feasible as a normal extension

None of these need a fork. They are unwritten UI, mostly webviews over PIDE messages
the server already sends. This extension uses **1 of the 32** `PIDE/*` protocol messages.

| Feature | Protocol | Notes |
|---|---|---|
| PIDE markup colouring, processing status | `PIDE/decoration`, `decoration_request` | needs `vscode_pide_extensions=true`. **Blocked on Isabelle2025-2** — see §3 |
| Output panel | `PIDE/dynamic_output`, `output_set_margin` | webview |
| State panel | `PIDE/state_init`, `state_output`, `state_update`, `state_auto_update`, `state_locate`, `state_exit`, `state_set_margin` | webview |
| Sledgehammer *panel* | `PIDE/sledgehammer_request`, `_provers_request`, `_status`, `_output`, `_cancel`, `_locate`, `_sendback`, `_insert` | the panel is missing; sendback itself already works |
| Symbols palette | none | pure UI; the table is already parsed |
| Documentation browser | `PIDE/documentation_request/_response` | webview |
| Preview panel | `PIDE/preview_request/_response` | webview |
| Spell checker | `PIDE/include_word`, `_permanently`, `exclude_word`, `reset_words` | four commands |

For reference, the official extension contributes 8 commands, 4 views (Symbols,
Documentation, Sledgehammer in the activity bar; Output in the panel), 3 configuration
properties, and **0 keybindings**.

### Genuinely needs the fork — or a workaround

| Capability | Why no extension can do it | Workaround used here |
|---|---|---|
| **Custom `UTF-8-Isabelle` file encoding** | `vscode.d.ts` documents a closed list of 50 encodings and states an unsupported name silently falls back to the default. There is no `registerEncoding`, `EncodingProvider`, or contribution point. The implementation is compiled into the checksummed `workbench.desktop.main.js`. | keep the buffer ASCII and render Unicode with decorations, so no second representation exists to desynchronise |
| **Bundled fonts** | extensions cannot ship fonts (microsoft/vscode#181157, closed as not-planned) | install Isabelle's own TTFs system-wide and set `editor.fontFamily`. Fonts, unlike encodings, *are* an OS-level resource — this is a real fix, not a hack. It is also mandatory: 102 of the 439 codepoints in `etc/symbols` are above U+FFFF |

## 3. One upstream bug in the way

Enabling `vscode_pide_extensions=true` on Isabelle2025-2 makes every output event fail:

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

Until that release, either target Isabelle dev or set `vscode_html_output=true`, which
takes the branch that passes `None` for decorations.

## 4. What is measured vs. inferred

Verified by running it:

- `isabelle build` rejects literal Unicode, for ordinary *and* control symbols
- `isabelle vscode_server` runs headless over stdio and drives fine from a stock client
- the server applies `Symbol.encode` to editor text, so a Unicode buffer would also work
- sendback arrives as LSP code actions
- decoration cost: ~1.7 ms viewport-scoped vs 17 ms whole-document (5 k ranges) and
  233 ms whole-document on a 144 k-line file; linear in range count, flat in file size
- a formatter or `onWillSave` participant can force ASCII onto disk, but always rewrites
  the buffer too, so it cannot serve as a round-trip encoding layer
- the extension's own behaviour, in the four integration suites

Not verified:

- **Linux and macOS.** Only the Windows/Cygwin launch path has actually run
- the panels in §2, none of which are written
- behaviour on very large theories with the language server attached (the decoration
  benchmarks ran without PIDE markup competing for the same editor)

## 5. If this were taken further

In rough order of value per effort:

1. **PIDE markup decorations** — the largest visible gap. Needs the §3 fix and a
   decoration type per `text_color` key. The `isabelle.text_color` map in the official
   extension supplies the light/dark palette.
2. **Output and State panels** — two webviews over `PIDE/dynamic_output` and
   `PIDE/state_*`. Set `vscode_unicode_symbols_output=true` (this extension already does)
   so the panels render glyphs.
3. **Symbols palette** — cheapest of all; the table is parsed already.
4. **A `.vsix` and CI** — plus testing the non-Windows launch path.
5. **Upstream `Content.recode_symbols`** — the server already computes exactly the edits
   the save normaliser needs, but the method is dead code, referenced nowhere. Exposing
   it over LSP would let clients share one implementation.
