/**
 * Turn a session log into the context tree the panel renders.
 *
 * The tree is a *read* of the log: it is rebuilt from scratch on every request
 * and stores nothing. That is what lets the panel's toggles mean "what the
 * model sees" rather than "what this plugin last remembered" — a resumed
 * session, a compaction run by another plugin, or a fold applied by the agent
 * all show up identically, because they are all just log events.
 *
 * Shape:
 *
 * ```text
 * session
 * ├─ preface        (system prompt node, surface node 0)
 * └─ turn 3
 *    └─ step 3.1
 *       ├─ user        seq 12   [live]
 *       ├─ assistant   seq 13   [live]   — carries the tool-call blocks
 *       └─ tool: bash  seq 14   [live]
 *          └─ subagent session …          (linked child session, same shape)
 * ```
 *
 * @module dsh-context-assembler/host/tree
 */

import type {
  AssembleMode,
  ContextNodeKind,
  ContextNodeView,
  ContextOperationView,
  ContextPreset,
  ContextStats,
} from '../shared/types.ts'
import {
  estimateTokens,
  foldSurface,
  isSurfaceEventType,
  messageText,
  messageToolCalls,
  projectEvent,
  toolResultCallId,
  type LogEvent,
} from './surface.ts'

/** Source plugin id stamped on every replacement this plugin appends. */
export const PLUGIN_ID = '@dsh-external/dsh-client-plugin-context-assembler'

/** Readable header the model sees above a folded body. */
export function digestHeader(mode: 'key' | 'off', items: number, tokens: number): string {
  const mode_ = mode === 'off' ? 'off' : 'key'
  return '⟨assembled:' + mode_ + ' items=' + items + ' tokens≈' + tokens + '⟩'
}

/**
 * Which assemble mode a replacement node encodes, or null when it is not ours.
 *
 * Two carriers are checked because the two replacement shapes differ (see
 * {@link isOwnReplacement}): the `user/message` fold records the mode in
 * `source.summary`, while the `tool/result` fold can only record it in the body
 * text, where {@link digestHeader} already writes it. Both are plain log data,
 * so the mode survives a restart as long as the harness persists the event —
 * which it does.
 * @param event - the replacement event to read.
 * @returns the mode, or null when another producer made this node.
 */
export function modeOfReplacement(event: LogEvent): 'key' | 'off' | 'full' | null {
  const source = (event.data as { source?: Record<string, unknown> }).source
  if (source !== undefined && source['plugin'] === PLUGIN_ID) {
    const summary = source['summary']
    if (typeof summary === 'string') {
      const match = /assembled:(key|off|full)/.exec(summary)
      if (match !== null) return match[1] as 'key' | 'off' | 'full'
    }
  }
  if (event.type === 'tool/result') {
    const match = /assembled:(key|off|full)/.exec(messageText(projectEvent(event)))
    if (match !== null) return match[1] as 'key' | 'off' | 'full'
  }
  return null
}

/**
 * Whether this plugin produced the replacement node at that event.
 *
 * Two replacement shapes exist and they carry provenance differently. A
 * multi-node fold is a `user/message` and can stamp `source.plugin`. A fold of a
 * SINGLE tool result must stay a `tool/result` — the harness refuses any other
 * shape there, because the node has to keep answering its assistant tool call —
 * and that same guard forces every field except the result body to be byte
 * identical to the original, `source` included. So the tool-result shape is
 * recognised by the marker this plugin writes INTO the body instead.
 *
 * Getting this wrong is not cosmetic: the panel's fold count, the mode it shows
 * on a reopened session, and the operations list all read through here, so a
 * missed tool-result fold looks exactly like "my assembly was thrown away".
 * @param event - the event to test.
 * @returns the mode this plugin folded the region into, or null.
 */
export function isOwnReplacement(event: LogEvent): boolean {
  return modeOfReplacement(event) !== null
}

/** Everything one tree read needs. */
export interface TreeInput {
  sessionId: string
  title: string
  cwd?: string
  events: readonly LogEvent[]
  /** Linked child sessions keyed by child session id. */
  childSessions?: ReadonlyMap<string, TreeInput>
  /** Preset rules stored for the root session. */
  presets?: readonly ContextPreset[]
  /** Nesting depth of this session below the root read (0 = root). */
  depth?: number
}

/** A tree read: rows, accounting, and the assembly operations already logged. */
export interface TreeResult {
  nodes: ContextNodeView[]
  stats: ContextStats
  operations: ContextOperationView[]
}

