/**
 * Host-half orchestration: read a context tree, compile and commit plans,
 * persist preset rules.
 *
 * The host half deliberately duck-types every harness service it touches.
 * An external dsh plugin node half resolves only `@deepseek-ai/cordis` plus
 * its own dependencies — `@deepseek-ai/dsh-session`, `dsh-tools` and friends
 * are not reachable from a linked package — so importing their types would
 * silently inline a second copy of a runtime contract. The interfaces below
 * restate exactly the surface this plugin uses, and every call site degrades
 * gracefully when a service is absent (a headless profile has no webServer,
 * for instance).
 *
 * @module dsh-context-assembler/host/service
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import type {
  ContextAssemblerConfig,
  ContextMessageView,
  ContextNodeView,
  ContextPlanOp,
  ContextPlanResponse,
  ContextPreset,
  ContextSessionView,
  ContextTreeResponse,
  CompiledOp,
} from '../shared/types.ts'
import { estimateTokens, foldSurface, messageText, projectEvent, type LogEvent } from './surface.ts'
import { buildContextTree, matchPreset, PLUGIN_ID, type TreeInput, type TreeResult } from './tree.ts'
import { compilePlan, DEFAULT_DIGEST_OPTIONS, type DigestOptions } from './planner.ts'

/** The subset of a live Session this plugin reads and writes. */
export interface SessionLike {
  readonly id: string
  readonly seq: number
  readonly header?: {
    readonly id?: string
    readonly createdAt?: number
    readonly cwd?: string
    readonly parentSession?: string
    readonly origin?: string
    readonly delegationDepth?: number
  }
  snapshotEvents(): unknown[]
  deriveMessages(): unknown[]
  append(type: string, data: unknown, opts?: unknown): unknown
}

/** The subset of ctx.sessions this plugin uses. */
export interface SessionStoreLike {
  list(): SessionLike[]
  get(id: string): SessionLike | undefined
}

/** A cordis-style context, narrowed to what this plugin calls. */
/**
 * The slice of the token meter this plugin uses.
 *
 * `measure` replays the session log and returns request pressure anchored to
 * whatever the provider last reported, which is a different and better number
 * than summing the message list.
 */
export interface TokenMeterLike {
  measure(session: unknown): { totalTokens?: number }
}

export interface HostContextLike {
  sessions?: SessionStoreLike
  on?(name: string, listener: (...args: unknown[]) => void): unknown
  effect?(callback: () => (() => void) | void, name?: string): unknown
  get?(name: string): unknown
}

/** Loaded plugin configuration with defaults resolved. */
export interface ResolvedConfig extends ContextAssemblerConfig {
  dataDir: string
}

/** Tool names whose calls may have spawned a subagent session. */
const DELEGATION_TOOLS = new Set(['subagent', 'subagent_fork', 'workflow', 'run_code'])

/** Resolve the plugin data directory. */
export function resolveDataDir(configured?: string): string {
  if (configured !== undefined && configured !== '') return configured
  const home = process.env.DSH_HOME ?? process.env.USERPROFILE ?? process.env.HOME ?? homedir()
  const base = home.endsWith('.dsh') ? home : join(home, '.dsh')
  return join(base, 'context-assembler')
}

/** Fill in defaults for a partial configuration. */
export function resolveConfig(partial: Partial<ContextAssemblerConfig> | undefined): ResolvedConfig {
  const input = partial ?? {}
  return {
    port: typeof input.port === 'number' && input.port > 0 ? input.port : 4799,
    dataDir: resolveDataDir(input.dataDir),
    offMarker: input.offMarker ?? '（{count} 项已移出上下文，约 {tokens} tokens）',
    digestHeadLines: input.digestHeadLines ?? 12,
    digestTailLines: input.digestTailLines ?? 4,
    digestMaxChars: input.digestMaxChars ?? 6000,
    exposeTool: input.exposeTool !== false,
  }
}

/**
 * Persisted preset table, keyed by session id.
 *
 * Session ids are NOT stable across a restart: continuing a stored conversation
 * makes the harness fork it, and the fork gets a fresh id. Both tables below are
 * therefore read through {@link ContextAssembler.ancestry} — a session with no
 * entry of its own inherits its nearest recorded ancestor's — so rules and
 * drafts follow a conversation instead of dying with one id.
 */
interface PresetFile {
  version: 1
  sessions: Record<string, ContextPreset[]>
}

/** Persisted work-in-progress table, keyed by session id. */
interface DraftFile {
  version: 1
  sessions: Record<string, ContextPlanOp[]>
}

/** How long a failed stored-session read waits before being retried. */
const FAILURE_RETRY_MS = 120_000

