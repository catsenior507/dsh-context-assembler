/**
 * Compile "which parts should the model read" into session-surface operations.
 *
 * The harness gives a producer exactly one structural move:
 * `{ op: 'replace', startSeq, endSeq }` replaces the inclusive range
 * `[startSeq, endSeq]` — resolved against the **current surface order** — with
 * the replacing event's own single message node. Every other surface node keeps
 * its position, which is what keeps the untouched prefix reusable by the
 * provider's KV cache.
 *
 * This module therefore does three things and nothing else:
 *
 * 1. **Group** the requested modes into maximal contiguous runs.
 * 2. **Repair** those runs so they never split a tool-call group (an assistant
 *    message carrying `tool-call` blocks must be shadowed together with every
 *    result answering it, or the provider sees an orphaned tool result) and
 *    never cover protected surface node 0.
 * 3. **Render** each run into the single message that replaces it — a digest
 *    for `key`, a near-empty marker for `off`, and a replay transcript when an
 *    earlier fold is opened again.
 *
 * The module is pure: it reads events and returns append instructions. The
 * session adapter is the only place that touches a live session.
 *
 * ### The structural limit this design accepts
 *
 * A replacement collapses N surface nodes into exactly **one** message, and an
 * `assistant/message` can never be a replacement node (it embeds its provider
 * stream and the harness forbids `sourceEventSeqs` on it). Re-expanding a fold
 * is therefore impossible in general: at most one recorded event can come back
 * in its original role shape. {@link renderUnfold} restores that one event
 * verbatim when it exists and otherwise replays the folded region as a single
 * delimited user message, which is lossless in text and explicit about the
 * role flattening.
 *
 * @module dsh-context-assembler/host/planner
 */

import type { AssembleMode, CompiledOp } from '../shared/types.ts'
import {
  estimateTokens,
  foldSurface,
  messageText,
  messageToolCalls,
  projectEvent,
  toolResultCallId,
  type LogEvent,
  type MessageLike,
} from './surface.ts'
import { PLUGIN_ID, digestHeader, modeOfReplacement } from './tree.ts'

/** Digest rendering knobs, mirrored from the plugin config. */
export interface DigestOptions {
  offMarker: string
  headLines: number
  tailLines: number
  maxChars: number
}

/** Defaults chosen so a folded tool result keeps its verdict, its head, and its tail. */
export const DEFAULT_DIGEST_OPTIONS: DigestOptions = {
  offMarker: '({count} items, about {tokens} tokens omitted)',
  headLines: 12,
  tailLines: 4,
  maxChars: 6000,
}

/** One append the adapter should commit. */
export interface AppendInstruction {
  type: 'user/message' | 'tool/result'
  data: Record<string, unknown>
  sourceEventSeqs: number[]
  op: CompiledOp
}

/** The result of compiling a plan. */
export interface CompileResult {
  instructions: AppendInstruction[]
  notes: string[]
}

/** A run of surface indexes that share one target mode. */
interface Run {
  startIdx: number
  endIdx: number
  mode: Exclude<AssembleMode, 'full'>
  /** Explicit digest text supplied by the caller for this run. */
  digest?: string
  /** True when at least one node in the run actually changes mode. */
  changed: boolean
}

let idCounter = 0

/** Mint a log-safe message id for a synthesized node. */
function mintMessageId(): string {
  idCounter += 1
  return 'ca-' + Date.now().toString(36) + '-' + idCounter.toString(36) + '-' + Math.floor(Math.random() * 0xffff).toString(36)
}

/**
 * Compile a plan.
 * @param events - the session's events in log order.
 * @param ops - requested modes keyed by the surface seq they toggle.
 * @param options - digest rendering knobs.
 * @returns the appends to commit plus human-readable notes about repairs.
 */