/** Turn/step position inferred for one event. */
interface Position {
  turn?: number
  step?: number
}

/** One row plus the grouping keys it sorts under. */
interface Row {
  node: ContextNodeView
  turn?: number
  step?: number
  order: number
}

/**
 * Build the context tree for one session.
 * @param input - the session's log, identity, presets, and linked children.
 * @returns the rows the panel renders plus token accounting.
 */
export function buildContextTree(input: TreeInput): TreeResult {
  const events = input.events
  const bySeq = new Map<number, LogEvent>()
  for (const event of events) bySeq.set(event.seq, event)

  const positions = inferPositions(events)
  const fold = foldSurface(events)
  const toolNames = toolNamesByCallId(events)
  const presets = input.presets ?? []
  const depth = input.depth ?? 0
  const onSurface = new Set(fold.nodes)

  const originalSeqs: number[] = []
  for (const event of events) {
    if (isSurfaceEventType(event.type) && event.surfaceOp === 'append') originalSeqs.push(event.seq)
  }

  const rows: Row[] = []
  let counter = 0

  /**
   * Where a surface node SITS, which is not always where its event was written.
   *
   * A replacement node takes the surface position of the region it shadowed, so
   * grouping it by its own log position is wrong in a way that is very visible:
   * a digest written in turn 4 that swallowed turn-1 history would be grouped
   * under turn 4, splitting the surface into t4, t1, t5, t4, t5 — the older
   * context scatters into the wrong turns and the tree stops being a history at
   * all. Following the first shadowed node (recursively, so nested folds work)
   * puts the digest back where its content belongs.
   */
  const positionCache = new Map<number, Position>()
  const effectivePosition = (seq: number): Position => {
    const cached = positionCache.get(seq)
    if (cached !== undefined) return cached
    const event = bySeq.get(seq)
    const replacement = event !== undefined && event.surfaceOp !== undefined && event.surfaceOp !== 'append'
    let result: Position
    if (replacement) {
      const first = (fold.shadowed.get(seq) ?? [])[0]
      result = first === undefined ? positions.get(seq) ?? {} : effectivePosition(first)
    } else {
      result = positions.get(seq) ?? {}
    }
    positionCache.set(seq, result)
    return result
  }

  const rowFor = (seq: number, isShadowed: boolean): ContextNodeView => {
    const event = bySeq.get(seq)
    const position = effectivePosition(seq)
    const childSeqs = fold.shadowed.get(seq) ?? []
    const children = childSeqs.map((childSeq) => rowFor(childSeq, true))
    const replacement = event !== undefined && event.surfaceOp !== undefined && event.surfaceOp !== 'append'
    const own = event !== undefined && isOwnReplacement(event)
    const base = event === undefined
      ? {
          id: 's' + seq,
          kind: 'other' as ContextNodeKind,
          label: '未知事件 · seq ' + seq,
          fromSeq: seq,
          toSeq: seq,
          turn: position.turn,
          step: position.step,
        }
      : baseNodeFor(event, toolNames, position)
    const text = event === undefined ? '' : messageText(projectEvent(event))
    const node: ContextNodeView = {
      ...base,
      surfaceSeq: isShadowed ? null : seq,
      state: isShadowed ? 'shadowed' : replacement ? 'digest' : 'live',
      mode: replacement ? (modeOfReplacement(event!) ?? 'key') : 'full',
      tokens: estimateTokens(text),
      chars: text.length,
      preview: text.slice(0, 400),
      selectable: true,
      shadowedSeqs: childSeqs.length > 0 ? childSeqs : undefined,
      children: children.length > 0 ? children : undefined,
      depth,
    }
    if (isShadowed) {
      node.selectable = false
      node.mode = 'full'
      node.protectedReason = '已被折叠节点覆盖，请直接切换该折叠节点'
    }
    if (replacement) {
      node.label = own
        ? '组装区 · ' + (node.mode === 'off' ? '已移出' : '关键部分') + ' · ' + childSeqs.length + ' 项'
        : '压缩区 · ' + childSeqs.length + ' 项'
      node.selectable = children.length > 0
      if (children.length === 0) node.protectedReason = '该替换节点没有本插件可识别的来源'
    }
    if (fold.nodes[0] === seq) {
      node.selectable = false
      node.protectedReason = '系统提示词占据表层第 0 号节点，harness 拒绝覆盖它的替换'
    }
    return node
  }

  for (const seq of fold.nodes) {
    const node = rowFor(seq, false)
    const position = effectivePosition(seq)
    rows.push({ node, turn: position.turn, step: position.step, order: counter++ })
  }

  // Log-only rows worth showing: a failed attempt carries no tokens and cannot
  // be toggled, but it explains why a step produced no assistant message.
  //
  // They have no surface position, so they are slotted in right after the last
  // surface row whose event precedes them; assigning them the next counter value
  // would pile every attempt at the bottom of the panel, far from the step they
  // belong to.
  const orderAfter = (seq: number): number => {
    let order = 0
    for (const row of rows) {
      const rowSeq = row.node.surfaceSeq
      if (rowSeq !== null && rowSeq <= seq) order = row.order + 1
    }
    return order - 0.5
  }
  const attemptRows: Row[] = []
  for (const event of events) {
    if (event.type !== 'assistant/attempt') continue
    const position = positions.get(event.seq) ?? {}
    attemptRows.push({
      node: {
        id: 'a' + event.seq,
        kind: 'attempt',
        label: '失败/未落地的模型尝试 · seq ' + event.seq,
        surfaceSeq: null,
        fromSeq: event.seq,
        toSeq: event.seq,
        state: 'shadowed',
        mode: 'off',
        tokens: 0,
        chars: 0,
        preview: '',
        turn: position.turn,
        step: position.step,
        selectable: false,
        protectedReason: '该事件仅写入日志，不产生模型消息',
        depth,
      },
      turn: position.turn,
      step: position.step,
      order: orderAfter(event.seq),
    })
  }

  const allRows = rows.concat(attemptRows).sort((a, b) => a.order - b.order)
  const nodes = groupRows(allRows, depth)
  aggregate(nodes)

  const visibleTokens = rows.reduce((sum, row) => sum + row.node.tokens, 0)
  let shadowedTokens = 0
  for (const seq of originalSeqs) {
    if (onSurface.has(seq)) continue
    const event = bySeq.get(seq)
    if (event === undefined) continue
    shadowedTokens += estimateTokens(messageText(projectEvent(event)))
  }

  const operations: ContextOperationView[] = []
  for (const event of events) {
    if (!isOwnReplacement(event)) continue
    const op = event.surfaceOp
    if (op === undefined || op === 'append') continue
    const mode = modeOfReplacement(event) ?? 'key'
    const text = messageText(projectEvent(event))
    operations.push({
      seq: event.seq,
      time: event.time,
      startSeq: op.startSeq,
      endSeq: op.endSeq,
      mode: mode === 'off' ? 'off' : 'key',
      label: mode === 'off' ? '移出上下文' : mode === 'full' ? '展开还原' : '只保留关键部分',
      chars: text.length,
    })
  }

  const digestRows = rows.filter((row) => row.node.state === 'digest')
  const stats: ContextStats = {
    visibleTokens,
    shadowedTokens,
    rawTokens: visibleTokens + shadowedTokens,
    visibleMessages: rows.filter((row) => row.node.tokens > 0).length,
    surfaceNodes: fold.nodes.length,
    foldedRegions: digestRows.filter((row) => {
      const event = bySeq.get(row.node.surfaceSeq ?? -1)
      return event !== undefined && isOwnReplacement(event)
    }).length,
    compactedRegions: digestRows.filter((row) => {
      const event = bySeq.get(row.node.surfaceSeq ?? -1)
      return event !== undefined && !isOwnReplacement(event)
    }).length,
  }

  return { nodes, stats, operations }
}

