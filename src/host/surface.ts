/**
 * Browser- and node-safe re-implementation of the two session-log folds this
 * plugin reasons about: the ordered model-visible **surface** and the per-node
 * **message projection**.
 *
 * The harness owns these rules (`@deepseek-ai/dsh-session`). This plugin
 * cannot import that package — external plugin host halves resolve only
 * cordis plus their own dependencies — so the folds are restated here against
 * plain JSON events. Both are total functions of the log, which is what makes
 * a context tree a *read* rather than plugin-owned state: nothing this plugin
 * remembers can drift from what `session.deriveMessages()` will send.
 *
 * Everything in this module is pure and synchronous; the unit tests drive it
 * with plain event arrays.
 *
 * @module dsh-context-assembler/host/surface
 */

/** The four event types that produce LLM messages and may carry a surface marker. */
export const SURFACE_EVENT_TYPES = ['system/message', 'user/message', 'assistant/message', 'tool/result'] as const

/** One of the message-producing event types. */
export type SurfaceEventType = (typeof SURFACE_EVENT_TYPES)[number]

/** The subset of a session event this plugin reads; every other field rides along untouched. */
export interface LogEvent {
  type: string
  seq: number
  time: number
  data: Record<string, unknown>
  surfaceOp?: 'append' | { op: 'replace'; startSeq: number; endSeq: number }
  sourceEventSeqs?: number[]
}

/** The literal text a message contributes to the request. */
export interface MessageLike {
  id?: string
  role: 'system' | 'user' | 'assistant'
  content: Array<Record<string, unknown>>
  source?: Record<string, unknown>
}

/** The ordered surface plus the provenance needed to unfold it again. */
export interface SurfaceFold {
  /** Surface node seqs in model order. */
  nodes: number[]
  /** For a replacement node, the surface seqs it shadowed (in order). */
  shadowed: Map<number, number[]>
  /** For a replacement node, the index in {@link nodes} it landed at. */
  landing: Map<number, number>
}

/** Whether an event type produces a model message. */
export function isSurfaceEventType(type: string): type is SurfaceEventType {
  return (SURFACE_EVENT_TYPES as readonly string[]).includes(type)
}

/**
 * Fold a log prefix into its ordered surface.
 *
 * `append` pushes the event's seq; `replace` splices out the inclusive range
 * `[startSeq, endSeq]` — resolved against the *current* surface order, exactly
 * as the harness does — and puts the replacing event's own seq in its place.
 * A malformed marker is skipped rather than thrown on: this is a read path, and
 * a session the harness itself rejected would never have reached the log.
 * @param events - the session's events in log order.
 * @returns the surface, its shadow map, and where each replacement landed.
 */
export function foldSurface(events: readonly LogEvent[]): SurfaceFold {
  const nodes: number[] = []
  const shadowed = new Map<number, number[]>()
  const landing = new Map<number, number>()
  for (const event of events) {
    if (!isSurfaceEventType(event.type) || event.surfaceOp === undefined) continue
    if (event.surfaceOp === 'append') {
      nodes.push(event.seq)
      continue
    }
    const { startSeq, endSeq } = event.surfaceOp
    const startIdx = nodes.indexOf(startSeq)
    const endIdx = nodes.indexOf(endSeq)
    if (startIdx < 0 || endIdx < 0 || startIdx > endIdx) continue
    shadowed.set(event.seq, nodes.slice(startIdx, endIdx + 1))
    nodes.splice(startIdx, endIdx - startIdx + 1, event.seq)
    landing.set(event.seq, startIdx)
  }
  return { nodes, shadowed, landing }
}

/**
 * Project one event into the message it derives to, or null when it produces none.
 *
 * Mirrors `deriveEventMessage`: an empty-content system or assistant node is
 * dormant (the harness uses that shape for "no system prompt" and for a
 * max-tokens step that only carries usage), while a user message and a tool
 * result always project.
 * @param event - the event to project.
 * @returns the message, or null when the event contributes no request content.
 */
export function projectEvent(event: LogEvent): MessageLike | null {
  switch (event.type) {
    case 'user/message':
      return event.data as unknown as MessageLike
    case 'system/message':
    case 'assistant/message': {
      const message = (event.data as { message?: MessageLike }).message
      if (message === undefined || !Array.isArray(message.content) || message.content.length === 0) return null
      return message
    }
    case 'tool/result': {
      const message = (event.data as { message?: MessageLike }).message
      return message ?? null
    }
    default:
      return null
  }
}

/** Flatten one content block to the text a request would carry. */
function blockText(block: Record<string, unknown>): string {
  const type = block['type']
  if (type === 'text' || type === 'reasoning') {
    const text = block['text']
    return typeof text === 'string' ? text : ''
  }
  if (type === 'tool-call') {
    const name = typeof block['name'] === 'string' ? block['name'] : 'tool'
    const args = typeof block['arguments'] === 'string' ? block['arguments'] : ''
    return `<${name} ${args}>`
  }
  if (type === 'tool-result') {
    const inner = Array.isArray(block['content']) ? (block['content'] as Record<string, unknown>[]) : []
    return inner.map(blockText).join('')
  }
  if (type === 'image') return '[image]'
  if (type === 'file') return '[file]'
  return ''
}

/** Concatenate every text-bearing block of one message. */
export function messageText(message: MessageLike | null): string {
  if (message === null) return ''
  return message.content.map(blockText).filter((part) => part !== '').join('\n')
}

/** Tool-call blocks of one message, in order. */
export function messageToolCalls(message: MessageLike | null): Array<{ id: string; name: string; arguments: string }> {
  if (message === null) return []
  const calls: Array<{ id: string; name: string; arguments: string }> = []
  for (const block of message.content) {
    if (block['type'] !== 'tool-call') continue
    calls.push({
      id: typeof block['id'] === 'string' ? block['id'] : '',
      name: typeof block['name'] === 'string' ? block['name'] : 'tool',
      arguments: typeof block['arguments'] === 'string' ? block['arguments'] : '',
    })
  }
  return calls
}

/** The tool-call id a tool result answers, when the block carries one. */
export function toolResultCallId(message: MessageLike | null): string | null {
  if (message === null) return null
  const block = message.content[0]
  if (block === undefined || block['type'] !== 'tool-result') return null
  const id = block['toolCallId']
  return typeof id === 'string' ? id : null
}

/**
 * Estimate the tokens one string costs.
 *
 * Deliberately a character-class heuristic rather than a tokenizer: the panel
 * only needs comparable magnitudes (to rank what is worth folding), and a real
 * tokenizer would be a large dependency resolved from a package this plugin is
 * not allowed to import. CJK codepoints cost ~1 token each; ASCII runs ~1 per
 * four characters; everything else sits between.
 * @param text - the model-facing text.
 * @returns an estimated token count.
 */
export function estimateTokens(text: string): number {
  if (text === '') return 0
  let cjk = 0
  let ascii = 0
  let other = 0
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0
    if (code < 0x80) ascii += 1
    else if (code >= 0x2e80 && code <= 0x9fff) cjk += 1
    else if (code >= 0xf900 && code <= 0xfaff) cjk += 1
    else if (code >= 0xff00 && code <= 0xffef) cjk += 1
    else other += 1
  }
  return Math.max(1, Math.ceil(cjk * 1.0 + ascii / 4 + other / 2))
}

/** Message source kinds that mark a node as produced by this plugin. */
export const PLUGIN_SOURCE_KIND = 'plugin'