export function compilePlan(
  events: readonly LogEvent[],
  ops: ReadonlyArray<{ surfaceSeq: number; mode: AssembleMode; digest?: string }>,
  options: DigestOptions = DEFAULT_DIGEST_OPTIONS,
): CompileResult {
  const bySeq = new Map<number, LogEvent>()
  for (const event of events) bySeq.set(event.seq, event)
  const fold = foldSurface(events)
  const notes: string[] = []
  if (ops.length === 0) return { instructions: [], notes }

  const indexOf = new Map<number, number>()
  fold.nodes.forEach((seq, index) => indexOf.set(seq, index))

  // Current mode per surface index: a live node is 'full'; a replacement node
  // encodes the mode it was folded with, so an untouched fold stays untouched.
  const current = new Map<number, AssembleMode>()
  const mode = new Map<number, AssembleMode>()
  const explicit = new Map<number, string | undefined>()
  fold.nodes.forEach((seq, index) => {
    const event = bySeq.get(seq)
    const replacement = event !== undefined && event.surfaceOp !== undefined && event.surfaceOp !== 'append'
    const value: AssembleMode = replacement ? modeOfReplacement(event!) ?? 'key' : 'full'
    current.set(index, value)
    mode.set(index, value)
  })

  let touched = 0
  for (const op of ops) {
    const index = indexOf.get(op.surfaceSeq)
    if (index === undefined) {
      notes.push('seq ' + op.surfaceSeq + ' 已不在当前表层上（可能已被其它折叠覆盖），已跳过')
      continue
    }
    if (mode.get(index) === op.mode && explicit.get(index) === op.digest) continue
    mode.set(index, op.mode)
    explicit.set(index, op.digest)
    touched += 1
  }
  if (touched === 0) return { instructions: [], notes }

  // Maximal contiguous runs of a non-'full' target mode.
  const runs: Run[] = []
  let cursor = 0
  while (cursor < fold.nodes.length) {
    const desired = mode.get(cursor) ?? 'full'
    if (desired === 'full') {
      cursor += 1
      continue
    }
    const startIdx = cursor
    let digest: string | undefined
    while (cursor < fold.nodes.length && (mode.get(cursor) ?? 'full') === desired) {
      if (explicit.get(cursor) !== undefined) digest = explicit.get(cursor)
      cursor += 1
    }
    const endIdx = cursor - 1
    let changed = false
    for (let at = startIdx; at <= endIdx; at += 1) {
      if ((mode.get(at) ?? 'full') !== (current.get(at) ?? 'full')) {
        changed = true
        break
      }
    }
    runs.push({ startIdx, endIdx, mode: desired, digest, changed })
  }

  const groups = toolCallGroups(fold.nodes, bySeq)
  repairRuns(runs, groups, fold.nodes, bySeq, notes)
  protectSystemHead(runs, fold.nodes, bySeq, notes)

  const instructions: AppendInstruction[] = []
  for (const run of runs) {
    if (run.startIdx > run.endIdx || !run.changed) continue
    const instruction = renderRun(run, fold, bySeq, options)
    if (instruction !== null) instructions.push(instruction)
  }

  // Unfold: a folded region whose target mode is 'full' again. Because 'full'
  // is never part of a run, these positions break run contiguity by construction.
  fold.nodes.forEach((seq, at) => {
    if ((current.get(at) ?? 'full') === 'full') return
    if ((mode.get(at) ?? 'full') !== 'full') return
    const instruction = renderUnfold(seq, fold, bySeq)
    if (instruction !== null) instructions.push(instruction)
    else notes.push('seq ' + seq + ' 无法展开：该替换节点没有本插件可识别的来源')
  })

  instructions.sort((a, b) => a.op.startSeq - b.op.startSeq)
  return { instructions, notes }
}

/**
 * Group every assistant message that requests tool calls with the results
 * answering them, so a fold can never orphan a tool result.
 * @param nodes - surface seqs in model order.
 * @param bySeq - log lookup.
 * @returns groups as inclusive index ranges; singletons are omitted.
 */