/** One turn or step container row. */
function containerRow(id: string, kind: 'turn' | 'step', label: string, row: Row, depth: number): ContextNodeView {
  return {
    id,
    kind,
    label,
    surfaceSeq: null,
    fromSeq: row.node.fromSeq,
    toSeq: row.node.toSeq,
    state: 'live',
    mode: 'full',
    tokens: 0,
    chars: 0,
    preview: '',
    turn: row.turn,
    step: kind === 'step' ? row.step : undefined,
    selectable: false,
    children: [],
    depth,
  }
}

/**
 * Group rows into turn and step containers, preserving surface order exactly.
 *
 * Grouping is over CONSECUTIVE rows only. A key-based regroup would read more
 * naturally but would reorder the display whenever a boundary event lands
 * between two messages of the same step — the system prompt is emitted inside
 * the step while the user message that precedes it is not, so the two would
 * swap places. Order is the one property the tree must never lose: the user is
 * deciding what the model reads, in the order it reads it.
 */
function groupRows(rows: readonly Row[], depth: number): ContextNodeView[] {
  const out: ContextNodeView[] = []
  let turnNode: ContextNodeView | null = null
  let turnKey: number | undefined
  let stepNode: ContextNodeView | null = null
  let stepKey: number | undefined
  for (const row of rows) {
    if (row.turn === undefined) {
      out.push(row.node)
      turnNode = null
      turnKey = undefined
      stepNode = null
      stepKey = undefined
      continue
    }
    if (turnNode === null || turnKey !== row.turn) {
      turnNode = containerRow('t' + row.turn, 'turn', '第 ' + row.turn + ' 轮', row, depth)
      out.push(turnNode)
      turnKey = row.turn
      stepNode = null
      stepKey = undefined
    }
    if (row.step === undefined) {
      stepNode = null
      stepKey = undefined
      turnNode.children!.push(row.node)
      continue
    }
    if (stepNode === null || stepKey !== row.step) {
      // The first row's id keeps a reopened step's container id unique.
      stepNode = containerRow('s' + row.turn + '.' + row.step + '-' + row.node.id, 'step', '步骤 ' + row.turn + '.' + row.step, row, depth)
      turnNode.children!.push(stepNode)
      stepKey = row.step
    }
    stepNode.children!.push(row.node)
  }
  return out
}