/** What one stored session is worth showing in a list, without opening it. */
interface StoredSummary {
  /** The session title the harness itself would show. */
  title: string
  /** Number of durable events in the log. */
  events: number
  /** Wall clock of the newest event. */
  updatedAt: number
  /** Artifact size when this summary was taken, used as a change guard. */
  sizeBytes: number
  /** Why the summary could not be produced, when it could not. */
  error?: string
  /** When the failure was recorded, so it is retried on a slow timer. */
  failedAt?: number
}

/**
 * Cache of per-session summaries for stored conversations.
 *
 * A storage snapshot carries the header and the artifact size and nothing else:
 * no title and no event count, because neither lives in the header. Both live in
 * the log, so showing them means reading it. Reading every stored log on every
 * list call is not an option, so each one is read once and remembered here,
 * guarded by the artifact size so an edited conversation is read again.
 */
interface SessionIndexFile {
  version: 1
  entries: Record<string, StoredSummary>
}

/**
 * Structural view of the harness session-persistence service.
 *
 * A stored session can be READ without taking ownership and without disturbing
 * whoever holds it, which is what lets the panel show the context of a
 * conversation nobody has open.
 */
export interface SessionPersistenceLike {
  list(options?: unknown): Promise<readonly PersistenceSnapshotLike[]>
  open(id: string, access: 'read' | 'write', options?: unknown): Promise<PersistenceHandleLike>
}

/** Storage metadata for one stored session, without its event log. */
export interface PersistenceSnapshotLike {
  readonly header?: {
    readonly id?: string
    readonly cwd?: string
    readonly createdAt?: number
    readonly parentSession?: string
  }
  readonly eventCount?: number
  readonly sizeBytes?: number
}

/** An open stored session; only read and close are used here. */
export interface PersistenceHandleLike {
  read(): Promise<{ readonly events?: readonly unknown[] }>
  close?(): Promise<void> | void
}

/** How the service reaches the persistence backend, which may not be mounted. */
export type PersistenceLookup = () => SessionPersistenceLike | undefined

/** Normalise raw log records into the plain events this plugin folds. */
export function toLogEvents(raw: readonly unknown[]): LogEvent[] {
  const out: LogEvent[] = []
  for (const item of raw) {
    const event = item as Partial<LogEvent>
    if (event === null || typeof event !== 'object') continue
    if (typeof event.seq !== 'number' || typeof event.type !== 'string') continue
    out.push({
      type: event.type,
      seq: event.seq,
      time: typeof event.time === 'number' ? event.time : 0,
      data: (event.data ?? {}) as Record<string, unknown>,
      surfaceOp: event.surfaceOp,
      sourceEventSeqs: event.sourceEventSeqs,
    })
  }
  return out
}

/** Read a live session log as plain events this plugin can fold. */
export function readEvents(session: SessionLike): LogEvent[] {
  return toLogEvents(session.snapshotEvents())
}

/** Render the current derived history for the panel "what the model sees" strip. */
export function describeMessages(session: SessionLike): ContextMessageView[] {
  const messages = session.deriveMessages()
  const out: ContextMessageView[] = []
  messages.forEach((item, index) => {
    const message = item as {
      role?: string
      content?: Array<Record<string, unknown>>
      source?: Record<string, unknown>
    }
    const role = message.role === 'system' || message.role === 'assistant' ? message.role : 'user'
    const text = messageText({ role, content: message.content ?? [] })
    const source = message.source ?? {}
    const kind = typeof source['kind'] === 'string' ? (source['kind'] as string) : 'user'
    const plugin = typeof source['plugin'] === 'string' ? (source['plugin'] as string) : ''
    out.push({
      index,
      role,
      source: kind === 'plugin' ? 'plugin:' + plugin : kind,
      chars: text.length,
      tokens: estimateTokens(text),
      preview: text.slice(0, 200),
    })
  })
  return out
}

/**
 * The same message list for a session that is not live.
 *
 * A stored session has no Session object to ask, so the list is rebuilt from
 * the log: the surface fold picks the nodes the model would read, and each one
 * projects to its message exactly as it does for a live session.
 * @param events - the stored log.
 * @returns one row per message the model would receive.
 */
export function describeMessagesFromEvents(events: readonly LogEvent[]): ContextMessageView[] {
  const bySeq = new Map<number, LogEvent>()
  for (const event of events) bySeq.set(event.seq, event)
  const out: ContextMessageView[] = []
  for (const seq of foldSurface(events).nodes) {
    const event = bySeq.get(seq)
    if (event === undefined) continue
    const message = projectEvent(event)
    if (message === null) continue
    const role = message.role === 'system' || message.role === 'assistant' ? message.role : 'user'
    const text = messageText(message)
    const source = message.source ?? {}
    const kind = typeof source['kind'] === 'string' ? (source['kind'] as string) : 'user'
    const plugin = typeof source['plugin'] === 'string' ? (source['plugin'] as string) : ''
    out.push({
      index: out.length,
      role,
      source: kind === 'plugin' ? 'plugin:' + plugin : kind,
      chars: text.length,
      tokens: estimateTokens(text),
      preview: text.slice(0, 200),
    })
  }
  return out
}

