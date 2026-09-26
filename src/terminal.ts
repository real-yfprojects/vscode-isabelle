/* A terminal where `isabelle` is the distribution the extension runs -- on Windows, a shell
 * of Isabelle's own Cygwin, which is otherwise reached only through Cygwin-Terminal.bat.
 *
 * Offered twice: as a command, and as a profile in the terminal panel's "+" menu. Both
 * resolve the distribution when the terminal opens rather than at activation, so they
 * follow a changed isabelle.home, and work even when activation found no distribution.
 */

import * as vscode from 'vscode'
import { findIsabelleHome, terminalOptions } from './isabelle'

export const TERMINAL_PROFILE = 'isabelle.terminal'

export function registerTerminal(
  context: vscode.ExtensionContext, report: (err: unknown) => void,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('isabelle.openTerminal', () => {
      let options: vscode.TerminalOptions
      try {
        options = terminalOptions(findIsabelleHome())
      } catch (err) {
        report(err)
        return
      }
      vscode.window.createTerminal(options).show()
    }),
    vscode.window.registerTerminalProfileProvider(TERMINAL_PROFILE, {
      // VS Code shows a thrown error itself, naming the profile.
      provideTerminalProfile: () => new vscode.TerminalProfile(terminalOptions(findIsabelleHome())),
    }),
  )
}
