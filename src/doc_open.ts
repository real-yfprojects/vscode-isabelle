/* Where a manual from the Documentation panel opens. Pure, so suite48 can check it.
 *
 * Stock VS Code has no PDF viewer: `vscode.open` on a PDF shows the text editor's "binary
 * or unsupported encoding" notice. So a PDF goes to the system's viewer, unless something
 * in VS Code can show it -- an extension with a custom editor for PDFs (vscode-pdf, PDF
 * Preview, ...), or an editor association the user set up for them.
 */

/** A `contributes.customEditors` entry, as far as it matters here. */
export interface CustomEditorContribution {
  viewType?: string
  selector?: { filenamePattern?: string }[]
}

/**
 * `workbench.editorAssociations`: an object from glob to view type, or the array of
 * `{ viewType, filenamePattern }` that older versions of VS Code wrote.
 */
export type EditorAssociations =
  Record<string, string> | { viewType?: string; filenamePattern?: string }[] | undefined

/** A glob as VS Code writes them: `*`, `**`, `?`, `{a,b}` and `[...]`, any case. */
export function globToRegExp(glob: string): RegExp {
  let re = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++
        if (glob[i + 1] === '/') { i++; re += '(?:.*/)?' } else re += '.*'
      } else re += '[^/]*'
    } else if (c === '?') re += '[^/]'
    else if (c === '{') {
      const end = glob.indexOf('}', i)
      if (end === -1) { re += '\\{'; continue }
      re += '(?:' + glob.slice(i + 1, end).split(',').map(escapeRegExp).join('|') + ')'
      i = end
    } else if (c === '[') {
      const end = glob.indexOf(']', i)
      if (end === -1) { re += '\\['; continue }
      re += '[' + glob.slice(i + 1, end).replace(/\\/g, '\\\\') + ']'
      i = end
    } else re += escapeRegExp(c)
  }
  return new RegExp('^' + re + '$', 'i')
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
}

/**
 * Whether `pattern` covers `file`: a pattern without a slash is matched against the
 * file's name, as VS Code does for editor selectors, one with a slash against its path.
 */
export function globMatches(pattern: string, file: string): boolean {
  const unix = file.replace(/\\/g, '/')
  const target = pattern.includes('/') ? unix : unix.slice(unix.lastIndexOf('/') + 1)
  return globToRegExp(pattern).test(target)
}

/** Whether VS Code itself can show `file`, a PDF, rather than the system's viewer. */
export function pdfViewerRegistered(
  file: string,
  customEditors: CustomEditorContribution[],
  associations: EditorAssociations,
): boolean {
  /* An association the user made decides, as it does for VS Code. To 'default' it asks
     for the text editor -- which is what cannot show a PDF -- even with a viewer
     installed. */
  const pairs: [string | undefined, string | undefined][] = Array.isArray(associations)
    ? associations.map(a => [a.filenamePattern, a.viewType])
    : Object.entries(associations ?? {})
  const associated = pairs.find(([pattern, viewType]) =>
    pattern !== undefined && viewType !== undefined && globMatches(pattern, file))
  if (associated) return associated[1] !== 'default'
  return customEditors.some(editor => (editor.selector ?? []).some(s =>
    s.filenamePattern !== undefined && globMatches(s.filenamePattern, file)))
}