function toolCallGroups(nodes: readonly number[], bySeq: Map<number, LogEvent>): Array<[number, number]> {
  const groups: Array<[number, number]> = []
  const open: { calls: Set<string>; firstIdx: number; lastIdx: number } = {
    calls: new Set<string>(),
    firstIdx: -1,
    lastIdx: -1,
  }
  for (let index = 0; index < nodes.length; index += 1) {
    const event = bySeq.get(nodes[index]!)
    if (event === undefined) continue
    const message = projectEvent(event)
    if (event.type === 'assistant/message') {
      const calls = messageToolCalls(message)
      if (calls.length === 0) {
        if (open.firstIdx >= 0) open.lastIdx = index
        continue
      }
      if (open.firstIdx >= 0) groups.push([open.firstIdx, open.lastIdx])
      open.calls = new Set(calls.map((call) => call.id))
      open.firstIdx = index
      open.lastIdx = index
      continue
    }
    if (event.type === 'tool/result' && open.firstIdx >= 0) {
      const callId = toolResultCallId(message)
      if (callId !== null && open.calls.has(callId)) {
        open.calls.delete(callId)
        open.lastIdx = index
        if (open.calls.size === 0) {
          groups.push([open.firstIdx, open.lastIdx])
          open.firstIdx = -1
          open.lastIdx = -1
        }
      }
      continue
    }
    if (open.firstIdx >= 0) open.lastIdx = index
  }
  if (open.firstIdx >= 0) groups.push([open.firstIdx, open.lastIdx])
  return groups
}

/**
 * Widen runs so no tool-call group is split, then merge runs that collide.
 *
 * The invariant is about what survives, not about range arithmetic. A group is
 * assistant-tool-call plus every result answering it, and the provider rejects
 * two shapes: a visible tool call with no result, and a visible result with no
 * call. Folding the WHOLE group is always safe — both halves leave together.
 *
 * The one partial fold that is also safe is a lone tool result rendered as a
 * tool/result replacement ({@link renderRun}): the node stays a tool result, only
 * its body shrinks, so the correlation with the call survives. Every other
 * partial overlap would delete one half and orphan the other, and is widened.
 */
function repairRuns(
  runs: Run[],
  groups: ReadonlyArray<[number, number]>,
  nodes: readonly number[],
  bySeq: Map<number, LogEvent>,
  notes: string[],
): void {
  const isSoloToolResult = (run: Run): boolean => {
    if (run.startIdx !== run.endIdx) return false
    const event = bySeq.get(nodes[run.startIdx]!)
    return event !== undefined && event.type === 'tool/result'
  }
  for (let guard = 0; guard < 64; guard += 1) {
    let widened = false
    for (const run of runs) {
      for (const [first, last] of groups) {
        if (run.startIdx > last || run.endIdx < first) continue
        if (run.startIdx <= first && run.endIdx >= last) continue
        if (isSoloToolResult(run)) continue
        const newStart = Math.min(run.startIdx, first)
        const newEnd = Math.max(run.endIdx, last)
        run.startIdx = newStart
        run.endIdx = newEnd
        notes.push('为保持工具调用与结果成对，折叠范围已扩展到表层节点 seq ' + first + '–' + last)
        widened = true
      }
    }
    runs.sort((a, b) => a.startIdx - b.startIdx)
    let merged = false
    for (let i = 0; i + 1 < runs.length; i += 1) {
      const left = runs[i]!
      const right = runs[i + 1]!
      if (left.endIdx < right.startIdx) continue
      if (left.mode !== right.mode) notes.push('相邻折叠区间的模式冲突，已按较早区间的模式合并')
      left.endIdx = Math.max(left.endIdx, right.endIdx)
      if (left.digest === undefined) left.digest = right.digest
      left.changed = left.changed || right.changed
      runs.splice(i + 1, 1)
      i -= 1
      merged = true
    }
    if (!widened && !merged) break
  }
}

/** Shrink runs away from protected surface node 0. */
function protectSystemHead(runs: Run[], nodes: readonly number[], bySeq: Map<number, LogEvent>, notes: string[]): void {
  const headSeq = nodes[0]
  if (headSeq === undefined) return
  const head = bySeq.get(headSeq)
  if (head === undefined || head.type !== 'system/message') return
  for (const run of runs) {
    if (run.startIdx !== 0) continue
    run.startIdx = 1
    if (run.endIdx === 0) notes.push('系统提示词不可折叠，已跳过')
    else notes.push('系统提示词不可折叠，折叠范围已从表层节点 seq ' + nodes[1] + ' 开始')
  }
}

