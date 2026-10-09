/* Find in a panel's page: Ctrl+F, Enter / Shift+Enter, F3, Escape, as in an editor.
 *
 * A webview view -- the infoview in the bottom panel or a side bar -- gets no find widget
 * from VS Code (only editor-tab webviews can have one), and prover output such as
 * print_classes or find_theorems runs to pages. So the page brings its own.
 *
 * Matches are painted with the CSS Custom Highlight API rather than by wrapping them in
 * elements: the server's HTML stays as it came, and a match may run across the spans the
 * markup splits a term into. The bar follows the page by itself (a MutationObserver), so a
 * new body from the server is searched again without the page having to say so.
 *
 * No vscode import, so the matching is testable under plain node (suite66).
 *
 * A page includes FIND_CSS, FIND_BAR_HTML before its `#content` element, and FIND_SCRIPT
 * in its nonce'd script; `{ type: 'find' }` posted to the page opens the bar.
 */

export interface FindOptions {
  caseSensitive?: boolean
  regex?: boolean
}

export interface FindResult {
  /** [start, end) offsets into the text, in order. */
  matches: [number, number][]
  /** There were more than `limit`. */
  capped: boolean
  /** The pattern does not compile. */
  error?: string
}

/** More than this many highlights make typing in the bar lag on a long print_classes. */
export const FIND_LIMIT = 10000

/**
 * The matches of `query` in `text`. A plain query matches its whitespace against any run
 * of whitespace: Isabelle breaks output at the panel's margin, so where a line ends depends
 * on how wide the panel is, not on the term.
 *
 * Embedded in the page by its source text (see FIND_SCRIPT), so it has to stand alone: no
 * imports, nothing from outside the function.
 */
export function findMatches(text: string, query: string, options: FindOptions, limit: number): FindResult {
  const matches: [number, number][] = []
  if (!query) return { matches, capped: false }
  const source = options.regex
    ? query
    : query.split(/\s+/).map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+')
  const flags = options.caseSensitive ? 'g' : 'gi'
  let re: RegExp
  /* With `u`, a symbol outside the BMP is one character to `.` and to the case folding;
     a pattern written without it in mind, like `\-`, is still taken without. */
  try {
    re = new RegExp(source, flags + 'u')
  } catch {
    try {
      re = new RegExp(source, flags)
    } catch (err) {
      return { matches, capped: false, error: err instanceof Error ? err.message : String(err) }
    }
  }
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    if (m[0].length === 0) { re.lastIndex++; continue }
    if (matches.length === limit) return { matches, capped: true }
    matches.push([m.index, m.index + m[0].length])
  }
  return { matches, capped: false }
}

export const FIND_BAR_HTML = `<div id="find" class="find" role="search" hidden>
<input id="find-input" type="text" placeholder="Find" aria-label="Find" spellcheck="false">
<button id="find-case" class="toggle" title="Match Case (Alt+C)" aria-pressed="false">Aa</button>
<button id="find-regex" class="toggle" title="Use Regular Expression (Alt+R)" aria-pressed="false">.*</button>
<span id="find-count" class="count" aria-live="polite"></span>
<button id="find-prev" title="Previous Match (Shift+Enter)" aria-label="Previous Match">&#x2191;</button>
<button id="find-next" title="Next Match (Enter)" aria-label="Next Match">&#x2193;</button>
<button id="find-close" title="Close (Escape)" aria-label="Close">&#x2715;</button>
</div>`

/* Sticky rather than floating over the page as the editor's widget does: in a narrow panel
   it would cover the header's buttons. The negative margin takes up the body's padding. */