/** Depth-first walk over a row list. */
export function flatten(nodes: readonly ContextNodeView[]): ContextNodeView[] {
  const out: ContextNodeView[] = []
  const stack = [...nodes]
  while (stack.length > 0) {
    const node = stack.pop()!
    out.push(node)
    if (node.children !== undefined) stack.push(...node.children)
  }
  return out
}

/** A stable, readable preset id. */
function mintPresetId(): string {
  return 'preset-' + Date.now().toString(36) + '-' + Math.floor(Math.random() * 0xffff).toString(36)
}

/** The context-assembly host service: tree reads, plan commits, and presets. */
export class ContextAssembler {
  private readonly store: SessionStoreLike
  private readonly config: ResolvedConfig
  private readonly digest: DigestOptions
  private readonly presetPath: string
  private readonly draftPath: string
  private readonly indexPath: string
  private readonly persistence: PersistenceLookup
  private readonly log: (message: string) => void
  private index: SessionIndexFile = { version: 1, entries: {} }
  private readonly meterLookup: () => TokenMeterLike | undefined
  private indexing = false
  private readFailures = 0
  private lastReadError: string | undefined
  private presets: PresetFile = { version: 1, sessions: {} }
  private drafts: DraftFile = { version: 1, sessions: {} }

  constructor(
    store: SessionStoreLike,
    config: ResolvedConfig,
    persistence?: PersistenceLookup,
    log?: (message: string) => void,
    meterLookup?: () => TokenMeterLike | undefined,
  ) {
    this.meterLookup = meterLookup ?? (() => undefined)
    this.persistence = persistence ?? (() => undefined)
    this.log = log ?? (() => undefined)
    this.store = store
    this.config = config
    this.digest = {
      offMarker: config.offMarker,
      headLines: config.digestHeadLines,
      tailLines: config.digestTailLines,
      maxChars: config.digestMaxChars,
    }
    this.presetPath = join(config.dataDir, 'presets.json')
    this.draftPath = join(config.dataDir, 'drafts.json')
    this.indexPath = join(config.dataDir, 'sessions-index.json')
    this.loadPresets()
    this.loadDrafts()
    this.loadIndex()
  }

  /**
   * Start reading stored-session summaries in the background.
   *
   * Called once when the plugin mounts, so the picker already knows real
   * titles by the time anybody opens it. Nothing here is on a request path:
   * the reads are single-flight and every caller keeps working with whatever
   * the index holds right now.
   */
  warmIndex(): void {
    // The persistence service is registered but not necessarily ACTIVE when
    // this plugin mounts, so the first look can legitimately come back empty.
    // Without the retry the warm-up silently does nothing on a profile whose
    // boot order puts persistence after this row — which is exactly the case
    // that leaves the picker full of unlabelled rows.
    const attempt = (remaining: number): void => {
      if (this.persistence() !== undefined) {
        void this.refreshIndex()
        return
      }
      if (remaining <= 0) return
      const timer = setTimeout(() => attempt(remaining - 1), 1500)
      timer.unref?.()
    }
    attempt(10)
  }

  /** Public configuration, for the panel footer. */
  describeConfig(): ResolvedConfig {
    return this.config
  }

  /**
   * Every session the panel can open: the live ones plus every stored one.
   *
   * The stored half is the point. The harness only pulls a conversation into
   * the live store once somebody opens it, so a list built from the store alone
   * silently hides every past conversation — the panel looks empty exactly when
   * the user wants to look back at something.
   * @returns picker rows, newest first.
   */
  async listSessions(): Promise<ContextSessionView[]> {
    let newest = -1
    const rows: ContextSessionView[] = []
    const known = new Set<string>()
    for (const session of this.store.list()) {
      const events = readEvents(session)
      const updatedAt = events.length === 0 ? session.header?.createdAt ?? 0 : events[events.length - 1]!.time
      newest = Math.max(newest, updatedAt)
      known.add(session.id)
      rows.push({
        id: session.id,
        title: this.titleOf(events, session.id),
        cwd: session.header?.cwd,
        parentSessionId: session.header?.parentSession,
        createdAt: session.header?.createdAt ?? 0,
        updatedAt,
        events: events.length,
        recent: false,
        cold: false,
      })
    }
    const persistence = this.persistence()
    if (persistence !== undefined) {
      try {
        for (const snapshot of await persistence.list()) {
          const id = snapshot.header?.id
          if (typeof id !== 'string' || id === '' || known.has(id)) continue
          known.add(id)
          const createdAt = snapshot.header?.createdAt ?? 0
          // A snapshot has no title and no event count, so both come from the
          // summary cache. Until the read lands the row shows what it can;
          // refreshIndex fills the rest in without blocking this call.
          const summary = this.index.entries[id]
          rows.push({
            id,
            title: summary === undefined ? '' : summary.title,
            cwd: snapshot.header?.cwd,
            parentSessionId: snapshot.header?.parentSession,
            createdAt,
            updatedAt: summary === undefined ? createdAt : summary.updatedAt,
            events: summary === undefined ? 0 : summary.events,
            sizeBytes: snapshot.sizeBytes,
            readError: summary?.error,
            recent: false,
            cold: true,
          })
        }
        // Fire and forget: the list is already usable, and titles land shortly.
        void this.refreshIndex()
      } catch {
        // Losing the stored list must not take the live list down with it.
      }
    }
    for (const row of rows) row.recent = row.updatedAt === newest
    rows.sort((a, b) => b.updatedAt - a.updatedAt)
    return rows
  }

