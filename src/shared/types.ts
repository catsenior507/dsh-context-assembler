/**
 * Wire contract shared by the host half and the browser panel of
 * dsh-context-assembler (组装式上下文).
 *
 * The vocabulary is deliberately small: every model-visible fact is a
 * *context node*, and every node carries exactly one {@link AssembleMode}.
 * The host half compiles the modes into session-surface replacements, so the
 * panel never talks about provider messages — only about which parts of the
 * recorded work the model should read.
 *
 * @module dsh-context-assembler/shared/types
 */

/** How one region of recorded work enters the next model request. */
export type AssembleMode =
  /** Verbatim: the recorded events stay on the surface untouched. */
  | 'full'
  /** Key parts only: one digest message (agent- or host-authored) replaces the region. */
  | 'key'
  /** Omitted: one compact marker replaces the region, keeping its position and cost near zero. */
  | 'off'

/** What a context node stands for. */
export type ContextNodeKind =
  | 'session'
  | 'turn'
  | 'step'
  | 'system'
  | 'user'
  | 'assistant'
  | 'tool'
  | 'digest'
  | 'attempt'
  | 'other'

/** Surface lifecycle of the region a node describes. */
export type ContextNodeState =
  /** On the surface as its own recorded event. */
  | 'live'
  /** A replacement node produced by this plugin (a folded region). */
  | 'digest'
  /** Replaced by a digest or by compaction; still in the log, no longer sent. */
  | 'shadowed'

/** One row of the context tree. */
export interface ContextNodeView {
  /** Stable id: `s<seq>` for surface nodes, `g<from>-<to>` for pure group rows. */
  id: string
  kind: ContextNodeKind
  /** One-line label rendered by the panel. */
  label: string
  /** Surface node seq this row toggles, or null for group/preface rows. */
  surfaceSeq: number | null
  /** Inclusive first / last log seq the row covers. */
  fromSeq: number | null
  toSeq: number | null
  state: ContextNodeState
  mode: AssembleMode
  /** Estimated tokens the model currently spends on this row's own text. */
  tokens: number
  chars: number
  /** First ~400 characters of the model-facing text, for the panel preview. */
  preview: string
  /**
   * One-line gist of everything this row contains.
   *
   * Only containers and digests carry one: it is the first non-empty line of
   * the first non-system node inside the row, so a collapsed turn or step says
   * what it is about instead of only its ordinal ("步骤 2.7 · 检查 surface
   * 折叠在 replace 之后是否正确" rather than "步骤 2.7").
   */
  hint?: string
  role?: 'system' | 'user' | 'assistant'
  toolName?: string
  toolCallId?: string
  isError?: boolean
  turn?: number
  step?: number
  /** Log seqs this row's surface node shadows (only for `state === 'digest'`). */
  shadowedSeqs?: number[]
  /** False when the harness protects the region from replacement (the system head). */
  selectable: boolean
  /** Human-readable reason the row cannot be toggled. */
  protectedReason?: string
  /** True when toggling this row also moves its whole tool-call group. */
  atomicWith?: number[]
  /** Nested rows: turns contain steps, steps contain messages, tool calls contain subagent trees. */
  children?: ContextNodeView[]
  /** Depth of a linked subagent session (0 = this session). */
  depth?: number
}

/** Aggregate accounting for one tree read. */
export interface ContextStats {
  /** Estimated tokens the model would spend on the derived message history. */
  visibleTokens: number
  /** Estimated tokens of everything recorded but currently replaced. */
  shadowedTokens: number
  /** Estimated tokens before any assembly (surface fully expanded). */
  rawTokens: number
  /** Messages in the current derived history. */
  visibleMessages: number
  /** Surface nodes currently on the ordered surface. */
  surfaceNodes: number
  /** Regions this plugin folded. */
  foldedRegions: number
  /** Regions that legacy compaction folded. */
  compactedRegions: number
}

/** One session as the panel's picker sees it: live, or read back from storage. */
export interface ContextSessionView {
  id: string
  title: string
  cwd?: string
  parentSessionId?: string
  createdAt: number
  updatedAt: number
  events: number
  /** True when this session or one of its ancestors is the host's most recent activity. */
  recent: boolean
  /**
   * True when the row came from storage rather than the live store.
   *
   * The harness only loads a conversation once somebody opens it, so without
   * this half the picker would hide every past conversation until it is
   * reopened — which reads as "the panel cannot see my history".
   */
  cold?: boolean
  /** Physical size of the stored log, when this row came from storage. */
  sizeBytes?: number
  /** Why this stored row could not be read, when it could not. */
  readError?: string
}

