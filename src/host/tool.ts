/**
 * The model-facing half of assembled context: one tool the agent uses to
 * preside over its own context.
 *
 * The point of giving this to the model is the part of context management a
 * human cannot do while a long task runs: the agent knows a sub-task finished,
 * that an error was already ruled out, or that a listing it just read no longer
 * matters. That knowledge is what turns raw history into a digest, so the model
 * — not a heuristic — authors the summary and decides when the details may go.
 *
 * The definition is passed to ctx.tools.register as RAW JSON Schema, which is
 * exactly what the registry stores after compiling a schema spec. It is written
 * that way because this plugin cannot import @deepseek-ai/dsh-tools from a
 * linked package, and a hand-rolled spec compiler would be a second
 * implementation of a contract this plugin does not own.
 *
 * @module dsh-context-assembler/host/tool
 */

import type { ContextNodeView, ContextPlanOp, ContextPreset } from '../shared/types.ts'
import { flatten, type ContextAssembler, type SessionLike } from './service.ts'

/** The model-facing tool name. */
export const TOOL_NAME = 'context_assembler'

/** The calling agent, as the tool runtime hands it to execute(). */
export interface ToolExecLike {
  agent?: { session?: SessionLike }
  signal?: AbortSignal
}

/** The tool registry, narrowed to the one method used. */
export interface ToolRegistryLike {
  register(definition: Record<string, unknown>): () => void
}

/** One row of the compact tree the model reads back. */
interface ToolRow {
  id: string
  kind: string
  label: string
  seq: number
  mode: string
  tokens: number
}

/** The canonical value every call returns. */
interface ToolValue {
  action: string
  summary: string
  sessionId: string
  rows: ToolRow[]
  notes: string[]
  savedTokens: number
  visibleTokens: number
}

/** Parameter schema, written directly as JSON Schema. */
const PARAMETERS: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    action: {
      type: 'string',
      enum: ['tree', 'set', 'preset', 'messages'],
      description: 'tree reads the context tree with the surface seqs that set targets. set changes assemble modes. preset stores rule presets for this session. messages lists what the model currently receives.',
    },
    sessionId: {
      type: 'string',
      description: 'Target session id. Omit to act on the calling agent own session.',
    },
    ops: {
      type: 'array',
      description: 'Required for set: one entry per context row to change. Take surfaceSeq from a previous tree call.',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          surfaceSeq: { type: 'integer', description: 'The surfaceSeq of the row to change.' },
          mode: { type: 'string', enum: ['full', 'key', 'off'], description: 'full sends the recorded events verbatim and also opens a folded region again. key replaces the region with one digest message. off replaces it with a near-empty marker.' },
          digest: { type: 'string', description: 'Digest text used when mode is key. Write the summary yourself: what was learned, and what later steps still need. Omit to keep head and tail lines automatically.' },
        },
        required: ['surfaceSeq', 'mode'],
      },
    },
    applyPresets: {
      type: 'boolean',
      description: 'For set: run the stored preset rules first. Explicit ops win on conflict.',
    },
    dryRun: {
      type: 'boolean',
      description: 'For set: compute and report the change without writing anything to the session log.',
    },
    presets: {
      type: 'array',
      description: 'Required for preset: the COMPLETE rule list for this session; it replaces the stored list.',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', description: 'Stable rule id; reuse an existing id to edit that rule.' },
          name: { type: 'string', description: 'Human label shown in the panel.' },
          enabled: { type: 'boolean', description: 'Whether the rule participates.' },
          mode: { type: 'string', enum: ['key', 'off'], description: 'Assemble mode the rule pins on every match.' },
          template: { type: 'string', description: 'Optional digest text for key mode.' },
          auto: { type: 'boolean', description: 'Reserved for automatic application; the panel applies rules explicitly today.' },
          match: {
            type: 'object',
            additionalProperties: false,
            properties: {
              kind: { type: 'string', enum: ['system', 'user', 'assistant', 'tool', 'digest', 'attempt'], description: 'Row kind the rule matches.' },
              toolName: { type: 'string', description: 'Exact tool name the rule matches.' },
              isError: { type: 'boolean', description: 'Whether the row must be a failed tool call.' },
              labelPattern: { type: 'string', description: 'Regular expression matched against the row label.' },
            },
            required: [],
          },
        },
        required: ['name', 'enabled', 'mode', 'match'],
      },
    },
  },
  required: ['action'],
}