  /** The session id the panel should open by default, preferring a live one. */
  async defaultSessionId(): Promise<string | null> {
    const rows = await this.listSessions()
    const live = rows.filter((row) => row.cold !== true)
    const pool = live.length > 0 ? live : rows
    const top = pool.find((row) => row.parentSessionId === undefined) ?? pool[0]
    return top === undefined ? null : top.id
  }

  /**
   * Read one session context tree, live or stored.
   *
   * A live session is read from the store and stays editable. A stored one is
   * read from persistence with `read` access, which takes no ownership and
   * leaves the conversation untouched — the whole point being that looking at a
   * past conversation must not require reopening (and therefore forking) it.
   * @param sessionId - the session to read.
   * @param depth - nesting depth below the root read.
   * @param seen - sessions already visited, guarding against cycles.
   * @returns the tree, flagged read-only when the session is not live.
   */
  async readTree(sessionId: string, depth = 0, seen = new Set<string>()): Promise<ContextTreeResponse> {
    const session = this.store.get(sessionId)
    if (session !== undefined) {
      const built = this.buildFor(session, depth, seen)
      this.attachSubagents(built.nodes, session, depth, seen)
      return {
        ok: true,
        sessionId,
        title: this.titleOf(readEvents(session), session.id),
        cwd: session.header?.cwd,
        readOnly: false,
        stats: built.stats,
        nodes: built.nodes,
        operations: built.operations,
        presets: this.presetsFor(sessionId),
        draft: this.draftFor(sessionId),
        at: Date.now(),
      }
    }
    const events = await this.readStoredEvents(sessionId)
    if (events === undefined) {
      // Prefer the reason the storage backend actually gave. "Not found" is
      // wrong and unhelpful for a conversation whose log exists but cannot be
      // migrated — the user can see the file sitting there.
      const reason = this.index.entries[sessionId]?.error
      throw new Error(
        reason === undefined
          ? '会话 ' + sessionId + ' 既不在活动会话表里，也没有找到持久化记录'
          : '会话 ' + sessionId + ' 的日志读不出来：' + reason,
      )
    }
    const built = buildContextTree({
      sessionId,
      title: this.titleOf(events, sessionId),
      events,
      presets: this.presetsFor(sessionId),
    })
    return {
      ok: true,
      sessionId,
      title: this.titleOf(events, sessionId),
      cwd: undefined,
      readOnly: true,
      stats: built.stats,
      nodes: built.nodes,
      operations: built.operations,
      presets: this.presetsFor(sessionId),
      draft: this.draftFor(sessionId),
      at: Date.now(),
    }
  }

  /**
   * Context pressure for one session, preferring the provider-anchored figure.
   *
   * Summing the message list is a heuristic over whatever the surface happens to
   * hold. The meter reports what the provider actually charged the last request
   * at. The second is the number a reader should trust, so it wins when present,
   * and the caller is told which one it got.
   *
   * Only live sessions can be measured: a stored log is replayed as text, and
   * pricing it would invent a route it was never sent under.
   * @param sessionId - the session to measure.
   * @returns the measured size and whether it is provider-anchored, or null.
   */
  usageFor(sessionId: string): { tokens: number; anchored: boolean } | null {
    const session = this.store.get(sessionId)
    if (session === undefined) return null
    const meter = this.meterLookup()
    if (meter === undefined) return null
    try {
      const measured = meter.measure(session)
      const tokens = measured?.totalTokens
      if (typeof tokens === 'number' && tokens > 0) return { tokens, anchored: true }
    } catch {
      // A meter failure must degrade to the heuristic, never break the tool.
    }
    return null
  }

