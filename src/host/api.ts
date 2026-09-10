/**
 * The plugin HTTP surface, shared by both carriers.
 *
 * Two transports mount the same handler table: the harness webServer service
 * when the profile has one (so the panel talks to its own origin and no extra
 * port exists), and a private loopback server otherwise (headless profiles and
 * the standalone integration tests have no web server at all).
 *
 * Every response is JSON with either { ok: true, value } or
 * { ok: false, error }, so the panel has exactly one failure shape to render.
 *
 * @module dsh-context-assembler/host/api
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { ContextPlanOp, ContextPlanRequest, ContextPreset } from '../shared/types.ts'
import { PRESET_TEMPLATES, type ContextAssembler, type ResolvedConfig } from './service.ts'

/** Path prefix used when the plugin rides the harness web server. */
export const API_PREFIX = '/api/context-assembler'

/** Everything the routes need. */
export interface ApiDeps {
  assembler: ContextAssembler
  config: ResolvedConfig
}

/** One resolved HTTP response. */
export interface ApiResponse {
  status: number
  body: unknown
}

/** The harness web-server service, narrowed to the one method used. */
export interface WebServerLike {
  register(route: {
    kind: 'exact' | 'prefix'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  }): () => void
}

/** Read a request body as text, bounded so a malformed peer stays harmless. */
export async function readBody(req: IncomingMessage, limit = 4 * 1024 * 1024): Promise<string> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    size += buffer.length
    if (size > limit) throw new Error('request body too large')
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** Parse a JSON body, treating an empty body as an empty object. */
export function parseJson(text: string): Record<string, unknown> {
  if (text.trim() === '') return {}
  const parsed = JSON.parse(text) as unknown
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('request body must be a JSON object')
  }
  return parsed as Record<string, unknown>
}

/**
 * Resolve one request.
 * @param deps - the assembler service and its resolved configuration.
 * @param method - HTTP method.
 * @param pathname - pathname relative to API_PREFIX, or absolute for the standalone server.
 * @param query - decoded query parameters.
 * @param body - already-parsed JSON body, when the request had one.
 * @returns the status and JSON body to send.
 */
export async function handle(deps: ApiDeps, method: string, pathname: string, query: URLSearchParams, body: Record<string, unknown>): Promise<ApiResponse> {
  const path = pathname.startsWith(API_PREFIX) ? pathname.slice(API_PREFIX.length) : pathname
  try {
    if (method === 'GET' && (path === '/sessions' || path === '/')) {
      return ok({
        sessions: await deps.assembler.listSessions(),
        defaultSessionId: await deps.assembler.defaultSessionId(),
        config: {
          port: deps.config.port,
          dataDir: deps.config.dataDir,
          exposeTool: deps.config.exposeTool,
        },
      })
    }
    if (method === 'GET' && path === '/templates') return ok(PRESET_TEMPLATES)
    if (method === 'GET' && path === '/tree') {
      const sessionId = query.get('sessionId') ?? (await deps.assembler.defaultSessionId())
      if (sessionId === null) return fail(400, 'no session is available')
      return ok(await deps.assembler.readTree(sessionId))
    }
    if (method === 'GET' && path === '/messages') {
      const sessionId = query.get('sessionId') ?? (await deps.assembler.defaultSessionId())
      if (sessionId === null) return fail(400, 'no session is available')
      return ok(await deps.assembler.messagesFor(sessionId))
    }
    if (method === 'GET' && path === '/presets') {
      const sessionId = query.get('sessionId')
      if (sessionId === null) return fail(400, 'sessionId is required')
      return ok(deps.assembler.presetsFor(sessionId))
    }
    if (method === 'PUT' && path === '/presets') {
      const sessionId = body['sessionId']
      if (typeof sessionId !== 'string') return fail(400, 'sessionId is required')
      const presets = body['presets']
      if (!Array.isArray(presets)) return fail(400, 'presets must be an array')
      return ok(deps.assembler.setPresets(sessionId, presets as ContextPreset[]))
    }
    if (method === 'PUT' && path === '/draft') {
      // The panel's unapplied plan. Storing it changes nothing the model sees;
      // it only stops a reload or a host restart from discarding the work.
      const draftSession = body['sessionId']
      if (typeof draftSession !== 'string') return fail(400, 'sessionId is required')
      const draftOps = body['ops']
      if (!Array.isArray(draftOps)) return fail(400, 'ops must be an array')
      return ok(deps.assembler.setDraft(draftSession, draftOps as ContextPlanOp[]))
    }
    if (method === 'POST' && path === '/plan') {
      const request = body as unknown as ContextPlanRequest
      if (typeof request.sessionId !== 'string') return fail(400, 'sessionId is required')
      if (!Array.isArray(request.ops)) return fail(400, 'ops must be an array')
      const dryRun = body['dryRun'] === true
      return ok(await deps.assembler.applyPlan(request, dryRun))
    }
    return fail(404, 'unknown api path: ' + path)
  } catch (error) {
    return fail(500, error instanceof Error ? error.message : String(error))
  }
}