/** Output schema: the canonical value every call returns. */
const OUTPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    action: { type: 'string' },
    summary: { type: 'string' },
    sessionId: { type: 'string' },
    rows: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string' },
          kind: { type: 'string' },
          label: { type: 'string' },
          seq: { type: 'integer' },
          mode: { type: 'string' },
          tokens: { type: 'integer' },
        },
        required: ['id', 'kind', 'label', 'seq', 'mode', 'tokens'],
      },
    },
    notes: { type: 'array', items: { type: 'string' } },
    savedTokens: { type: 'integer' },
    visibleTokens: { type: 'integer' },
  },
  required: ['action', 'summary', 'sessionId', 'rows', 'notes', 'savedTokens', 'visibleTokens'],
}

/** The tool description the model reads. */
const DESCRIPTION = [
  'Assemble what this conversation sends to you. The session log keeps every recorded fact; the surface decides which of them you actually read.',
  'Call action=tree to see the context as a tree of rows. Each row carries a surfaceSeq, a kind, an estimated token cost, and its current mode:',
  'full sends the recorded events verbatim, key replaces a region with one digest message, off replaces it with a near-empty marker.',
  'Call action=set with ops to change modes. Prefer key over off: a digest you write keeps the conclusion while dropping the bulk.',
  'Fold a region as soon as its details stop mattering — a tool run whose output you have already absorbed, a sub-task that succeeded, or a failure you have already diagnosed.',
  'Never fold work the current step still depends on; a folded region is only cheap to reopen while it collapses to a single event, so fold whole tool-call groups rather than half of one.',
  'Call action=preset to store rules that the user can apply in the context panel, and action=messages to check what you currently receive.',
].join(' ')

/**
 * Register the context tool.
 * @param tools - the ctx.tools registry.
 * @param assembler - the context-assembly service.
 * @returns the disposer removing the tool.
 */