  /** The derived history for any session, live or stored. */
  async messagesFor(sessionId: string): Promise<ContextMessageView[]> {
    const session = this.store.get(sessionId)
    if (session !== undefined) return describeMessages(session)
    const events = await this.readStoredEvents(sessionId)
    return events === undefined ? [] : describeMessagesFromEvents(events)
  }

  /**
   * Read a stored log without opening the conversation.
   *
   * `read` access never claims ownership, so this works while another process
   * (or the live agent) holds the session. Every failure degrades to undefined:
   * a profile without persistence, or an unreadable artifact, must read as
   * "not available" rather than break the panel.
   * @param sessionId - the stored session to read.
   * @returns its events, or undefined when they cannot be read.
   */
  private async readStoredEvents(sessionId: string): Promise<LogEvent[] | undefined> {
    const persistence = this.persistence()
    if (persistence === undefined) return undefined
    let handle: PersistenceHandleLike | undefined
    try {
      handle = await persistence.open(sessionId, 'read')
      const inspection = await handle.read()
      return toLogEvents(inspection.events ?? [])
    } catch (error) {
      // Kept, not swallowed: an unreadable stored conversation shows up only as
      // a nameless row, and "why is this one unnamed" is unanswerable without
      // the underlying reason. It travels to the panel on the row itself.
      this.lastReadError = String(error)
      this.readFailures += 1
      if (this.readFailures <= 12) {
        this.log('[context-assembler] 读取已存会话失败 ' + sessionId + '：' + String(error))
      }
      return undefined
    } finally {
      try {
        await handle?.close?.()
      } catch {
        // Releasing a read handle is best effort.
      }
    }
  }

  /**
   * Compile a plan and, unless it is a dry run, commit it to the session log.
   * @param request - target session, the toggles, and whether presets run first.
   * @param dryRun - when true nothing is appended; only the compiled ops come back.
   * @returns the compiled ops, the appended seqs, and the resulting message list.
   */
  async applyPlan(
    request: { sessionId: string; ops: ContextPlanOp[]; applyPresets?: boolean },
    dryRun: boolean,
  ): Promise<ContextPlanResponse> {
    const session = this.requireSession(request.sessionId)
    const ops: ContextPlanOp[] = []
    const notes: string[] = []
    const claimed = new Set<number>()
    if (request.applyPresets === true) {
      const tree = await this.readTree(request.sessionId)
      for (const node of flatten(tree.nodes)) {
        if (node.surfaceSeq === null || !node.selectable) continue
        const preset = matchPreset(node, this.presetsFor(request.sessionId))
        if (preset === null) continue
        ops.push({ surfaceSeq: node.surfaceSeq, mode: preset.mode, digest: preset.template })
        claimed.add(node.surfaceSeq)
      }
      if (ops.length > 0) notes.push('预设规则匹配到 ' + ops.length + ' 个节点')
    }
    for (const op of request.ops) {
      if (claimed.has(op.surfaceSeq)) continue
      ops.push(op)
    }

    const compiled = compilePlan(readEvents(session), ops, this.digest)
    notes.push(...compiled.notes)
    const compiledOps: CompiledOp[] = compiled.instructions.map((instruction) => instruction.op)
    const appendedSeqs: number[] = []
    if (!dryRun) {
      for (const instruction of compiled.instructions) {
        const payload = {
          surfaceOp: {
            op: 'replace',
            startSeq: instruction.op.startSeq,
            endSeq: instruction.op.endSeq,
          },
          sourceEventSeqs: instruction.sourceEventSeqs,
        }
        const appended = session.append(instruction.type, instruction.data, payload) as { seq?: number } | undefined
        if (appended !== undefined && typeof appended.seq === 'number') appendedSeqs.push(appended.seq)
      }
    }

    const previous = compiledOps.reduce((sum, op) => sum + op.previousTokens, 0)
    const now = compiledOps.reduce((sum, op) => sum + op.tokens, 0)
    return {
      ok: true,
      sessionId: request.sessionId,
      dryRun,
      ops: compiledOps,
      appendedSeqs,
      savedTokens: previous - now,
      notes,
      messages: describeMessages(session),
    }
  }

  /** Replace the preset rules stored for one session. */
  setPresets(sessionId: string, presets: ContextPreset[]): ContextPreset[] {
    this.presets.sessions[sessionId] = presets.map((preset) => ({
      ...preset,
      id: preset.id === undefined || preset.id === '' ? mintPresetId() : preset.id,
    }))
    this.savePresets()
    return this.presetsFor(sessionId)
  }

  /** The derived history one session currently sends, for the API and the tool. */
  describeMessagesFor(session: SessionLike): ContextMessageView[] {
    return describeMessages(session)
  }