export const FIND_CSS = `
  .find { position: sticky; top: 0; z-index: 10; display: flex; align-items: center; gap: 2px;
          margin: -6px -6px 6px -6px; padding: 4px 6px;
          font-family: var(--vscode-font-family); font-size: var(--vscode-font-size);
          color: var(--vscode-editorWidget-foreground, var(--vscode-foreground));
          background: var(--vscode-editorWidget-background);
          box-shadow: 0 0 8px 2px var(--vscode-widget-shadow, transparent); }
  .find[hidden] { display: none; }
  .find input { flex: 1 1 auto; min-width: 6em; font: inherit; padding: 2px 4px; outline: none;
                color: var(--vscode-input-foreground); background: var(--vscode-input-background);
                border: 1px solid var(--vscode-input-border, transparent); border-radius: 2px; }
  .find input:focus { border-color: var(--vscode-focusBorder); }
  .find input.invalid { border-color: var(--vscode-inputValidation-errorBorder); }
  .find button { font: inherit; min-width: 22px; height: 22px; padding: 0 4px; cursor: pointer;
                 color: inherit; background: transparent; border: 1px solid transparent; border-radius: 3px; }
  .find button:hover { background: var(--vscode-toolbar-hoverBackground); }
  .find button:disabled { opacity: .5; cursor: default; background: transparent; }
  .find button.toggle { font-family: var(--vscode-editor-font-family), monospace; }
  .find button[aria-pressed="true"] { color: var(--vscode-inputOption-activeForeground);
                 background: var(--vscode-inputOption-activeBackground);
                 border-color: var(--vscode-inputOption-activeBorder); }
  .find .count { min-width: 6.5em; padding: 0 4px; white-space: nowrap; opacity: .85; }
  .find .count.none { color: var(--vscode-errorForeground); opacity: 1; }
  ::highlight(isabelle-find) { background-color: var(--vscode-editor-findMatchHighlightBackground); }
  ::highlight(isabelle-find-current) { background-color: var(--vscode-editor-findMatchBackground); }
`

/**
 * The bar's behaviour. Expects FIND_BAR_HTML and a `#content` element in the page.
 *
 * Keys it handles are stopped at the document: VS Code's webview host passes every keydown
 * on to the workbench from a listener on the window, which would run Ctrl+F or Escape a
 * second time there.
 */