export function registerTool(tools: ToolRegistryLike, assembler: ContextAssembler): () => void {
  const definition: Record<string, unknown> = {
    name: TOOL_NAME,
    description: DESCRIPTION,
    parameters: PARAMETERS,
    output: {
      schema: OUTPUT_SCHEMA,
      render(_args: unknown, value: ToolValue) {
        const lines = [value.summary]
        if (value.notes.length > 0) lines.push(...value.notes.map((note) => '· ' + note))
        if (value.rows.length > 0) {
          lines.push('');
          for (const row of value.rows) {
            lines.push(row.id + '  [' + row.kind + ']  mode=' + row.mode + '  ~' + row.tokens + ' tokens  ' + row.label)
          }
        }
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args: unknown, exec: ToolExecLike): Promise<ToolValue> {
      return run(assembler, args as Record<string, unknown>, exec)
    },
  }
  return tools.register(definition)
}

/** Execute one call. */
async function run(assembler: ContextAssembler, args: Record<string, unknown>, exec: ToolExecLike): Promise<ToolValue> {
  const action = typeof args['action'] === 'string' ? (args['action'] as string) : 'tree'
  const explicit = typeof args['sessionId'] === 'string' ? (args['sessionId'] as string) : undefined
  const sessionId = explicit ?? exec.agent?.session?.id ?? (await assembler.defaultSessionId()) ?? undefined
  if (sessionId === undefined) throw new Error('context_assembler: no session to act on; pass sessionId explicitly')

  if (action === 'messages') {
    const messages = await assembler.messagesFor(sessionId)
    const tokens = messages.reduce((sum, message) => sum + message.tokens, 0)
    return {
      action, sessionId, rows: [], notes: [], savedTokens: 0, visibleTokens: tokens,
      summary: 'The model currently receives ' + messages.length + ' messages, about ' + tokens + ' tokens.',
    }
  }

  if (action === 'preset') {
    const presets = args['presets']
    if (!Array.isArray(presets)) throw new Error('context_assembler: action=preset requires the complete presets array')
    const stored = assembler.setPresets(sessionId, presets as ContextPreset[])
    return {
      action, sessionId, rows: [], notes: stored.map((preset) => preset.name + (preset.enabled ? ' (启用)' : ' (停用)')),
      savedTokens: 0,
      visibleTokens: 0,
      summary: 'Stored ' + stored.length + ' preset rules for this session. The user can apply them from the context panel.',
    }
  }

  if (action === 'set') {
    const rawOps = args['ops']
    if (!Array.isArray(rawOps)) throw new Error('context_assembler: action=set requires ops')
    const ops: ContextPlanOp[] = rawOps.map((entry) => {
      const op = entry as Record<string, unknown>
      const mode = op['mode']
      if (mode !== 'full' && mode !== 'key' && mode !== 'off') throw new Error('context_assembler: each op needs mode full, key, or off')
      const surfaceSeq = op['surfaceSeq']
      if (typeof surfaceSeq !== 'number') throw new Error('context_assembler: each op needs an integer surfaceSeq from a tree call')
      return {
        surfaceSeq,
        mode,
        digest: typeof op['digest'] === 'string' ? (op['digest'] as string) : undefined,
      } as ContextPlanOp
    })
    const dryRun = args['dryRun'] === true
    const applyPresets = args['applyPresets'] === true
    const result = await assembler.applyPlan({ sessionId, ops, applyPresets }, dryRun)
    const tree = await assembler.readTree(sessionId)
    const rows = compactRows(tree.nodes, 40)
    const verb = dryRun ? '预览' : '已写入日志';
    const summary = verb + '：' + result.ops.length + ' 个装配操作，' +
      (result.savedTokens >= 0 ? '节省约 ' + result.savedTokens : '增加约 ' + -result.savedTokens) + ' tokens；' +
      '当前可见约 ' + tree.stats.visibleTokens + ' tokens / ' + tree.stats.rawTokens + ' tokens。'
    return {
      action, sessionId, rows, notes: result.notes,
      savedTokens: result.savedTokens,
      visibleTokens: tree.stats.visibleTokens,
      summary,
    }
  }

  const tree = await assembler.readTree(sessionId)
  return {
    action: 'tree',
    sessionId,
    rows: compactRows(tree.nodes, 80),
    notes: tree.operations.slice(-5).map((operation) => '最近操作：' + operation.label + '（seq ' + operation.startSeq + '–' + operation.endSeq + '）'),
    savedTokens: 0,
    visibleTokens: tree.stats.visibleTokens,
    summary: '上下文共 ' + tree.stats.rawTokens + ' tokens；当前模型可见 ' + tree.stats.visibleTokens + ' tokens，已折叠 ' + tree.stats.shadowedTokens + ' tokens。' +
      '表层共 ' + tree.stats.surfaceNodes + ' 个节点，已装配 ' + tree.stats.foldedRegions + ' 个组装区。',
  }
}

/** One line for the model, bounded so a deep tree stays readable. */
function shorten(text: string): string {
  return text.length > 110 ? text.slice(0, 110) + '…' : text
}

/** Flatten a row tree into the compact rows the model reads. */
function compactRows(nodes: readonly ContextNodeView[], limit: number): ToolRow[] {
  const rows: ToolRow[] = []
  for (const node of flatten(nodes)) {
    if (rows.length >= limit) break
    rows.push({
      id: node.surfaceSeq === null ? node.id : 's' + node.surfaceSeq,
      kind: node.kind,
      label: shorten(node.hint === undefined ? node.label : node.label + ' — ' + node.hint),
      seq: node.surfaceSeq ?? -1,
      mode: node.selectable ? node.mode : node.mode + '(不可切换)',
      tokens: node.tokens,
    })
  }
  return rows
}