/** A whole tree read. */
export interface ContextTreeResponse {
  ok: true
  sessionId: string
  title: string
  cwd?: string
  stats: ContextStats
  nodes: ContextNodeView[]
  /** Ordered log of assembly operations this plugin appended to the session. */
  operations: ContextOperationView[]
  /** Preset rules stored for this session. */
  presets: ContextPreset[]
  /** Unapplied plan saved for this session, so a reload or restart keeps it. */
  draft: ContextPlanOp[]
  /** True when the log was read from storage: viewable here, but not editable. */
  readOnly: boolean
  /** Server wall-clock at read time, for the panel's staleness hint. */
  at: number
}

/** One assembly operation already committed to the log. */
export interface ContextOperationView {
  seq: number
  time: number
  startSeq: number
  endSeq: number
  mode: Exclude<AssembleMode, 'full'>
  label: string
  chars: number
}

/** A declarative rule that presets the mode of nodes matching a selector. */
export interface ContextPreset {
  id: string
  /** Human label shown in the panel. */
  name: string
  enabled: boolean
  /** Selector fields; every present field must match. */
  match: {
    kind?: ContextNodeKind
    toolName?: string
    /** Regular expression source matched against the tool name / label. */
    labelPattern?: string
    isError?: boolean
    /** Only nodes older than this many turns count (0 = no bound). */
    olderThanTurns?: number
  }
  mode: Exclude<AssembleMode, 'full'>
  /** Digest template for `key`; supports {tool}, {status}, {turn}, {step}, {seqs}, {text}. */
  template?: string
  /** Apply automatically to newly seen nodes whose turn already closed. */
  auto?: boolean
}

/** One requested assemble-mode change. */
export interface ContextPlanOp {
  /** Surface seq of the row being toggled (`ContextNodeView.surfaceSeq`). */
  surfaceSeq: number
  mode: AssembleMode
  /** Explicit digest text for `key`; omitted means "derive key parts automatically". */
  digest?: string
}

/** Apply request. */
export interface ContextPlanRequest {
  sessionId: string
  ops: ContextPlanOp[]
  /** Apply every enabled preset before the explicit ops (ops win on conflict). */
  applyPresets?: boolean
}

/** One compiled surface operation, either committed or merely previewed. */
export interface CompiledOp {
  startSeq: number
  endSeq: number
  shadowedSeqs: number[]
  /** The mode the region is being moved to; 'full' means a fold is being opened again. */
  mode: AssembleMode
  event: 'user/message' | 'tool/result'
  label: string
  text: string
  tokens: number
  /** Tokens the region costs today. */
  previousTokens: number
}

/** Apply / preview response. */
export interface ContextPlanResponse {
  ok: true
  sessionId: string
  dryRun: boolean
  ops: CompiledOp[]
  /** Seqs of the events this call appended (empty on a dry run). */
  appendedSeqs: number[]
  savedTokens: number
  notes: string[]
  /** Derived history after the change (truncated previews). */
  messages: ContextMessageView[]
}

/** One derived message as the panel's "what the model sees" strip renders it. */
export interface ContextMessageView {
  index: number
  role: 'system' | 'user' | 'assistant'
  source: string
  chars: number
  tokens: number
  preview: string
}

/** Successful envelope for every read endpoint. */
export interface ContextOk<T> {
  ok: true
  value: T
}

/** Failure envelope; the panel surfaces `error` verbatim. */
export interface ContextFail {
  ok: false
  error: string
}

/** Union every endpoint returns. */
export type ContextResult<T> = ContextOk<T> | ContextFail

/** Host-half configuration (all keys optional). */
export interface ContextAssemblerConfig {
  /** TCP port for the plugin's own API server; used only when no webServer service exists. */
  port: number
  /** Directory for preset storage; defaults to `$DSH_HOME/context-assembler`. */
  dataDir?: string
  /** Text a replaced region collapses to in `off` mode; {count} and {tokens} interpolate. */
  offMarker: string
  /** Lines kept from the head of an auto-digested tool result. */
  digestHeadLines: number
  /** Lines kept from the tail of an auto-digested tool result. */
  digestTailLines: number
  /** Hard character budget for one auto-digest. */
  digestMaxChars: number
  /** Register the model-facing `context_assembler` tool. */
  exposeTool: boolean
}