export const FIND_SCRIPT = `
  const findBar = (function () {
    ${findMatches.toString()}
    const root = document.getElementById('content');
    const bar = document.getElementById('find');
    const input = document.getElementById('find-input');
    const count = document.getElementById('find-count');
    const caseBtn = document.getElementById('find-case');
    const regexBtn = document.getElementById('find-regex');
    const prevBtn = document.getElementById('find-prev');
    const nextBtn = document.getElementById('find-next');
    const BLOCKS = 'pre, div, p, li, summary, header, section, details, td, th';
    const highlights = typeof Highlight === 'function' && typeof CSS !== 'undefined' && CSS.highlights;
    let ranges = [];
    let current = -1;
    let capped = false;
    let error = '';
    let scheduled = false;

    const isOpen = () => !bar.hidden;
    const pressed = b => b.getAttribute('aria-pressed') === 'true';

    /* The page's text as one string, and where each text node starts in it. What is not
       on screen -- hidden markup, button labels -- is left out. Blocks are kept apart by a
       line break that belongs to no node, so one message's last word does not run into
       the next one's first. */
    function collect() {
      const nodes = [], starts = [];
      let text = '';
      let block = null;
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode: n => n.parentElement && n.parentElement.closest('button, .hidden, script, style')
          ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
      });
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const b = n.parentElement && n.parentElement.closest(BLOCKS);
        if (b !== block && text) text += String.fromCharCode(10);
        block = b;
        nodes.push(n);
        starts.push(text.length);
        text += n.data;
      }
      return { nodes, starts, text };
    }

    /* The last node starting at or before a match's start, or before its end. An end on
       a block's line break is clamped to the end of the node before it. */
    function nodeAt(starts, offset, isEnd) {
      let lo = 0, hi = starts.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (isEnd ? starts[mid] < offset : starts[mid] <= offset) lo = mid; else hi = mid - 1;
      }
      return lo;
    }

    function search() {
      const { nodes, starts, text } = collect();
      const result = findMatches(text, input.value,
        { caseSensitive: pressed(caseBtn), regex: pressed(regexBtn) }, ${FIND_LIMIT});
      error = result.error || '';
      capped = result.capped;
      ranges = result.matches.map(([s, e]) => {
        const a = nodeAt(starts, s, false), b = nodeAt(starts, e, true);
        const range = new Range();
        range.setStart(nodes[a], Math.min(s - starts[a], nodes[a].length));
        range.setEnd(nodes[b], Math.min(e - starts[b], nodes[b].length));
        return range;
      });
      input.classList.toggle('invalid', !!error);
      input.title = error;
    }

    function paint() {
      if (!highlights) return;
      const all = new Highlight();
      for (const range of ranges) all.add(range);
      const cur = new Highlight();
      if (ranges[current]) cur.add(ranges[current]);
      cur.priority = 1;
      CSS.highlights.set('isabelle-find', all);
      CSS.highlights.set('isabelle-find-current', cur);
    }

    function showCount() {
      const none = !!input.value && !error && ranges.length === 0;
      count.textContent = error ? 'Invalid pattern'
        : !input.value ? ''
        : none ? 'No results'
        : (current + 1) + ' of ' + ranges.length + (capped ? '+' : '');
      count.classList.toggle('none', none || !!error);
      prevBtn.disabled = nextBtn.disabled = ranges.length === 0;
    }

    /* Opens a closed block around the match, as the browser's own find does, and scrolls
       it to the middle of what the bar leaves visible. */
    function reveal() {
      const range = ranges[current];
      if (!range) return;
      for (let el = range.startContainer.parentElement; el && el !== root; el = el.parentElement) {
        if (el.tagName === 'DETAILS' && !el.open) el.open = true;
      }
      const rect = range.getBoundingClientRect();
      const top = bar.offsetHeight;
      if (rect.top < top || rect.bottom > window.innerHeight) {
        window.scrollBy(0, rect.top + rect.height / 2 - (top + window.innerHeight) / 2);
      }
    }

    /* Where a new search starts: the first match from the top of the view down, as the
       editor starts from the cursor. Matches in a closed block have no box and are passed. */
    function firstInView() {
      const top = bar.offsetHeight;
      for (let i = 0; i < ranges.length; i++) {
        if (ranges[i].getBoundingClientRect().bottom > top) return i;
      }
      return 0;
    }

    function update() {
      search();
      current = ranges.length ? firstInView() : -1;
      paint();
      showCount();
      reveal();
    }

    /* A new body: the same query again, keeping the place without scrolling. */
    function refresh() {
      scheduled = false;
      if (!isOpen() || !input.value) return;
      search();
      current = ranges.length ? Math.min(Math.max(current, 0), ranges.length - 1) : -1;
      paint();
      showCount();
    }

    function step(delta) {
      if (!ranges.length) return;
      current = (current + delta + ranges.length) % ranges.length;
      paint();
      showCount();
      reveal();
    }

    /* Starts from the selection when there is a one-line one in the page, as the editor does. */
    function open() {
      const sel = window.getSelection();
      const selected = sel && sel.rangeCount && root.contains(sel.anchorNode) ? sel.toString() : '';
      if (selected && !/[\\r\\n]/.test(selected)) input.value = selected;
      bar.hidden = false;
      input.focus();
      input.select();
      update();
    }

    function close() {
      bar.hidden = true;
      ranges = [];
      current = -1;
      if (highlights) {
        CSS.highlights.delete('isabelle-find');
        CSS.highlights.delete('isabelle-find-current');
      }
    }

    function toggle(button) {
      button.setAttribute('aria-pressed', String(!pressed(button)));
      update();
      input.focus();
    }

    input.addEventListener('input', update);
    caseBtn.addEventListener('click', () => toggle(caseBtn));
    regexBtn.addEventListener('click', () => toggle(regexBtn));
    prevBtn.addEventListener('click', () => step(-1));
    nextBtn.addEventListener('click', () => step(1));
    document.getElementById('find-close').addEventListener('click', close);

    document.addEventListener('keydown', e => {
      const mod = e.ctrlKey || e.metaKey;
      let handled = true;
      if (mod && !e.altKey && !e.shiftKey && e.code === 'KeyF') open();
      else if (!isOpen()) handled = false;
      else if (e.key === 'Escape') close();
      else if (e.key === 'F3' || (e.key === 'Enter' && e.target === input)) step(e.shiftKey ? -1 : 1);
      else if (e.altKey && !mod && e.code === 'KeyC') toggle(caseBtn);
      else if (e.altKey && !mod && e.code === 'KeyR') toggle(regexBtn);
      else handled = false;
      if (handled) { e.preventDefault(); e.stopPropagation(); }
    });

    window.addEventListener('message', e => {
      if (e.data && e.data.type === 'find') open();
    });

    /* Not attributes: opening a block for a match is not a new body. */
    new MutationObserver(() => {
      if (scheduled || !isOpen()) return;
      scheduled = true;
      requestAnimationFrame(refresh);
    }).observe(root, { childList: true, subtree: true, characterData: true });

    return { open, close, step, state: () => ({ open: isOpen(), query: input.value, current, total: ranges.length }) };
  })();
`