  /**
   * Preset rules in force for one session: its own entry, else the nearest
   * ancestor's.
   * @param sessionId - the session being read.
   * @returns the stored rules, or an empty list.
   */
  presetsFor(sessionId: string): ContextPreset[] {
    for (const id of this.ancestry(sessionId)) {
      const entry = this.presets.sessions[id]
      if (entry !== undefined) return entry
    }
    return []
  }

  /** Replace the unapplied plan saved for one session. */
  setDraft(sessionId: string, ops: ContextPlanOp[]): ContextPlanOp[] {
    if (ops.length === 0) this.drafts.sessions[sessionId] = []
    else this.drafts.sessions[sessionId] = ops
    this.saveDrafts()
    return this.drafts.sessions[sessionId] ?? []
  }

  /** The unapplied plan a session (or its nearest recorded ancestor) left behind. */
  draftFor(sessionId: string): ContextPlanOp[] {
    for (const id of this.ancestry(sessionId)) {
      const entry = this.drafts.sessions[id]
      if (entry !== undefined) return entry
    }
    return []
  }

  /**
   * The session and its ancestry, nearest first.
   *
   * The walk stops at the first ancestor that is no longer live, because its
   * own parent is unknowable from here — but that ancestor's id is still in the
   * chain, so entries recorded against it are still found.
   * @param sessionId - the session to trace.
   * @returns session ids, nearest first.
   */
  private ancestry(sessionId: string): string[] {
    const chain: string[] = [sessionId]
    const seen = new Set<string>([sessionId])
    let current: SessionLike | undefined = this.store.get(sessionId)
    for (let depth = 0; depth < 32 && current !== undefined; depth += 1) {
      const parentId = current.header?.parentSession
      if (parentId === undefined || parentId === '' || seen.has(parentId)) break
      chain.push(parentId)
      seen.add(parentId)
      current = this.store.get(parentId)
    }
    return chain
  }

  /** Resolve a live session or throw a readable error. */
  requireSession(sessionId: string): SessionLike {
    const session = this.store.get(sessionId)
    if (session === undefined) {
      throw new Error(
        '会话 ' + sessionId + ' 不在活动会话表中。历史会话可以在面板里查看，'
        + '但要改动它得先在左侧会话列表里把这个对话打开。',
      )
    }
    return session
  }

  /** Build one session tree without subagent attachment. */
  private buildFor(session: SessionLike, depth: number, seen: Set<string>): TreeResult {
    seen.add(session.id)
    const input: TreeInput = {
      sessionId: session.id,
      title: this.titleOf(readEvents(session), session.id),
      cwd: session.header?.cwd,
      events: readEvents(session),
      presets: this.presetsFor(session.id),
      depth,
    }
    return buildContextTree(input)
  }

  /**
   * Nest live subagent sessions under the tool node that produced them.
   *
   * The log records no parent pointer on a tool result, so the link is
   * inferred: an exact mention of the child session id in the tool result text
   * first, then the first unclaimed delegation-shaped tool node. Unlinked
   * children are surfaced at the root, so a session is never invisible merely
   * because the inference failed.
   */
  private attachSubagents(nodes: ContextNodeView[], root: SessionLike, depth: number, seen: Set<string>): void {
    if (depth >= 3) return
    const children = this.store.list().filter((session) => {
      return session.header?.parentSession === root.id && !seen.has(session.id)
    })
    if (children.length === 0) return
    const bySeq = new Map<number, LogEvent>()
    for (const event of readEvents(root)) bySeq.set(event.seq, event)
    const unassigned = new Map<string, SessionLike>()
    for (const child of children) unassigned.set(child.id, child)

    for (const node of flatten(nodes)) {
      if (node.surfaceSeq === null) continue
      const event = bySeq.get(node.surfaceSeq)
      if (event === undefined) continue
      const text = messageText(projectEvent(event))
      let matched: SessionLike | undefined
      for (const child of unassigned.values()) {
        if (text.includes(child.id)) {
          matched = child
          break
        }
      }
      if (matched === undefined && node.toolName !== undefined && DELEGATION_TOOLS.has(node.toolName)) {
        for (const child of unassigned.values()) {
          matched = child
          break
        }
      }
      if (matched === undefined) continue
      unassigned.delete(matched.id)
      const wrapper = this.subagentWrapper(matched, depth, seen, false)
      if (node.children === undefined) node.children = [wrapper]
      else node.children.push(wrapper)
      node.label = node.label + ' → 子代理'
    }

    for (const child of unassigned.values()) {
      nodes.push(this.subagentWrapper(child, depth, seen, true))
    }
  }