/** Wrap a successful value. */
function ok<T>(value: T): ApiResponse {
  return { status: 200, body: { ok: true, value } }
}

/** Wrap a failure. */
function fail(status: number, error: string): ApiResponse {
  return { status, body: { ok: false, error } }
}

/** Send one resolved response as JSON. */
export function sendJson(res: ServerResponse, response: ApiResponse): void {
  res.writeHead(response.status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Cache-Control': 'no-store',
  })
  res.end(JSON.stringify(response.body))
}

/** Adapt the shared handler to a node request/response pair. */
async function nodeHandler(deps: ApiDeps, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method === 'OPTIONS') {
    sendJson(res, { status: 204, body: {} })
    return
  }
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  let body: Record<string, unknown> = {}
  if (req.method === 'POST' || req.method === 'PUT') {
    try {
      body = parseJson(await readBody(req))
    } catch (error) {
      sendJson(res, fail(400, error instanceof Error ? error.message : String(error)))
      return
    }
  }
  sendJson(res, await handle(deps, req.method ?? 'GET', url.pathname, url.searchParams, body))
}

/**
 * Mount the API on the harness web server.
 * @param webServer - the webServer service.
 * @param deps - assembler and configuration.
 * @returns the disposer removing the route.
 */
export function registerWebRoute(webServer: WebServerLike, deps: ApiDeps): () => void {
  return webServer.register({
    kind: 'prefix',
    path: API_PREFIX,
    handler: (req, res) => nodeHandler(deps, req, res),
  })
}

/** How many consecutive ports the private carrier will try before giving up. */
export const PORT_ATTEMPTS = 8

/** Bind one private carrier on exactly one port. */
function listenOnce(deps: ApiDeps, port: number): Promise<Server> {
  const server = createServer((req, res) => {
    void nodeHandler(deps, req, res)
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject)
      resolve(server)
    })
  })
}

/**
 * Start the private loopback server used when the harness web server is not
 * reachable from this plugin's context.
 *
 * A restart is exactly when a fixed port is least reliable: the outgoing host
 * may still hold the socket for a moment while the incoming one boots, and a
 * bind failure here used to be silent — the panel simply had nothing to talk to
 * and the feature looked like it had been thrown away. Walking a short range
 * makes the carrier survive that race; the panel probes the same range.
 * @param deps - assembler and configuration.
 * @returns the listening server.
 * @throws when every port in the range is unavailable.
 */
export async function startStandaloneServer(deps: ApiDeps): Promise<Server> {
  let lastError: unknown = new Error('no port available')
  for (let offset = 0; offset < PORT_ATTEMPTS; offset += 1) {
    try {
      return await listenOnce(deps, deps.config.port + offset)
    } catch (error) {
      lastError = error
    }
  }
  throw lastError
}
