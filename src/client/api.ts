/**
 * Browser-side client for the host half.
 *
 * The API lives at one of two origins depending on which carrier the host half
 * found: the GUI origin when the profile mounts the harness web server, or the
 * plugin private loopback port when it does not. The first probe decides, and
 * the choice is cached for the rest of the page life.
 *
 * @module dsh-context-assembler/client/api
 */

import type {
  ContextMessageView,
  ContextPlanOp,
  ContextPlanRequest,
  ContextPlanResponse,
  ContextPreset,
  ContextResult,
  ContextSessionView,
  ContextTreeResponse,
} from '../shared/types'

const API_PREFIX = '/api/context-assembler'
const FALLBACK_PORT = 4799
const FALLBACK_ATTEMPTS = 8

let resolvedBase: string | null = null

/** Snapshot of what /sessions returns. */
export interface SessionsPayload {
  sessions: ContextSessionView[]
  defaultSessionId: string | null
  config: { port: number; dataDir: string; exposeTool: boolean }
}

/** Resolve the API base once, preferring the same origin. */
async function base(): Promise<string> {
  if (resolvedBase !== null) return resolvedBase
  // Same origin first (the harness web server carrier), then the private
  // carrier's port range. The range must match the host half's, because the
  // port it lands on depends on what was still bound when this page loaded.
  const candidates = [API_PREFIX]
  for (let offset = 0; offset < FALLBACK_ATTEMPTS; offset += 1) {
    candidates.push('http://127.0.0.1:' + String(FALLBACK_PORT + offset) + API_PREFIX)
  }
  for (const candidate of candidates) {
    try {
      const response = await fetch(candidate + '/templates', { method: 'GET' })
      if (!response.ok) continue
      const body = (await response.json()) as { ok?: boolean }
      if (body.ok === true) {
        resolvedBase = candidate
        return candidate
      }
    } catch {
      // try the next carrier
    }
  }
  throw new Error(
    '无法连接 context-assembler 宿主接口：同源路由与 127.0.0.1:' + String(FALLBACK_PORT) + '–' + String(FALLBACK_PORT + FALLBACK_ATTEMPTS - 1) + ' 都没有响应。'
    + '这通常意味着宿主半边没有加载（检查 profile 里是否还有 ui-context-assembler 这一行）。',
  )
}

/** One typed call against the host API. */
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const root = await base()
  const response = await fetch(root + path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  })
  const text = await response.text()
  let body: unknown = {}
  try {
    body = text.trim() === "" ? {} : JSON.parse(text)
  } catch {
    body = { ok: false, error: text.slice(0, 400) }
  }
  const envelope = body as ContextResult<T>
  if (envelope.ok !== true) {
    const message = typeof (envelope as { error?: string }).error === 'string'
      ? (envelope as { error: string }).error
      : 'HTTP ' + response.status
    throw new Error(message)
  }
  return envelope.value
}

/** The plugin API, as the panel uses it. */
export const api = {
  sessions: () => request<SessionsPayload>('/sessions'),
  tree: (sessionId: string) =>
    request<ContextTreeResponse>('/tree?sessionId=' + encodeURIComponent(sessionId)),
  messages: (sessionId: string) =>
    request<ContextMessageView[]>('/messages?sessionId=' + encodeURIComponent(sessionId)),
  templates: () => request<ContextPreset[]>('/templates'),
  saveDraft: (sessionId: string, ops: ContextPlanOp[]) =>
    request<ContextPlanOp[]>('/draft', {
      method: 'PUT',
      body: JSON.stringify({ sessionId, ops }),
    }),
  plan: (request_: ContextPlanRequest, dryRun: boolean) =>
    request<ContextPlanResponse>('/plan', {
      method: 'POST',
      body: JSON.stringify({ ...request_, dryRun }),
    }),
  savePresets: (sessionId: string, presets: ContextPreset[]) =>
    request<ContextPreset[]>('/presets', {
      method: 'PUT',
      body: JSON.stringify({ sessionId, presets }),
    }),
}