  /** One subagent container row, with the child session tree inside. */
  private subagentWrapper(child: SessionLike, depth: number, seen: Set<string>, orphan: boolean): ContextNodeView {
    const childTree = this.buildFor(child, depth + 1, seen)
    this.attachSubagents(childTree.nodes, child, depth + 1, seen)
    const prefix = orphan ? '未挂载的子代理会话 · ' : '子代理会话 · '
    return {
      id: 'sub-' + child.id,
      kind: 'session',
      label: prefix + this.titleOf(readEvents(child), child.id),
      surfaceSeq: null,
      fromSeq: null,
      toSeq: null,
      state: 'live',
      mode: 'full',
      tokens: childTree.stats.visibleTokens,
      chars: 0,
      preview: '子会话 ' + child.id + ' 拥有独立表层；请在会话列表中切换过去再装配它',
      selectable: false,
      protectedReason: '子代理拥有独立会话，其上下文在自己的表层上装配',
      children: childTree.nodes,
      depth: depth + 1,
    }
  }

  /**
   * A short readable title for one session, taken from its first user message.
   *
   * Log-based rather than store-based so a stored session, which has no live
   * object to ask, is titled exactly like a live one.
   * @param events - the session log.
   * @param fallbackId - used when the log carries no user message yet.
   * @returns the title.
   */
  private titleOf(events: readonly LogEvent[], fallbackId: string): string {
    const firstUser = events.find((event) => {
      if (event.type !== 'user/message') return false
      const source = (event.data as { source?: { kind?: string } }).source
      return source?.kind === 'user'
    })
    if (firstUser === undefined) return fallbackId
    const text = messageText(projectEvent(firstUser)).replace(/\s+/g, ' ').trim()
    return text === '' ? fallbackId : text.slice(0, 48)
  }

  /** Load the preset table from disk, tolerating a missing or corrupt file. */
  private loadPresets(): void {
    try {
      if (!existsSync(this.presetPath)) return
      const parsed = JSON.parse(readFileSync(this.presetPath, 'utf8')) as Partial<PresetFile>
      if (parsed !== null && typeof parsed === 'object' && parsed.sessions !== undefined) {
        this.presets = { version: 1, sessions: parsed.sessions as Record<string, ContextPreset[]> }
      }
    } catch {
      this.presets = { version: 1, sessions: {} }
    }
  }

  /** Persist the preset table. */
  private savePresets(): void {
    try {
      mkdirSync(dirname(this.presetPath), { recursive: true })
      writeFileSync(this.presetPath, JSON.stringify(this.presets, null, 2), 'utf8')
    } catch {
      // A read-only data directory must not break assembly; presets are advisory.
    }
  }

  /** Load the draft table, tolerating a missing or corrupt file. */
  private loadDrafts(): void {
    try {
      if (!existsSync(this.draftPath)) return
      const parsed = JSON.parse(readFileSync(this.draftPath, 'utf8')) as Partial<DraftFile>
      if (parsed !== null && typeof parsed === 'object' && parsed.sessions !== undefined) {
        this.drafts = { version: 1, sessions: parsed.sessions as Record<string, ContextPlanOp[]> }
      }
    } catch {
      this.drafts = { version: 1, sessions: {} }
    }
  }

  /**
   * Persist the draft table.
   *
   * A draft is the user's unapplied plan. It is deliberately NOT the session
   * log: nothing the model reads changes until 应用 is pressed. Persisting it
   * only means a reload or a host restart no longer throws the work away.
   */
  private saveDrafts(): void {
    try {
      mkdirSync(dirname(this.draftPath), { recursive: true })
      writeFileSync(this.draftPath, JSON.stringify(this.drafts, null, 2), 'utf8')
    } catch {
      // Same stance as presets: losing a draft must never break assembly.
    }
  }

  /** Load the stored-session summary cache, tolerating a missing or corrupt file. */
  private loadIndex(): void {
    try {
      if (!existsSync(this.indexPath)) return
      const parsed = JSON.parse(readFileSync(this.indexPath, 'utf8')) as Partial<SessionIndexFile>
      if (parsed !== null && typeof parsed === 'object' && parsed.entries !== undefined) {
        this.index = { version: 1, entries: parsed.entries as Record<string, StoredSummary> }
      }
    } catch {
      this.index = { version: 1, entries: {} }
    }
  }

  /**
   * Persist the stored-session summary cache.
   *
   * Written through a temporary file and renamed, because this file is
   * rewritten once per summary and a torn read is not a cosmetic problem: the
   * loader falls back to an empty table on a parse failure, so half a file
   * would cost every title read so far.
   */
  private saveIndex(): void {
    const temporary = this.indexPath + '.tmp'
    try {
      mkdirSync(dirname(this.indexPath), { recursive: true })
      writeFileSync(temporary, JSON.stringify(this.index, null, 2), 'utf8')
      renameSync(temporary, this.indexPath)
    } catch {
      // Advisory cache: an unwritable data directory must not break the list.
    }
  }