/** Render one fold run into the single message that replaces it. */
function renderRun(
  run: Run,
  fold: { nodes: number[]; shadowed: Map<number, number[]> },
  bySeq: Map<number, LogEvent>,
  options: DigestOptions,
): AppendInstruction | null {
  const seqs = fold.nodes.slice(run.startIdx, run.endIdx + 1)
  if (seqs.length === 0) return null
  const startSeq = seqs[0]!
  const endSeq = seqs[seqs.length - 1]!
  const previousTokens = seqs.reduce(
    (sum, seq) => sum + estimateTokens(messageText(projectEvent(bySeq.get(seq)!))), 0)
  const items = countOriginals(seqs, fold, bySeq)

  // A tool result folded on its own keeps its call correlation: replacing it
  // with a user message would orphan the assistant's matching tool call.
  if (seqs.length === 1) {
    const only = bySeq.get(seqs[0]!)
    if (only !== undefined && only.type === 'tool/result') {
      const body = run.digest !== undefined && run.digest !== ''
        ? run.digest
        : autoDigest([only], bySeq, options)
      const text = digestHeader(run.mode, items, previousTokens) + '\n' + body
      const data = only.data as { message: Record<string, unknown> & { content: Array<Record<string, unknown>> } }
      const block = data.message.content[0] ?? { type: 'tool-result' }
      return {
        type: 'tool/result',
        data: {
          ...(only.data as Record<string, unknown>),
          message: { ...data.message, content: [{ ...block, content: [{ type: 'text', text }] }] },
        },
        sourceEventSeqs: [seqs[0]!],
        op: {
          startSeq, endSeq, shadowedSeqs: seqs, mode: run.mode,
          event: 'tool/result', label: '工具结果 · 关键部分', text,
          tokens: estimateTokens(text), previousTokens,
        },
      }
    }
  }

  const body = run.mode === 'off'
    ? options.offMarker.replace('{count}', String(items)).replace('{tokens}', String(previousTokens))
    : run.digest !== undefined && run.digest !== ''
      ? run.digest
      : autoDigest(seqs.map((seq) => bySeq.get(seq)!).filter((event) => event !== undefined), bySeq, options)
  const raw = digestHeader(run.mode, items, previousTokens) + '\n' + body
  const text = raw.length > options.maxChars ? raw.slice(0, options.maxChars) + '\n…（已截断）' : raw
  // An explicitly empty off-marker asks for a genuinely free fold: the
  // replacement carries no content at all. The harness accepts an empty user
  // message and projects it to a message with no blocks, so the region costs
  // exactly zero tokens. It is opt-in because the model then sees a silent gap
  // where the default marker would have told it that something was elided.
  if (run.mode === 'off' && options.offMarker === '') {
    return {
      type: 'user/message',
      data: {
        id: (synthesizedUserMessage('off', items, previousTokens, '') as { id: string }).id,
        role: 'user',
        content: [],
        source: { kind: 'plugin', plugin: PLUGIN_ID, form: 'notice', summary: 'assembled:off items=' + items + ' tokens=' + previousTokens },
      },
      sourceEventSeqs: seqs,
      op: {
        startSeq, endSeq, shadowedSeqs: seqs, mode: run.mode,
        event: 'user/message', label: '移出上下文（零成本）',
        text: '', tokens: 0, previousTokens,
      },
    }
  }
  return {
    type: 'user/message',
    data: synthesizedUserMessage(run.mode, items, previousTokens, text),
    sourceEventSeqs: seqs,
    op: {
      startSeq, endSeq, shadowedSeqs: seqs, mode: run.mode,
      event: 'user/message', label: run.mode === 'off' ? '移出上下文' : '关键部分',
      text, tokens: estimateTokens(text), previousTokens,
    },
  }
}

