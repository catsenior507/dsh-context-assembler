/**
 * The assembled-context panel.
 *
 * It is a tree editor over one session surface. Every row is a region of
 * recorded work; the three-button control on each row picks what the next
 * model request does with that region. Nothing is written until 应用 is
 * pressed, so the user can reshape a whole context plan and read the projected
 * token budget before committing it to the log.
 *
 * @module dsh-context-assembler/client/panel
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  AssembleMode,
  ContextMessageView,
  ContextNodeView,
  ContextPlanOp,
  ContextPreset,
  ContextSessionView,
  ContextTreeResponse,
} from '../shared/types'
import { api } from './api'
import { installSidebarIcons, setSidebarOpener } from './sidebar'
import css from './context-assembler.module.css'

/** Uncommitted per-row mode changes, keyed by surface seq. */
type Pending = Record<number, { mode: AssembleMode; digest?: string }>

/** The three modes, in the order the row control renders them. */
const MODES: Array<{ value: AssembleMode; label: string; className: string }> = [
  { value: 'full', label: '原文', className: css.modeOn },
  { value: 'key', label: '关键', className: css.modeKey },
  { value: 'off', label: '移出', className: css.modeOff },
]

/** Every selectable row inside one subtree. */
function collectRows(node: ContextNodeView, out: ContextNodeView[]): ContextNodeView[] {
  if (node.surfaceSeq !== null && node.selectable) out.push(node)
  if (node.children !== undefined) {
    for (const child of node.children) collectRows(child, out)
  }
  return out
}

/** The badge class for one row. */
function tagClassFor(node: ContextNodeView): string {
  if (node.state === 'digest') return css.tagDigest
  if (node.kind === 'tool') return node.isError === true ? css.tagErr : css.tagTool
  if (node.kind === 'assistant') return css.tagAssistant
  return css.tag
}

/**
 * Whether a line is a tool-call marker rather than something a person said.
 *
 * `messageText` renders each `tool-call` block as `<name {args}>`, so an
 * assistant turn that only called a tool — the common shape in an agent loop —
 * starts with the raw JSON of its arguments. Reporting that as the gist of a
 * step is worse than reporting nothing: it is unreadable and it says only which
 * tool ran, which the row's own kind already says. The closing bracket is
 * optional because the preview is truncated mid-line.
 */
function isToolCallMarker(line: string): boolean {
  return /^<[A-Za-z_][A-Za-z0-9_-]*[ >]/.test(line);
}

/** Collapse one text block down to a single readable line. */
function firstLineOf(text: string): string | undefined {
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+/g, " ").trim();
    if (line === "" || isToolCallMarker(line)) continue;
    return line.length > 72 ? line.slice(0, 72) + "…" : line;
  }
  return undefined;
}

/**
 * The one-line gist of a subtree, in row order — the same rule tree.ts applies.
 *
 * The host half already sends `hint` and stays the source of truth. This
 * fallback exists because the two halves reload on different triggers: a page
 * refresh picks up new panel code immediately, while the host half only changes
 * on a restart. Without it, a browser running newer panel code against an
 * unchanged host would fall back to bare ordinals — exactly the state this is
 * meant to fix.
 */
function gistFrom(node: ContextNodeView, allowSystem: boolean): string | undefined {
  if (node.state === "digest") {
    const own = firstLineOf(node.preview);
    if (own !== undefined) return own;
  }
  const children = node.children ?? [];
  if (children.length === 0) {
    if (!allowSystem && node.kind === "system") return undefined;
    const line = firstLineOf(node.preview);
    if (line === undefined) return undefined;
    if (node.kind === "tool" && node.toolName !== undefined && !line.startsWith(node.toolName)) {
      return "工具 " + node.toolName + " · " + line;
    }
    return line;
  }
  for (const child of children) {
    if (!allowSystem && child.kind === "system") continue;
    const found = gistFrom(child, allowSystem);
    if (found !== undefined) return found;
  }
  return undefined;
}

/** Where the panel remembers its own view state between page loads. */
const UI_KEY = 'dsh-context-assembler.ui'

/** The panel view state kept in local storage. */
interface StoredUi {
  sessionId?: string
  expanded?: Record<string, boolean>
  /** Viewport position the user dragged the launcher to, if they moved it. */
  launcher?: { left: number; top: number }
}