  /**
   * Summarise a stored session: its title, its event count, and its recency.
   *
   * The title comes from the newest `session/title` event, which is the same
   * value the harness sidebar shows. Falling back to the first user message
   * covers conversations that never got a generated title.
   * @param sessionId - the stored session to read.
   * @returns the summary, or undefined when the log cannot be read.
   */
  private async summariseStored(sessionId: string): Promise<Omit<StoredSummary, 'sizeBytes'> | undefined> {
    const events = await this.readStoredEvents(sessionId)
    if (events === undefined) return undefined
    let title = ''
    for (const event of events) {
      if (event.type !== 'session/title') continue
      const value = (event.data as { title?: unknown }).title
      if (typeof value === 'string' && value.trim() !== '') title = value.trim()
    }
    const last = events[events.length - 1]
    return {
      title: title === '' ? this.titleOf(events, sessionId) : title,
      events: events.length,
      updatedAt: last === undefined ? 0 : last.time,
    }
  }

  /**
   * Fill in summaries for stored sessions that have none, or whose log changed.
   *
   * Deliberately fire-and-forget and single-flight: the caller gets a list
   * immediately and titles appear as the reads land, instead of the picker
   * blocking on reading every stored log before it can render.
   * @returns nothing; the index is updated in place.
   */
  private async refreshIndex(): Promise<void> {
    if (this.indexing) return
    const persistence = this.persistence()
    if (persistence === undefined) return
    this.indexing = true
    try {
      const snapshots = await persistence.list()
      // Smallest first: a summary costs a full log read, so this gets titles
      // onto as many rows as possible as early as possible.
      const pending = [...snapshots].sort((a, b) => (a.sizeBytes ?? 0) - (b.sizeBytes ?? 0))
      for (const snapshot of pending) {
        const id = snapshot.header?.id
        if (typeof id !== 'string' || id === '') continue
        const sizeBytes = snapshot.sizeBytes ?? 0
        const known = this.index.entries[id]
        if (known !== undefined) {
          // A summary that worked is trusted until the artifact changes. A
          // failure is retried on a slow timer instead of being cached forever:
          // the usual cause is transient, and a permanent "unreadable" label
          // would outlive the condition that produced it.
          if (known.error === undefined) {
            if (sizeBytes > 0 && known.sizeBytes === sizeBytes) continue
          } else if (Date.now() - (known.failedAt ?? 0) < FAILURE_RETRY_MS) {
            continue
          }
        }
        this.lastReadError = undefined
        const summary = await this.summariseStored(id)
        if (summary === undefined) {
          this.index.entries[id] = {
            title: '',
            events: 0,
            updatedAt: snapshot.header?.createdAt ?? 0,
            sizeBytes,
            error: this.lastReadError ?? 'unknown failure',
            failedAt: Date.now(),
          }
        } else {
          this.index.entries[id] = { ...summary, sizeBytes }
        }
        // Written per entry rather than once at the end: this cache is built in
        // the background of a host that may exit at any moment, and an
        // all-or-nothing write would throw away every summary read so far.
        this.saveIndex()
      }
    } catch {
      // A failing backend leaves the previous summaries in place.
    } finally {
      this.indexing = false
    }
  }
}

/** Ready-made preset: every successful tool result folds to its key parts. */
export function presetTemplateSuccess(): ContextPreset {
  return {
    id: 'preset-tool-ok',
    name: '工具调用成功 → 只保留关键部分',
    enabled: true,
    match: { kind: 'tool', isError: false },
    mode: 'key',
    auto: false,
  }
}

/** Ready-made preset: a failed tool call whose error was already ruled out. */
export function presetTemplateFailed(): ContextPreset {
  return {
    id: 'preset-tool-failed',
    name: '工具失败且已排查 → 只保留关键部分',
    enabled: false,
    match: { kind: 'tool', isError: true },
    mode: 'key',
    auto: false,
  }
}

/** Ready-made preset: assistant prose that became an implementation detail. */
export function presetTemplateAssistant(): ContextPreset {
  return {
    id: 'preset-assistant-key',
    name: '助手消息 → 只保留关键部分',
    enabled: false,
    match: { kind: 'assistant' },
    mode: 'key',
    auto: false,
  }
}

/** The templates the panel offers as one-click presets. */
export const PRESET_TEMPLATES: ContextPreset[] = [
  presetTemplateSuccess(),
  presetTemplateFailed(),
  presetTemplateAssistant(),
]

/** Plugin id, re-exported so the entry point states it once. */
export { PLUGIN_ID, DEFAULT_DIGEST_OPTIONS }