/** Build the `user/message` payload this plugin appends as a replacement node. */
function synthesizedUserMessage(
  mode: 'key' | 'off' | 'full',
  items: number,
  tokens: number,
  text: string,
): Record<string, unknown> {
  return {
    id: mintMessageId(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: {
      kind: 'plugin',
      plugin: PLUGIN_ID,
      form: 'notice',
      summary: 'assembled:' + mode + ' items=' + items + ' tokens=' + tokens,
    },
  }
}

/** Count the recorded events a run ultimately covers, nested folds included. */
function countOriginals(seqs: readonly number[], fold: { shadowed: Map<number, number[]> }, bySeq: Map<number, LogEvent>): number {
  void bySeq
  let total = 0
  for (const seq of seqs) {
    const nested = fold.shadowed.get(seq)
    if (nested !== undefined && nested.length > 0) total += countOriginals(nested, fold, bySeq)
    else total += 1
  }
  return total
}

/** Open one folded region again. */
function renderUnfold(
  seq: number,
  fold: { nodes: number[]; shadowed: Map<number, number[]> },
  bySeq: Map<number, LogEvent>,
): AppendInstruction | null {
  const event = bySeq.get(seq)
  if (event === undefined) return null
  const shadowedSeqs = fold.shadowed.get(seq) ?? []
  if (shadowedSeqs.length === 0) return null
  const previousTokens = estimateTokens(messageText(projectEvent(event)))
  const restoredTokens = shadowedSeqs.reduce(
    (sum, shadowSeq) => {
      const original = bySeq.get(shadowSeq)
      return original === undefined ? sum : sum + estimateTokens(messageText(projectEvent(original)))
    }, 0)
  if (shadowedSeqs.length === 1) {
    const original = bySeq.get(shadowedSeqs[0]!)
    const restored = restoreVerbatim(event, original, previousTokens)
    if (restored !== null) return restored
  }
  return restoreTranscript(event, shadowedSeqs, bySeq, previousTokens, restoredTokens)
}

/**
 * Restore a fold that covered exactly one recorded event, in that event's own
 * role shape where the harness permits it.
 * @param digestEvent - the replacement node currently on the surface.
 * @param original - the recorded event being brought back.
 * @param previousTokens - what the digest costs today.
 * @returns the append, or null when the original's role shape cannot be re-emitted.
 */
function restoreVerbatim(
  digestEvent: LogEvent,
  original: LogEvent | undefined,
  previousTokens: number,
): AppendInstruction | null {
  if (original === undefined) return null
  if (original.type === 'tool/result' && digestEvent.type === 'tool/result') {
    const originalData = original.data as { message: Record<string, unknown> & { content: Array<Record<string, unknown>> } }
    const digestData = digestEvent.data as { message: Record<string, unknown> & { content: Array<Record<string, unknown>> } }
    const originalBlock = originalData.message.content[0]
    const digestBlock = digestData.message.content[0] ?? { type: 'tool-result' }
    const text = messageText(projectEvent(original))
    return {
      type: 'tool/result',
      data: {
        ...(digestEvent.data as Record<string, unknown>),
        message: { ...digestData.message, content: [{ ...digestBlock, content: originalBlock?.['content'] ?? [] }] },
      },
      sourceEventSeqs: [digestEvent.seq],
      op: {
        startSeq: digestEvent.seq, endSeq: digestEvent.seq, shadowedSeqs: [digestEvent.seq], mode: 'full',
        event: 'tool/result', label: '展开还原', text,
        tokens: estimateTokens(text), previousTokens,
      },
    }
  }
  if (original.type === 'user/message') {
    const message = original.data as unknown as Record<string, unknown>
    const text = messageText(projectEvent(original))
    return {
      type: 'user/message',
      data: { ...message, id: mintMessageId() },
      sourceEventSeqs: [digestEvent.seq],
      op: {
        startSeq: digestEvent.seq, endSeq: digestEvent.seq, shadowedSeqs: [digestEvent.seq], mode: 'full',
        event: 'user/message', label: '展开还原', text,
        tokens: estimateTokens(text), previousTokens,
      },
    }
  }
  if (original.type === 'assistant/message') {
    const message = projectEvent(original)
    const kept = (message?.content ?? []).filter((block) => block['type'] !== 'tool-call')
    const text = messageText(projectEvent(original))
    const content = [
      { type: 'text', text: '⟨assembled:full items=1⟩ 以下为展开还原的助手消息（seq ' + original.seq + '）；工具调用块无法在单条 user 消息中保留，已省略。' },
      ...kept,
    ]
    return {
      type: 'user/message',
      data: {
        id: mintMessageId(),
        role: 'user',
        content,
        source: { kind: 'plugin', plugin: PLUGIN_ID, form: 'notice', summary: 'assembled:full items=1' },
      },
      sourceEventSeqs: [digestEvent.seq],
      op: {
        startSeq: digestEvent.seq, endSeq: digestEvent.seq, shadowedSeqs: [digestEvent.seq], mode: 'full',
        event: 'user/message', label: '展开还原', text,
        tokens: estimateTokens(text), previousTokens,
      },
    }
  }
  return null
}

/** Replay a multi-node fold as one delimited transcript message. */
function restoreTranscript(
  digestEvent: LogEvent,
  shadowedSeqs: readonly number[],
  bySeq: Map<number, LogEvent>,
  previousTokens: number,
  restoredTokens: number,
): AppendInstruction {
  const lines: string[] = [
    '⟨assembled:full items=' + shadowedSeqs.length + '⟩ 以下为展开还原的原样重放，按日志顺序；各段保留其原始角色标注。',
  ]
  for (const seq of shadowedSeqs) {
    const event = bySeq.get(seq)
    if (event === undefined) continue
    lines.push('', '--- seq ' + seq + ' · ' + event.type + ' ---', messageText(projectEvent(event)))
  }
  const text = lines.join('\n')
  return {
    type: 'user/message',
    data: synthesizedUserMessage('full', shadowedSeqs.length, restoredTokens, text),
    sourceEventSeqs: [digestEvent.seq],
    op: {
      startSeq: digestEvent.seq, endSeq: digestEvent.seq, shadowedSeqs: [digestEvent.seq], mode: 'full',
      event: 'user/message', label: '展开还原（重放）', text,
      tokens: estimateTokens(text), previousTokens,
    },
  }
}

/**
 * Derive "the key parts" of a region without asking a model.
 *
 * The rule is deliberately mechanical: keep the verdict (which member, whether
 * it failed), the first lines that usually state what happened, and the last
 * lines that usually state the outcome. Everything between becomes a counted
 * ellipsis, so the model can see that something was elided and how much. An
 * agent that wants a semantic digest passes one explicitly through the tool.
 * @param events - the region's surface events in order.
 * @param bySeq - log lookup, kept for call-site symmetry.
 * @param options - head/tail line budgets and the character ceiling.
 * @returns the digest body.
 */
export function autoDigest(
  events: readonly LogEvent[],
  bySeq: Map<number, LogEvent>,
  options: DigestOptions = DEFAULT_DIGEST_OPTIONS,
): string {
  void bySeq
  const blocks: string[] = []
  for (const event of events) {
    const message: MessageLike | null = projectEvent(event)
    if (message === null) continue
    const text = messageText(message)
    if (text.trim() === '') continue
    const lines = text.split(/\r?\n/)
    if (lines.length <= options.headLines + options.tailLines + 1) {
      blocks.push('▸ ' + describe(event, message) + '\n' + text)
      continue
    }
    const head = lines.slice(0, options.headLines).join('\n')
    const tail = lines.slice(-options.tailLines).join('\n')
    const omitted = lines.length - options.headLines - options.tailLines
    blocks.push('▸ ' + describe(event, message) + '\n' + head + '\n…（省略 ' + omitted + ' 行）…\n' + tail)
  }
  const body = blocks.join('\n\n')
  if (body.length <= options.maxChars) return body
  return body.slice(0, options.maxChars) + '\n…（已截断）'
}

/** One-line description of a region member, used as a digest section header. */
function describe(event: LogEvent, message: MessageLike): string {
  if (event.type === 'assistant/message') {
    const calls = messageToolCalls(message)
    return 'assistant · seq ' + event.seq + (calls.length > 0 ? ' · 工具调用 ' + calls.map((call) => call.name).join(', ') : '')
  }
  if (event.type === 'tool/result') {
    const block = message.content[0]
    return 'tool-result · seq ' + event.seq + (block?.['isError'] === true ? ' · 失败' : '')
  }
  if (event.type === 'user/message') return 'user · seq ' + event.seq
  if (event.type === 'system/message') return 'system · seq ' + event.seq
  return event.type + ' · seq ' + event.seq
}
