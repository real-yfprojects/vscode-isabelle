// Pure checks for where the Documentation panel opens a manual -- no prover, no editor.
//
// The failure being held down: a fresh VS Code has no PDF viewer, so opening a manual
// with `vscode.open` showed the text editor's "binary or unsupported encoding" notice
// instead of the manual. A PDF now goes to the system's viewer unless something inside
// VS Code can show it.
const assert = require('assert')
const path = require('path')

const { globToRegExp, globMatches, pdfViewerRegistered } =
  require(path.join(__dirname, '..', 'out', 'doc_open.js'))

let passed = 0
const pass = m => { passed++; console.log('PASS: ' + m) }

const MANUAL = 'C:\\Users\\me\\Isabelle\\Isabelle2025-2\\doc\\prog-prove.pdf'

// What VS Code itself ships: its media preview, which must not be taken for a PDF viewer.
const STOCK = [
  { viewType: 'imagePreview.previewEditor',
    selector: [{ filenamePattern: '*.{jpg,jpe,jpeg,png,bmp,gif,ico,webp,avif,svg}' }] },
  { viewType: 'vscode.audioPreview', selector: [{ filenamePattern: '*.{mp3,wav,ogg,oga}' }] },
  { viewType: 'vscode.videoPreview', selector: [{ filenamePattern: '*.{mp4,webm}' }] },
]
// tomoki1207.pdf ("vscode-pdf"), as its package.json contributes it.
const VSCODE_PDF = { viewType: 'pdf.preview', selector: [{ filenamePattern: '*.pdf' }] }

async function run() {
  assert.ok(globToRegExp('*.pdf').test('prog-prove.pdf'))
  assert.ok(globToRegExp('*.pdf').test('PROG-PROVE.PDF'), 'globs match without regard to case')
  assert.ok(!globToRegExp('*.pdf').test('dir/prog-prove.pdf'), '* stays within a path segment')
  assert.ok(globToRegExp('**/*.pdf').test('dir/sub/prog-prove.pdf'))
  assert.ok(globToRegExp('**/*.pdf').test('prog-prove.pdf'), '**/ also matches no directory')
  assert.ok(globToRegExp('*.{pdf,ps}').test('a.ps'))
  assert.ok(globToRegExp('prog-prove.[pP]df').test('prog-prove.Pdf'))
  assert.ok(globToRegExp('a+b.pdf').test('a+b.pdf') && !globToRegExp('a+b.pdf').test('aab.pdf'),
    'regular-expression characters in a glob are literal')
  pass('globs: *, **, {a,b}, [..], case, literal punctuation')

  assert.ok(globMatches('*.pdf', MANUAL), 'a pattern without a slash is matched against the name')
  assert.ok(globMatches('**/doc/*.pdf', MANUAL), 'one with a slash against the path, \\ read as /')
  assert.ok(!globMatches('**/other/*.pdf', MANUAL))
  pass('selectors match the file name, or the path when they name directories')

  assert.strictEqual(pdfViewerRegistered(MANUAL, STOCK, {}), false)
  assert.strictEqual(pdfViewerRegistered(MANUAL, STOCK, undefined), false)
  pass('stock VS Code: the system viewer')

  assert.strictEqual(pdfViewerRegistered(MANUAL, [...STOCK, VSCODE_PDF], {}), true)
  pass('a PDF viewer extension: VS Code')

  assert.strictEqual(pdfViewerRegistered(MANUAL, STOCK, { '*.pdf': 'some.viewer' }), true)
  assert.strictEqual(pdfViewerRegistered(MANUAL, STOCK,
    [{ viewType: 'some.viewer', filenamePattern: '*.pdf' }]), true, 'the older array form too')
  assert.strictEqual(pdfViewerRegistered(MANUAL, [...STOCK, VSCODE_PDF], { '*.pdf': 'default' }),
    false, "an association to 'default' asks for the text editor, viewer or not")
  assert.strictEqual(pdfViewerRegistered(MANUAL, [...STOCK, VSCODE_PDF], { '*.png': 'default' }),
    true, 'an association for other files changes nothing')
  pass('editor associations decide when they cover the file')

  console.log(passed + ' checks passed')
  console.log('SUITE48_OK')
}

module.exports = { run }

if (require.main === module) {
  run().catch(err => { console.error(err); process.exit(1) })
}
