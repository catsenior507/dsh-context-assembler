/**
 * The small "open in the context panel" button on every conversation row.
 *
 * Why this exists: the harness only pulls a conversation into the live session
 * store once somebody opens it, so the panel used to be blind to every past
 * conversation until it had been reopened — which, after a restart, forks it
 * into a new session id. A row-level button makes a stored conversation
 * reachable in one click, and the host reads it from storage without opening
 * or forking anything.
 *
 * How the session id is found: the sidebar renders no id into the DOM and the
 * class names are skin-specific, so the id is read out of React's fiber props
 * for the row element. That is stable across skins because it is the value the
 * sidebar component itself was rendered with, not a styling decision.
 */

/** Attribute marking a button this module injected. */
const ICON_ATTR = 'data-ca-session-icon'

/** Id of the one injected stylesheet. */
const STYLE_ID = 'dsh-context-assembler-sidebar'

/** Session ids are the only strings accepted from fiber props. */
const SESSION_ID = /^session-[0-9a-zA-Z_-]+$/

/** How far up the fiber tree to look before giving up. */
const MAX_DEPTH = 12

/** The slice of a React fiber this module reads. */
interface FiberLike {
  memoizedProps?: unknown
  return?: FiberLike | null;
}

/** The opener the mounted panel registers. */
let opener: ((sessionId: string) => void) | null = null;

/** Let the panel receive clicks from the injected buttons. */
export function setSidebarOpener(fn: ((sessionId: string) => void) | null): void {
  opener = fn;
}

/**
 * Read the session id a sidebar row was rendered for.
 *
 * The nearest fiber carrying a session id wins: ancestors carry ids too (the
 * workspace above, the selection below), and the nearest one is the row's own.
 * @param element - the row element.
 * @returns the session id, or null when this row is not a conversation.
 */
function readSessionId(element: Element): string | null {
  const key = Object.keys(element).find((name) => name.startsWith('__reactFiber$'));
  if (key === undefined) return null;
  let node = (element as unknown as Record<string, unknown>)[key] as FiberLike | null | undefined;
  for (let depth = 0; depth < MAX_DEPTH && node != null; depth += 1) {
    const props = node.memoizedProps;
    if (props !== null && typeof props === 'object') {
      for (const value of Object.values(props as Record<string, unknown>)) {
        if (typeof value === 'string' && SESSION_ID.test(value)) return value;
        if (Array.isArray(value)) {
          for (const item of value) {
            if (item === null || typeof item !== 'object') continue;
            const id = (item as { id?: unknown }).id;
            if (typeof id === 'string' && SESSION_ID.test(id)) return id;
          }
          continue;
        }
        if (value !== null && typeof value === 'object') {
          const id = (value as { id?: unknown }).id;
          if (typeof id === 'string' && SESSION_ID.test(id)) return id;
        }
      }
    }
    node = node.return ?? null;
  }
  return null;
}

/** Install the injected stylesheet once. */
function ensureStyle(): void {
  if (document.getElementById(STYLE_ID) !== null) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = [
    '[' + ICON_ATTR + ']{flex:none;display:inline-flex;align-items:center;justify-content:center;',
    'width:18px;height:18px;margin:0 0 0 2px;padding:0;border:1px solid transparent;',
    'border-radius:5px;background:transparent;color:inherit;opacity:0.5;cursor:pointer;',
    'transition:opacity .12s ease,background-color .12s ease,border-color .12s ease}',
    '[' + ICON_ATTR + ']:hover{opacity:1;background:rgba(127,127,127,0.22);border-color:rgba(127,127,127,0.35)}',
    '[' + ICON_ATTR + ']:focus-visible{opacity:1;outline:2px solid currentColor;outline-offset:1px}',
  ].join('');
  document.head.appendChild(style);
}

/** Build the 16px grid icon shown on a row. */
function iconSvg(): string {
  return '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor"'
    + ' stroke-width="1.5" stroke-linecap="round" aria-hidden="true">'
    + '<path d="M2.5 4h11M2.5 8h7M2.5 12h4"/><circle cx="12" cy="11.5" r="2.6"/></svg>';
}

/**
 * Add the button to one row, if it is a conversation row without one.
 * @param row - the sidebar row element.
 * @returns true when a button was added.
 */
function decorate(row: HTMLElement): boolean {
  if (row.querySelector('[' + ICON_ATTR + ']') !== null) return false;
  const sessionId = readSessionId(row);
  if (sessionId === null) return false;
  const button = document.createElement('button');
  button.type = 'button';
  button.setAttribute(ICON_ATTR, sessionId);
  button.title = '在组装式上下文中打开（不会切换当前对话）';
  button.setAttribute('aria-label', '在组装式上下文中打开这个对话');
  button.innerHTML = iconSvg();
  button.addEventListener('click', (event) => {
    // The row itself opens the conversation; this button must not do that too.
    event.preventDefault();
    event.stopPropagation();
    if (opener !== null) opener(sessionId);
  });
  row.appendChild(button);
  return true;
}

/**
 * Decorate every conversation row currently in the document.
 * @returns how many buttons were added.
 */
function sync(): number {
  let added = 0;
  for (const row of Array.from(document.querySelectorAll<HTMLElement>('[role="treeitem"]'))) {
    if (decorate(row)) added += 1;
  }
  return added;
}

/**
 * Follow the conversation the sidebar has selected.
 *
 * The sidebar marks its active conversation row with `aria-selected`, so this
 * reads that attribute rather than subscribing to the shell's own session store:
 * this plugin has no seat in the session list, so it is never handed the hooks
 * the shell gives its seats. The rendered attribute is the same contract
 * `installSidebarIcons` already depends on, and it keeps working when the
 * selection moves for a reason the panel would otherwise never hear about - a
 * keyboard shortcut, a search result, opening a fork.
 *
 * The attribute is observed explicitly. Selection does not necessarily add or
 * remove a row: React flips the attribute on a node that is already mounted, and
 * a childList-only observer never sees it.
 * @param onChange - called with the session id each time the selection moves.
 * @returns a function that stops watching.
 */
export function installActiveSessionWatch(onChange: (sessionId: string) => void): () => void {
  let last: string | null = null
  let queued = false
  const read = (): void => {
    queued = false
    const row = document.querySelector('[role="treeitem"][aria-selected="true"]')
    if (row === null) return
    const id = readSessionId(row)
    if (id === null || id === last) return
    last = id
    onChange(id)
  }
  const observer = new MutationObserver(() => {
    if (queued) return
    queued = true
    window.requestAnimationFrame(read)
  })
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['aria-selected'],
  })
  read()
  return () => observer.disconnect()
}

/**
 * Keep the sidebar decorated as the harness re-renders it.
 *
 * The observer watches the whole body because the sidebar is virtualised and
 * re-rendered on every session rename or activity change. `decorate` is
 * idempotent, so the mutations this module causes settle instead of looping.
 * @returns a function that removes every button and stops observing.
 */
export function installSidebarIcons(): () => void {
  ensureStyle();
  let queued = false;
  const run = (): void => {
    queued = false;
    sync();
  };
  const observer = new MutationObserver(() => {
    if (queued) return;
    queued = true;
    window.requestAnimationFrame(run);
  });
  observer.observe(document.body, { childList: true, subtree: true });
  run();
  return () => {
    observer.disconnect();
    for (const button of Array.from(document.querySelectorAll('[' + ICON_ATTR + ']'))) button.remove();
    document.getElementById(STYLE_ID)?.remove();
  };
}