/**
 * Propagate child totals and ranges onto container rows.
 *
 * A digest row keeps its own state, mode, AND cost: it is a real surface node
 * that happens to hold children (the events it replaced), so letting the
 * children's totals overwrite it would price a fold at the size of everything
 * it removed — the reported saving would be exactly zero. The children still
 * aggregate their own seq ranges, which is what the row's coverage shows.
 */
function aggregate(nodes: ContextNodeView[]): void {
  for (const node of nodes) {
    if (node.children === undefined || node.children.length === 0) continue
    aggregate(node.children)
    node.fromSeq = node.children.reduce<number | null>(
      (min, child) => child.fromSeq === null ? min : min === null ? child.fromSeq : Math.min(min, child.fromSeq), null)
    node.toSeq = node.children.reduce<number | null>(
      (max, child) => child.toSeq === null ? max : max === null ? child.toSeq : Math.max(max, child.toSeq), null)
    node.hint = gist(node, false) ?? gist(node, true)
    if (node.state === 'digest') continue
    node.tokens = node.children.reduce((sum, child) => sum + child.tokens, 0)
    node.chars = node.children.reduce((sum, child) => sum + child.chars, 0)
    const states = new Set(node.children.map((child) => child.state))
    node.state = states.size === 1 ? node.children[0]!.state : 'live'
  }
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
  return /^<[A-Za-z_][A-Za-z0-9_-]*[ >]/.test(line)
}

/**
 * Collapse one text block down to a single readable line.
 * @param text - the model-facing text.
 * @returns the first line that is not blank and not a tool-call marker.
 */
function firstLine(text: string): string | undefined {
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+/g, ' ').trim()
    if (line === '' || isToolCallMarker(line)) continue
    return line.length > 72 ? line.slice(0, 72) + '…' : line
  }
  return undefined
}

/**
 * The one-line gist of a subtree, in row order.
 *
 * A collapsed container otherwise shows nothing but "步骤 2.7", which tells the
 * user nothing about what the step was for; the panel needs the first thing
 * that was actually said or run inside it. System nodes are skipped on the
 * first pass because the rendered system prompt is the same 1.2k-token text in
 * every session and would label almost every step identically; they are only
 * used as a fallback when a region contains nothing else.
 * @param node - the container or digest row to summarize.
 * @param allowSystem - whether system nodes may supply the text.
 * @returns the first non-empty line, or undefined when the subtree has no text.
 */
function gist(node: ContextNodeView, allowSystem: boolean): string | undefined {
  if (node.state === 'digest') {
    const own = firstLine(node.preview)
    if (own !== undefined) return own
  }
  const children = node.children ?? []
  if (children.length === 0) {
    if (!allowSystem && node.kind === 'system') return undefined
    const line = firstLine(node.preview)
    if (line === undefined) return undefined
    // Name the tool, because the same step otherwise reads as a bare line of
    // program output with nothing saying what produced it.
    if (node.kind === 'tool' && node.toolName !== undefined && !line.startsWith(node.toolName)) {
      return '工具 ' + node.toolName + ' · ' + line
    }
    return line
  }
  for (const child of children) {
    if (!allowSystem && child.kind === 'system') continue
    const found = gist(child, allowSystem)
    if (found !== undefined) return found
  }
  return undefined
}

