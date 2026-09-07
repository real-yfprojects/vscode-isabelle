/* Spell-checker dictionary commands.
 *
 * Isabelle spell-checks the *prose* in a theory -- comments and text blocks -- and does
 * it by PIDE markup category rather than by syntax:
 *
 *   spell_checker_include = words,comment,comment1,comment2,comment3,ML_comment,SML_comment
 *   spell_checker_exclude = document_marker,antiquoted,raw_text
 *
 * That exclusion is why a generic spell-checking extension does poorly here: prose in
 * `text ‹...›` contains embedded formal fragments (@{term x}, \<^const>‹...›) that only
 * the prover can identify.
 *
 * Misspellings arrive as ordinary `spell_checker` decorations through PIDE/decoration,
 * so the underlining is already handled by PideDecorations. What is missing without this
 * module are the dictionary actions: the server offers them as completion items carrying
 * an LSP Command, and VS Code refuses to execute a command id nobody registered.
 * The ids below are exactly the ones LSP.Include_Word & co. name.
 */

import * as vscode from 'vscode'
import { LanguageClient } from 'vscode-languageclient/node'

const COMMANDS: [id: string, notification: string][] = [
  ['isabelle.include-word', 'PIDE/include_word'],
  ['isabelle.include-word-permanently', 'PIDE/include_word_permanently'],
  ['isabelle.exclude-word', 'PIDE/exclude_word'],
  ['isabelle.exclude-word-permanently', 'PIDE/exclude_word_permanently'],
  ['isabelle.reset-words', 'PIDE/reset_words'],
]

export function registerSpellChecker(
  disposables: vscode.Disposable[],
  client: LanguageClient,
  log: (m: string) => void,
): void {
  for (const [id, notification] of COMMANDS) {
    disposables.push(vscode.commands.registerCommand(id, async () => {
      try {
        await client.sendNotification(notification, {})
      } catch (err) {
        log(`${id} failed: ${err}`)
      }
    }))
  }
}