/** Read the stored view state, tolerating a hostile or absent storage. */
function loadUi(): StoredUi {
  try {
    const raw = window.localStorage.getItem(UI_KEY)
    if (raw === null) return {}
    const parsed = JSON.parse(raw) as StoredUi
    return parsed !== null && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

/** Persist the view state; a full or blocked storage must never break the panel. */
function saveUi(value: StoredUi): void {
  try {
    window.localStorage.setItem(UI_KEY, JSON.stringify(value))
  } catch {
    // Ignored on purpose.
  }
}

/**
 * Pick the session to open, following the conversation across a restart.
 *
 * Continuing a stored conversation makes the harness fork it into a fresh
 * session id, so the id the panel saved last time is usually no longer live.
 * Falling back to "newest session" would silently jump the user into whatever
 * else happened to be active; walking the recorded lineage keeps the panel on
 * the conversation they were actually working in.
 * @param stored - the session id saved by the previous page load.
 * @param sessions - the live sessions.
 * @param fallback - the host's own default.
 * @returns the session id to open.
 */
function resolveStoredSession(
  stored: string | null,
  sessions: readonly ContextSessionView[],
  fallback: string | null,
): string | null {
  if (stored === null) return fallback
  if (sessions.some((row) => row.id === stored)) return stored
  const byId = new Map(sessions.map((row) => [row.id, row]))
  const descendants: ContextSessionView[] = []
  for (const row of sessions) {
    let cursor = row.parentSessionId
    for (let depth = 0; depth < 16 && cursor !== undefined; depth += 1) {
      if (cursor === stored) {
        descendants.push(row)
        break
      }
      cursor = byId.get(cursor)?.parentSessionId
    }
  }
  descendants.sort((a, b) => b.updatedAt - a.updatedAt)
  return descendants[0]?.id ?? fallback
}

/** Default distance from the viewport's right edge when nothing is in the way. */
const RIGHT_BASE = 12

/** The right sidebar element this panel last found, so the steady-state measure is one rect read. */
let sidebarCandidate: HTMLElement | null = null

/** Earliest time the next full-document sidebar scan may run. */
let nextSidebarScan = 0

/** Tags that are artwork rather than chrome; skins decorate heavily. */
const DECORATIVE = new Set(['IMG', 'PICTURE', 'VIDEO', 'CANVAS', 'SVG'])

/**
 * Whether one element is the harness right sidebar.
 *
 * Full height and flush with the TOP is the load-bearing part. Skins park
 * large decorative artwork along the right edge, and an earlier version of
 * this test happily adopted a 484x920 illustration that merely ended at the
 * viewport edge — which pinned the launcher 500px into the chat column.
 * Hidden means parked: the sidebar collapses by translating itself out and
 * going invisible, not by unmounting.
 * @param element - candidate element.
 * @param rect - its rect.
 * @param style - its computed style.
 * @returns whether this is the sidebar.
 */
function isSidebarLike(element: HTMLElement, rect: DOMRect, style: CSSStyleDeclaration): boolean {
  const vw = window.innerWidth
  if (DECORATIVE.has(element.tagName)) return false
  if (style.position !== 'fixed' && style.position !== 'absolute') return false
  if (style.visibility === 'hidden' || style.display === 'none') return false
  if (rect.top > 12) return false
  if (rect.height < window.innerHeight * 0.6) return false
  if (rect.width < 180 || rect.width > vw - 100) return false
  return Math.abs(rect.right - vw) <= 8 || Math.abs(rect.left - vw) <= 8
}

/**
 * The offset one already-found element implies.
 *
 * A parked sidebar reports the base offset rather than a negative one, so the
 * launcher returns to the corner when the sidebar closes.
 * @param element - the sidebar element.
 * @returns the offset in pixels.
 */
function offsetFor(element: HTMLElement): number {
  const rect = element.getBoundingClientRect()
  if (!isSidebarLike(element, rect, window.getComputedStyle(element))) return RIGHT_BASE
  const left = Math.min(rect.left, window.innerWidth)
  return Math.max(RIGHT_BASE, Math.round(window.innerWidth - left) + RIGHT_BASE)
}

/**
 * Find the harness right sidebar.
 *
 * Geometry first, style second: the cheap rect test discards almost every
 * element before a single getComputedStyle runs, which matters because this
 * scans the whole document whenever the cached element is gone.
 * @returns the sidebar element, or null when this layout has none.
 */
function adoptSidebar(): HTMLElement | null {
  const vw = window.innerWidth
  const vh = window.innerHeight
  let best: HTMLElement | null = null
  let bestScore = -1
  for (const node of Array.from(document.body.querySelectorAll('*'))) {
    if (!(node instanceof HTMLElement)) continue
    const rect = node.getBoundingClientRect()
    if (rect.top > 12) continue
    if (rect.height < vh * 0.6) continue
    if (rect.width < 180 || rect.width > vw - 100) continue
    if (Math.abs(rect.right - vw) > 8 && Math.abs(rect.left - vw) > 8) continue
    const style = window.getComputedStyle(node)
    if (!isSidebarLike(node, rect, style)) continue
    // Several panels can qualify; the sidebar is the one stacked highest.
    const z = Number.parseInt(style.zIndex, 10)
    const score = (Number.isFinite(z) ? z : 0) * 100000 + rect.width
    if (score > bestScore) {
      bestScore = score
      best = node
    }
  }
  return best
}

/**
 * How far this plugin's chrome must sit from the right edge.
 *
 * The harness right sidebar is a full-height, right-anchored panel that slides
 * in over the chat column, so a fixed top-right button lands squarely on its
 * header controls and makes them unclickable. Following the sidebar keeps the
 * launcher and the panel at the top-right of whatever column is actually free.
 *
 * Once found, the element is measured directly — one rect read per tick. A
 * layout with no sidebar at all re-scans only occasionally, because the scan is
 * the expensive half and an unnoticed sidebar is a cosmetic problem.
 * @returns the offset in pixels.
 */
function measureRightOffset(): number {
  if (sidebarCandidate !== null) {
    if (sidebarCandidate.isConnected) return offsetFor(sidebarCandidate)
    sidebarCandidate = null
  }
  const now = Date.now()
  if (now < nextSidebarScan) return RIGHT_BASE
  nextSidebarScan = now + 1500
  sidebarCandidate = adoptSidebar()
  return sidebarCandidate === null ? RIGHT_BASE : offsetFor(sidebarCandidate)
}

/** Byte size, for a stored log whose event count is not known yet. */
function bytes(value: number): string {
  if (value >= 1024 * 1024) return (value / (1024 * 1024)).toFixed(1) + ' MB'
  if (value >= 1024) return Math.round(value / 1024) + ' KB'
  return String(value) + ' B'
}

/**
 * One line for the session picker.
 *
 * A stored session has no title until its log has been read once, so the row
 * says what it is and how big it is rather than pretending to be empty:
 * "0 事件" on a stored conversation reads as data loss, not as a pending read.
 * @param row - the session row.
 * @returns the option label.
 */
function sessionLabel(row: ContextSessionView): string {
  const prefix = (row.recent ? '● ' : '') + (row.parentSessionId === undefined ? '' : '└ ')
  const name = row.title !== ''
    ? (row.title.length > 30 ? row.title.slice(0, 30) + '…' : row.title)
    : (row.cold === true ? '未命名 · ' + row.id.replace('session-', '').slice(0, 8) : row.id)
  const size = row.events > 0
    ? row.events + ' 事件'
    : (row.sizeBytes !== undefined && row.sizeBytes > 0 ? bytes(row.sizeBytes) : '读取中…')
  return prefix + name + '  ·  ' + size + (row.cold === true ? '  ·  历史' : '')
}

/** Compact token rendering. */
function tokens(value: number): string {
  if (value >= 1000) return (value / 1000).toFixed(1) + 'k'
  return String(value)
}

/** One tree row plus its subtree. */
function Row(props: {
  node: ContextNodeView
  depth: number
  pending: Pending
  expanded: Record<string, boolean>
  previewOf: string | null
  onToggleExpand: (id: string) => void
  onTogglePreview: (id: string) => void
  onSetModes: (entries: Array<{ seq: number; mode: AssembleMode }>) => void
}): React.ReactElement {
  const node = props.node
  const depth = props.depth
  const children = node.children ?? []
  const isOpen = props.expanded[node.id] === true
  const seq = node.surfaceSeq
  const pendingHere = seq === null ? undefined : props.pending[seq]
  const effective = pendingHere === undefined ? node.mode : pendingHere.mode
  const dirty = pendingHere !== undefined
  const expandable = children.length > 0
  const subtree = useMemo(() => collectRows(node, []), [node]);
  const hint = useMemo(() => {
    if (node.children === undefined || node.children.length === 0) return undefined;
    return node.hint ?? gistFrom(node, false) ?? gistFrom(node, true);
  }, [node]);
  const setSubtree = (mode: AssembleMode): void => {
    const entries: Array<{ seq: number; mode: AssembleMode }> = [];
    for (const row of subtree) {
      if (row.surfaceSeq !== null) entries.push({ seq: row.surfaceSeq, mode: mode });
    }
    props.onSetModes(entries);
  };
  const badgeText = node.state === 'digest' ? '折叠区' : node.kind;
  const rowClass = dirty ? css.row + ' ' + css.rowSelected : css.row;
  const labelClass = node.selectable ? css.label : css.label + ' ' + css.labelMuted;
  const rows = children.map((child) => (
    <Row
      key={child.id}
      node={child}
      depth={depth + 1}
      pending={props.pending}
      expanded={props.expanded}
      previewOf={props.previewOf}
      onToggleExpand={props.onToggleExpand}
      onTogglePreview={props.onTogglePreview}
      onSetModes={props.onSetModes}
    />
  ));
  return (
    <div>
      <div className={rowClass} style={{ paddingLeft: String(10 + depth * 14) + "px" }}>
        {expandable ? (
          <button type="button" className={css.caret} onClick={() => props.onToggleExpand(node.id)}>
            {isOpen ? '▾' : '▸'}
          </button>
        ) : (
          <span className={css.caretSpacer} />
        )}
        <span className={tagClassFor(node)}>{badgeText}</span>
        <span
          className={labelClass}
          title={node.protectedReason ?? node.preview}
          onClick={() => props.onTogglePreview(node.id)}
        >
          {node.label}
          {hint === undefined ? null : <span className={css.rowHint}>{hint}</span>}
        </span>
        {dirty ? <span className={css.tagPending}>待应用</span> : null}
        {seq === null ? null : <span className={css.seq}>#{seq}</span>}
        <span className={css.tokens}>{tokens(node.tokens)} t</span>
        {node.selectable && seq !== null ? (
          <span className={css.modes}>
            {MODES.map((mode) => {
              const modeClass = effective === mode.value ? css.mode + ' ' + mode.className : css.mode;
              return (
                <button
                  key={mode.value}
                  type="button"
                  className={modeClass}
                  onClick={() => props.onSetModes([{ seq: seq, mode: mode.value }])}
                >
                  {mode.label}
                </button>
              );
            })}
          </span>
        ) : null}
        {!node.selectable && expandable ? (
          <span className={css.modes + " " + css.batch}>
            <button type="button" className={css.mode} title="整个子树只保留关键部分" onClick={() => setSubtree("key")}>关键</button>
            <button type="button" className={css.mode} title="整个子树移出上下文" onClick={() => setSubtree("off")}>移出</button>
            <button type="button" className={css.mode} title="整个子树恢复原文" onClick={() => setSubtree("full")}>原文</button>
          </span>
        ) : null}
      </div>
      {props.previewOf === node.id && node.preview !== '' ? <div className={css.preview}>{node.preview}</div> : null}
      {isOpen && expandable ? <div>{rows}</div> : null}
    </div>
  );
}

/** The panel application: session picker, tree, presets, and the apply bar. */
export function ContextAssemblerApp(): React.ReactElement {
  const [open, setOpen] = useState(false);
  // Where the user dragged the launcher. Null means "wherever the layout puts
  // it", which is the sidebar-aware top-right corner.
  const [anchor, setAnchor] = useState<{ left: number; top: number } | null>(() => loadUi().launcher ?? null);
  const dragRef = useRef<{ id: number; startX: number; startY: number; left: number; top: number; moved: boolean } | null>(null);
  const suppressClick = useRef(false);
  const [sessions, setSessions] = useState<ContextSessionView[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(() => loadUi().sessionId ?? null);
  const [tree, setTree] = useState<ContextTreeResponse | null>(null);
  const [messages, setMessages] = useState<ContextMessageView[]>([]);
  const [pending, setPending] = useState<Pending>({});
  const draftTimer = useRef<number | null>(null);
  const [draftRestored, setDraftRestored] = useState(false);
  const [expanded, setExpanded] = useState<Record<string, boolean>>(() => loadUi().expanded ?? {});
  const [previewOf, setPreviewOf] = useState<string | null>(null);
  const [showMessages, setShowMessages] = useState(false);
  const [showPresets, setShowPresets] = useState(false);
  const [presetDraft, setPresetDraft] = useState<ContextPreset[]>([]);
  const [templates, setTemplates] = useState<ContextPreset[]>([]);
  const [status, setStatus] = useState<{ kind: string; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(true);

  const report = useCallback((kind: string, text: string) => {
    setStatus({ kind: kind, text: text });
    window.setTimeout(() => setStatus(null), 6000);
  }, []);

  const loadSessions = useCallback(async () => {
    try {
      const payload = await api.sessions();
      setSessions(payload.sessions);
      setSessionId((current) => resolveStoredSession(current, payload.sessions, payload.defaultSessionId));
      setTemplates(await api.templates());
    } catch (error) {
      report('error', error instanceof Error ? error.message : String(error));
    }
  }, [report]);

  const loadTree = useCallback(async (id: string) => {
    try {
      const next = await api.tree(id);
      setTree(next);
      setMessages(await api.messages(id));
    } catch (error) {
      report('error', error instanceof Error ? error.message : String(error));
    }
  }, [report]);

  useEffect(() => { void loadSessions(); }, [loadSessions]);

  // Re-read the session list every time the panel opens: stored conversations
  // get their titles from a background read, and by the time the user looks
  // they are usually already there.
  useEffect(() => {
    if (open) void loadSessions();
  }, [open, loadSessions]);

  /**
   * Open the panel on one session, live or stored.
   *
   * Called by the small button next to every conversation title. It loads the
   * tree explicitly rather than relying on the sessionId effect, because
   * clicking the button of the session already on screen must still refresh.
   */
  const openFor = useCallback((id: string) => {
    setOpen(true);
    setPending({});
    setDraftRestored(false);
    setSessionId(id);
    void loadTree(id);
  }, [loadTree]);

  // Own the sidebar buttons for as long as the panel is mounted. The opener is
  // registered separately from the installer so that reopening the panel never
  // leaves a stale closure behind.
  useEffect(() => {
    setSidebarOpener(openFor);
    return () => { setSidebarOpener(null); };
  }, [openFor]);

  useEffect(() => installSidebarIcons(), []);

  // Remember which conversation the panel is on and which rows are open, so a
  // reload lands the user back where they were instead of on a collapsed tree
  // of some other session.
  useEffect(() => {
    saveUi({ sessionId: sessionId ?? undefined, expanded, launcher: anchor ?? undefined });
  }, [sessionId, expanded, anchor]);

  // Keep this plugin's chrome clear of the harness right sidebar. The sidebar
  // slides in over the chat column, so a fixed top-right launcher would sit on
  // its header buttons; the offset is published as a CSS variable the launcher
  // and the panel both read. Steady state costs one rect read per tick, because
  // the sidebar element is cached; only the first tick scans the document.
  useEffect(() => {
    let published = '';
    const publish = (): void => {
      const value = String(measureRightOffset()) + 'px';
      if (value === published) return;
      published = value;
      document.documentElement.style.setProperty('--ca-right', value);
    };
    publish();
    window.addEventListener('resize', publish);
    const settle = window.setInterval(publish, 600);
    return () => {
      window.removeEventListener('resize', publish);
      window.clearInterval(settle);
      document.documentElement.style.removeProperty('--ca-right');
    };
  }, []);

  useEffect(() => {
    // Wait for the session list before loading: a remembered id may point at a
    // conversation that a restart has since forked, and asking the host for it
    // first would flash a "no such session" error before the list resolves it.
    if (sessionId === null || sessions.length === 0) return;
    setPending({});
    setDraftRestored(false);
    void loadTree(sessionId);
  }, [sessionId, sessions.length, loadTree]);

  // Recover the unapplied plan this session (or the conversation it descends
  // from) left behind. Without this, clicking rows and then reloading — or the
  // host restarting underneath the page — silently discarded the work, which is
  // indistinguishable from "the panel forgot everything".
  useEffect(() => {
    if (tree === null || draftRestored) return;
    setDraftRestored(true);
    if (tree.draft.length === 0) return;
    setPending((current) => {
      if (Object.keys(current).length > 0) return current;
      const restored: Pending = {};
      for (const op of tree.draft) restored[op.surfaceSeq] = { mode: op.mode, digest: op.digest };
      return restored;
    });
  }, [tree === null ? null : tree.sessionId, draftRestored]);



  useEffect(() => {
    if (!open || sessionId === null || !autoRefresh) return;
    // The session list refreshes on the same tick: stored conversations get
    // their titles and event counts from a background read, and a picker that
    // never re-reads would keep showing the placeholders forever.
    const timer = window.setInterval(() => {
      void loadSessions();
      void loadTree(sessionId);
    }, 4000);
    return () => window.clearInterval(timer);
  }, [open, sessionId, autoRefresh, loadTree, loadSessions]);

  useEffect(() => {
    setPresetDraft(tree === null ? [] : tree.presets);
  }, [tree === null ? null : tree.sessionId]);

  // Open the newest turn (and its newest step) when a session first loads.
  // A freshly opened panel otherwise shows nothing but collapsed containers,
  // which reads as "no context here" exactly when the user wants to look at
  // the work in progress. Keyed on the session id, so the four-second refresh
  // never fights a manual collapse.
  useEffect(() => {
    if (tree === null) return;
    const turns = tree.nodes.filter((node) => node.kind === "turn");
    const lastTurn = turns[turns.length - 1];
    if (lastTurn === undefined) return;
    const steps = (lastTurn.children ?? []).filter((node) => node.kind === "step");
    const lastStep = steps[steps.length - 1];
    setExpanded((current) => {
      const next = { ...current };
      next[lastTurn.id] = true;
      if (lastStep !== undefined) next[lastStep.id] = true;
      return next;
    });
  }, [tree === null ? null : tree.sessionId]);

  useEffect(() => {
    const handler = (event: KeyboardEvent): void => {
      if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setOpen((value) => !value);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  // A stored conversation is viewable but not editable: applying an operation
  // means appending to a live session, and there deliberately is none here.
  // Gating the one funnel every toggle goes through is what keeps a read-only
  // tree from collecting edits that can never be applied.
  const readOnly = tree !== null && tree.readOnly;

  const setModes = useCallback((entries: Array<{ seq: number; mode: AssembleMode }>) => {
    if (readOnly) {
      report('error', '这是历史会话，只能查看。先在左侧会话列表里打开它，改动才能写进日志。');
      return;
    }
    setPending((current) => {
      const next: Pending = { ...current };
      for (const entry of entries) next[entry.seq] = { mode: entry.mode };
      return next;
    });
  }, [readOnly, report]);

  const pendingOps = useMemo<ContextPlanOp[]>(() => {
    const ops: ContextPlanOp[] = [];
    for (const key of Object.keys(pending)) {
      const entry = pending[Number(key)];
      if (entry === undefined) continue;
      ops.push({ surfaceSeq: Number(key), mode: entry.mode, digest: entry.digest });
    }
    return ops;
  }, [pending]);

  // Mirror every unapplied change to the host, debounced. An empty plan is
  // never written here: doing so would plant an explicit empty entry that stops
  // a forked session from inheriting its parent's plan. Clearing is explicit and
  // happens only after a successful apply.
  useEffect(() => {
    if (sessionId === null) return;
    if (pendingOps.length === 0) return;
    if (draftTimer.current !== null) window.clearTimeout(draftTimer.current);
    draftTimer.current = window.setTimeout(() => {
      void api.saveDraft(sessionId, pendingOps).catch(() => undefined);
    }, 700);
    return () => {
      if (draftTimer.current !== null) window.clearTimeout(draftTimer.current);
    };
  }, [pendingOps, sessionId]);

  const flatRows = useMemo(() => {
    const out: ContextNodeView[] = [];
    if (tree !== null) {
      const stack = [...tree.nodes];
      while (stack.length > 0) {
        const node = stack.pop() as ContextNodeView;
        out.push(node);
        if (node.children !== undefined) stack.push(...node.children);
      }
    }
    return out;
  }, [tree]);

  const selectWhere = useCallback((test: (node: ContextNodeView) => boolean, mode: AssembleMode) => {
    const entries: Array<{ seq: number; mode: AssembleMode }> = [];
    for (const node of flatRows) {
      if (node.surfaceSeq === null || !node.selectable) continue;
      if (!test(node)) continue;
      entries.push({ seq: node.surfaceSeq, mode: mode });
    }
    setModes(entries);
    report("ok", "已标记 " + entries.length + " 个节点，尚未写入日志");
  }, [flatRows, setModes, report]);

  const apply = useCallback(async (dryRun: boolean) => {
    if (sessionId === null) return;
    setBusy(true);
    try {
      const result = await api.plan({ sessionId: sessionId, ops: pendingOps }, dryRun);
      if (!dryRun) {
        setPending({});
        // Clear the saved plan explicitly, so a later reload does not resurrect
        // changes the log already contains.
        void api.saveDraft(sessionId, []).catch(() => undefined);
      }
      await loadTree(sessionId);
      const saved = result.savedTokens >= 0 ? "节省 " + result.savedTokens : "增加 " + String(-result.savedTokens);
      report("ok", (dryRun ? "预览：" : "已写入日志：") + result.ops.length + " 个装配操作，" + saved + " tokens。" + (result.notes.length > 0 ? " " + result.notes.join("；") : ""));
    } catch (error) {
      report("error", error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }, [sessionId, pendingOps, loadTree, report]);

  const applyPresets = useCallback(async () => {
    if (sessionId === null) return;
    setBusy(true);
    try {
      const result = await api.plan({ sessionId: sessionId, ops: [], applyPresets: true }, false);
      await loadTree(sessionId);
      report("ok", "预设已应用：" + result.ops.length + " 个装配操作。" + result.notes.join("；"));
    } catch (error) {
      report("error", error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }, [sessionId, loadTree, report]);

  const savePresets = useCallback(async () => {
    if (sessionId === null) return;
    setBusy(true);
    try {
      const stored = await api.savePresets(sessionId, presetDraft);
      setPresetDraft(stored);
      await loadTree(sessionId);
      report("ok", "已保存 " + stored.length + " 条预设规则");
    } catch (error) {
      report("error", error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }, [sessionId, presetDraft, loadTree, report]);

  const saved = tree === null ? 0 : tree.stats.shadowedTokens;

  /**
   * Drag-to-place, with click still meaning "toggle the panel".
   *
   * Every fixed corner this button has been parked in turned out to sit on top
   * of something in some skin, so the position is the user's to choose and it is
   * remembered. The movement threshold is what keeps a slightly shaky click from
   * being read as a drag.
   */
  const onLauncherPointerDown = (event: React.PointerEvent<HTMLButtonElement>): void => {
    if (event.button !== 0) return;
    const rect = event.currentTarget.getBoundingClientRect();
    dragRef.current = {
      id: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      left: rect.left,
      top: rect.top,
      moved: false,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const onLauncherPointerMove = (event: React.PointerEvent<HTMLButtonElement>): void => {
    const drag = dragRef.current;
    if (drag === null || drag.id !== event.pointerId) return;
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 5) return;
    drag.moved = true;
    const width = event.currentTarget.offsetWidth;
    setAnchor({
      left: Math.round(Math.min(Math.max(0, drag.left + dx), window.innerWidth - width)),
      top: Math.round(Math.min(Math.max(0, drag.top + dy), window.innerHeight - 34)),
    });
  };

  const onLauncherPointerUp = (event: React.PointerEvent<HTMLButtonElement>): void => {
    const drag = dragRef.current;
    dragRef.current = null;
    if (drag === null) return;
    event.currentTarget.releasePointerCapture(event.pointerId);
    // The browser still delivers a click after a drag; swallow exactly that one.
    if (drag.moved) suppressClick.current = true;
  };

  const launcher = (
    <button
      type="button"
      className={open ? css.launcher + ' ' + css.launcherOpen : css.launcher}
      style={anchor === null ? undefined : { left: anchor.left, top: anchor.top, right: 'auto' }}
      onClick={() => {
        if (suppressClick.current) {
          suppressClick.current = false;
          return;
        }
        setOpen((value) => !value);
      }}
      onPointerDown={onLauncherPointerDown}
      onPointerMove={onLauncherPointerMove}
      onPointerUp={onLauncherPointerUp}
      onPointerCancel={onLauncherPointerUp}
      onDoubleClick={() => setAnchor(null)}
      title="组装式上下文：决定模型下一步读什么 (Ctrl+Shift+K)｜拖动可换位置，双击回到右上角"
      aria-expanded={open}
    >
      <svg className={css.launcherIcon} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" strokeLinecap="round" aria-hidden="true">
        <path d="M8 1.9 14 5 8 8.1 2 5z" />
        <path d="M2.6 8.4 8 11.3l5.4-2.9" opacity="0.75" />
        <path d="M2.6 11.6 8 14.5l5.4-2.9" opacity="0.45" />
      </svg>
      <span className={css.launcherLabel}>上下文</span>
      {tree === null ? null : (
        <span className={saved > 0 ? css.launcherBadge + ' ' + css.launcherBadgeGood : css.launcherBadge}>
          {saved > 0 ? '省' + tokens(saved) : tokens(tree.stats.visibleTokens)}
        </span>
      )}
    </button>
  );

  if (!open) return <div>{launcher}</div>;
  const stats = tree === null ? null : tree.stats;
  const anyExpanded = tree !== null && tree.nodes.some((node) => expanded[node.id] === true);
  const dirtyCount = readOnly ? 0 : pendingOps.length;

  // Stored conversations the storage backend refuses to read are left out of
  // the picker. They are old-format logs whose migration the harness itself
  // rejects, so they can never have a title or a tree here — listing them only
  // produced a wall of nameless rows that looked like lost data. The count is
  // still reported, so nothing disappears silently.
  const selectableSessions = sessions.filter((row) => row.readError === undefined);
  const hiddenSessions = sessions.length - selectableSessions.length;

  return (
    <div>
      {launcher}
      <div
        className={css.panel}
        // A dragged launcher is usually moved out of the corner to get at
        // something underneath, so the panel opens beside it rather than
        // jumping back to the top-right.
        style={anchor === null ? undefined : { top: anchor.top + 38 }}
      >
        <div className={css.header}>
          <span className={css.title}>组装式上下文</span>
          <span className={css.sub}>决定模型下一步读什么</span>
          <span className={css.spacer} />
          <select
            className={css.select}
            value={sessionId ?? ""}
            onChange={(event) => setSessionId(event.target.value === "" ? null : event.target.value)}
          >
            {sessions.length === 0 ? <option value="">（没有活动会话）</option> : null}
            {selectableSessions.map((row) => (
              <option key={row.id} value={row.id}>{sessionLabel(row)}</option>
            ))}
            {hiddenSessions > 0 ? (
              <option value="" disabled>
                {"（另有 " + hiddenSessions + " 段旧格式对话，harness 自己也无法迁移，已隐藏）"}
              </option>
            ) : null}
          </select>
          <button type="button" className={css.button} onClick={() => void loadSessions()} disabled={busy}>刷新</button>
          <button type="button" className={css.button} onClick={() => setOpen(false)}>关闭</button>
        </div>

        {status !== null ? (
          <div className={css.banner + " " + (status.kind === "error" ? css.bannerError : css.bannerOk)}>{status.text}</div>
        ) : null}

        <div className={css.stats}>
          <span className={css.stat}>模型可见 <b>{stats === null ? "-" : tokens(stats.visibleTokens)}</b> t</span>
          <span className={css.stat}>已折叠 <b>{stats === null ? "-" : tokens(stats.shadowedTokens)}</b> t</span>
          <span className={css.stat}>原始总量 <b>{stats === null ? "-" : tokens(stats.rawTokens)}</b> t</span>
          <span className={css.stat + " " + css.statGood}>省下 <b>{stats === null ? "-" : tokens(stats.shadowedTokens)}</b> t</span>
          <span className={css.stat}>表层节点 <b>{stats === null ? "-" : stats.surfaceNodes}</b></span>
          <span className={css.stat}>组装区 <b>{stats === null ? "-" : stats.foldedRegions}</b></span>
          <span className={css.stat}>消息 <b>{messages.length}</b></span>
        </div>

        <div className={css.toolbar}>
          <button type="button" className={css.button} disabled={busy} onClick={() => selectWhere((node) => node.kind === "tool" && node.state === "live", "key")}>工具结果 → 关键</button>
          <button type="button" className={css.button} disabled={busy} onClick={() => selectWhere((node) => node.kind === "assistant" && node.state === "live", "key")}>助手消息 → 关键</button>
          <button type="button" className={css.button} disabled={busy} onClick={() => selectWhere((node) => node.state === "live", "off")}>全部移出</button>
          <button type="button" className={css.button} disabled={busy} onClick={() => selectWhere((node) => node.state === "digest", "full")}>全部展开</button>
          <span className={css.spacer} />
          <button type="button" className={css.button} onClick={() => setAutoRefresh((value) => !value)}>{autoRefresh ? "自动刷新 开" : "自动刷新 关"}</button>
          <button type="button" className={css.button} onClick={() => setShowPresets((value) => !value)}>预设</button>
          <button type="button" className={css.button} onClick={() => setShowMessages((value) => !value)}>模型视图</button>
        </div>

        {readOnly ? (
          <div className={css.readOnlyStrip}>
            <b>历史会话</b>
            <span>从磁盘读出来的，看得到但不能改：写改动需要这个对话是打开的。点左侧会话列表里它的标题就能打开它。</span>
          </div>
        ) : null}

        <div className={css.tree}>
          {tree === null ? <div className={css.empty}>正在读取会话…</div> : null}
          {tree !== null && tree.nodes.length === 0 ? <div className={css.empty}>这个会话还没有任何表层节点。</div> : null}
          {tree !== null && tree.nodes.length > 0 && !anyExpanded ? (
            <div className={css.empty}>
              点开某一轮或某一步查看具体节点。
              <br />
              每个节点右侧的 原文 / 关键 / 移出 决定模型下一步读什么，改完按底部「应用」写入日志。
            </div>
          ) : null}
          {tree === null ? null : tree.nodes.map((node) => (
            <Row
              key={node.id}
              node={node}
              depth={0}
              pending={pending}
              expanded={expanded}
              previewOf={previewOf}
              onToggleExpand={(id) => setExpanded((current) => ({ ...current, [id]: current[id] !== true }))}
              onTogglePreview={(id) => setPreviewOf((current) => (current === id ? null : id))}
              onSetModes={setModes}
            />
          ))}
        </div>

        {showMessages ? (
          <div className={css.section}>
            <div className={css.sectionTitle}>模型当前收到的消息 <span className={css.hint}>按派生顺序</span></div>
            <div className={css.messages}>
              {messages.map((message) => (
                <div key={message.index} className={css.messageRow}>
                  <span className={css.tag}>{message.index}</span>
                  <span className={css.tag}>{message.role}</span>
                  <span className={css.tokens}>{tokens(message.tokens)} t</span>
                  <span className={css.messageText} title={message.preview}>{message.source + " · " + message.preview}</span>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        {showPresets ? (
          <div className={css.section}>
            <div className={css.sectionTitle}>
              预设规则
              <span className={css.hint}>命中的节点由规则决定装配模式</span>
              <span className={css.spacer} />
              <button type="button" className={css.button} disabled={busy} onClick={() => void applyPresets()}>应用预设</button>
              <button type="button" className={css.button} disabled={busy} onClick={() => void savePresets()}>保存</button>
            </div>
            {presetDraft.length === 0 ? <div className={css.hint}>还没有规则。用下面的模板快速添加。</div> : null}
            {presetDraft.map((preset, index) => (
              <div key={preset.id} className={css.presetRow}>
                <input
                  type="checkbox"
                  checked={preset.enabled}
                  onChange={(event) => setPresetDraft((current) => current.map((row, at) => at === index ? { ...row, enabled: event.target.checked } : row))}
                />
                <input
                  className={css.presetInput}
                  value={preset.name}
                  onChange={(event) => setPresetDraft((current) => current.map((row, at) => at === index ? { ...row, name: event.target.value } : row))}
                />
                <select
                  className={css.select}
                  value={preset.mode}
                  onChange={(event) => setPresetDraft((current) => current.map((row, at) => at === index ? { ...row, mode: event.target.value as "key" | "off" } : row))}
                >
                  <option value="key">关键</option>
                  <option value="off">移出</option>
                </select>
                <span className={css.hint}>{preset.match.kind ?? "任意"}{preset.match.isError === undefined ? "" : preset.match.isError ? " · 失败" : " · 成功"}</span>
                <button type="button" className={css.button + " " + css.danger} onClick={() => setPresetDraft((current) => current.filter((row, at) => at !== index))}>删除</button>
              </div>
            ))}
            <div className={css.presetRow}>
              <span className={css.hint}>模板：</span>
              {templates.map((template) => (
                <button
                  key={template.id}
                  type="button"
                  className={css.button}
                  onClick={() => setPresetDraft((current) => [...current, { ...template, id: template.id + "-" + String(current.length + 1) }])}
                >
                  {template.name}
                </button>
              ))}
            </div>
          </div>
        ) : null}

        <div className={css.footer}>
          <span className={css.hint}>
            {dirtyCount === 0
              ? "改动会写入会话日志：原文=原样保留，关键=折叠为一条摘要，移出=折叠为极短标记"
              : "待应用 " + dirtyCount + " 处改动（已自动保存，重启后仍在）"}
          </span>
          <span className={css.spacer} />
          {dirtyCount > 0 ? <button type="button" className={css.button} disabled={busy} onClick={() => { setPending({}); if (sessionId !== null) void api.saveDraft(sessionId, []).catch(() => undefined); }}>放弃改动</button> : null}
          <button type="button" className={css.button} disabled={busy || dirtyCount === 0} onClick={() => void apply(true)}>预览</button>
          <button type="button" className={css.button + " " + css.primary} disabled={busy || dirtyCount === 0} onClick={() => void apply(false)}>应用</button>
        </div>
      </div>
    </div>
  );
}