/** The kind/label/role triple for one surface event. */
function baseNodeFor(
  event: LogEvent,
  toolNames: Map<string, string>,
  position: Position,
): Pick<ContextNodeView, 'id' | 'kind' | 'label' | 'fromSeq' | 'toSeq' | 'turn' | 'step' | 'role' | 'toolName' | 'toolCallId' | 'isError'> {
  const message = projectEvent(event)
  const common = {
    id: 's' + event.seq,
    fromSeq: event.seq,
    toSeq: event.seq,
    turn: position.turn,
    step: position.step,
  }
  switch (event.type) {
    case 'system/message':
      return { ...common, kind: 'system', label: '系统提示词 · seq ' + event.seq, role: 'system' }
    case 'user/message': {
      const source = (message?.source ?? {}) as Record<string, unknown>
      const kind = source['kind']
      const tag = kind === 'user'
        ? '用户消息'
        : kind === 'tool'
          ? '工具结果'
          : '注入上下文 · ' + String(source['plugin'] ?? kind ?? 'plugin')
      return { ...common, kind: 'user', label: tag + ' · seq ' + event.seq, role: 'user' }
    }
    case 'assistant/message': {
      const calls = messageToolCalls(message)
      const label = calls.length === 0
        ? '助手消息 · seq ' + event.seq
        : '助手消息 · ' + calls.length + ' 次工具调用 (' + calls.map((call) => call.name).join(', ') + ') · seq ' + event.seq
      return { ...common, kind: 'assistant', label, role: 'assistant' }
    }
    case 'tool/result': {
      const callId = toolResultCallId(message)
      const name = callId !== null ? toolNames.get(callId) : undefined
      const block = message?.content[0]
      const isError = block?.['isError'] === true
      return {
        ...common,
        kind: 'tool',
        label: '工具 · ' + (name ?? callId ?? 'unknown') + (isError ? ' · 失败' : '') + ' · seq ' + event.seq,
        role: 'user',
        toolName: name ?? callId ?? undefined,
        toolCallId: callId ?? undefined,
        isError,
      }
    }
    default:
      return { ...common, kind: 'other', label: event.type + ' · seq ' + event.seq }
  }
}

/** Map every tool-call id to the tool name that issued it. */
function toolNamesByCallId(events: readonly LogEvent[]): Map<string, string> {
  const names = new Map<string, string>()
  for (const event of events) {
    if (event.type !== 'tool/call') continue
    const callId = event.data['callId']
    const name = event.data['name']
    if (typeof callId === 'string' && typeof name === 'string') names.set(callId, name)
  }
  return names
}

/** Infer turn/step for every event from the boundary events around it. */
function inferPositions(events: readonly LogEvent[]): Map<number, Position> {
  const positions = new Map<number, Position>()
  let turn: number | undefined
  let step: number | undefined
  for (const event of events) {
    if (event.type === 'turn/start') {
      const value = event.data['turn']
      if (typeof value === 'number') turn = value
      step = undefined
    } else if (event.type === 'turn/end') {
      positions.set(event.seq, { turn, step })
      turn = undefined
      step = undefined
      continue
    } else if (event.type === 'step/start') {
      const value = event.data['step']
      if (typeof value === 'number') step = value
      const turnValue = event.data['turn']
      if (typeof turnValue === 'number') turn = turnValue
    }
    const explicitTurn = event.data['turn']
    const explicitStep = event.data['step']
    positions.set(event.seq, {
      turn: typeof explicitTurn === 'number' ? explicitTurn : turn,
      step: typeof explicitStep === 'number' ? explicitStep : step,
    })
  }
  return positions
}

/** Modes a preset rule may pin on a node. */
export type PresetMode = Exclude<AssembleMode, 'full'>

/** Evaluate preset rules against one row; first match wins. */
export function matchPreset(node: ContextNodeView, presets: readonly ContextPreset[]): ContextPreset | null {
  for (const preset of presets) {
    if (!preset.enabled) continue
    const match = preset.match
    if (match.kind !== undefined && match.kind !== node.kind) continue
    if (match.toolName !== undefined && match.toolName !== node.toolName) continue
    if (match.isError !== undefined && match.isError !== Boolean(node.isError)) continue
    if (match.labelPattern !== undefined) {
      let re: RegExp
      try {
        re = new RegExp(match.labelPattern)
      } catch {
        continue
      }
      if (!re.test(node.label)) continue
    }
    return preset
  }
  return null
}
