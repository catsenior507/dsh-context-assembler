/**
 * dsh-context-assembler, host half — 组装式上下文.
 *
 * The harness sends the model everything on a session surface: an append-only
 * log projected into messages. Compaction is the only built-in way to shrink
 * that projection, and it is all-or-nothing — a summary the user never sees and
 * cannot adjust.
 *
 * This plugin turns the same surface into a tree the user and the agent can
 * assemble directly. Every model-visible fact becomes a row with one of three
 * modes, and the plugin compiles those modes into the one structural move the
 * harness offers: a surface replacement that collapses a contiguous range into
 * a single message, leaving every other node exactly where it was.
 *
 * Pieces:
 *
 * - host/service.ts — tree reads, plan commits, preset storage
 * - host/surface.ts — the surface fold and per-node message projection
 * - host/tree.ts    — log to context tree
 * - host/planner.ts — modes to surface operations
 * - host/api.ts     — the HTTP surface the browser panel drives
 * - host/tool.ts    — the context_assembler tool the agent drives
 * - client/         — the browser panel
 *
 * @module @dsh-external/dsh-client-plugin-context-assembler
 */

import type { ContextAssemblerConfig } from './shared/types.ts'
import {
  ContextAssembler,
  resolveConfig,
  type HostContextLike,
  type SessionPersistenceLike,
  type SessionStoreLike,
} from './host/service.ts'
import { registerWebRoute, startStandaloneServer, type WebServerLike } from './host/api.ts'
import { registerTool, type ToolRegistryLike } from './host/tool.ts'

/** Cordis plugin name. */
export const name = 'context-assembler'

/**
 * The one service this plugin cannot work without.
 *
 * Cordis refuses to read a service property from a context that never declared
 * it — "cannot get property sessions without inject" — and that refusal happens
 * at plugin-apply time, so an undeclared dependency is a boot failure rather
 * than a degraded feature. `sessions` is mounted by dsh-base in every profile,
 * so requiring it costs nothing; every other service (tools, webServer) is read
 * through the optional accessor below and simply changes what activates.
 */
export const inject = ['sessions', 'tools']

/** Everything the plugin reaches for on the cordis context. */
interface PluginContext extends HostContextLike {
  sessions?: SessionStoreLike
  logger?: { warn(message: string): void; info(message: string): void }
}

/**
 * Read an optional service without declaring it in `inject`.
 *
 * Cordis exposes `ctx.get(name)` for exactly this: a missing service yields
 * undefined instead of the inject refusal a property read would raise.
 * @param ctx - the plugin context.
 * @param name - service name.
 * @returns the service, or undefined when the profile does not mount it.
 */
function optionalService<T>(ctx: PluginContext, name: string): T | undefined {
  // cordis exposes a non-throwing lookup in two places depending on version:
  // the mixed-in `ctx.get` and the reflection service's own two-argument form.
  const direct = (ctx as { get?: (serviceName: string) => unknown }).get;
  if (typeof direct === 'function') {
    try {
      const value = direct.call(ctx, name);
      if (value !== undefined) return value as T;
    } catch {
      // fall through to the reflection accessor
    }
  }
  const reflect = (ctx as { reflect?: { get?: (serviceName: string, strict?: boolean) => unknown } }).reflect;
  if (reflect !== undefined && typeof reflect.get === 'function') {
    try {
      return reflect.get(name, false) as T | undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/**
 * Mount the host half.
 * @param ctx - the plugin cordis context, already holding the sessions service.
 * @param config - optional plugin configuration from the profile row.
 */
export function apply(ctx: PluginContext, config?: Partial<ContextAssemblerConfig>): void {
  const resolved = resolveConfig(config)
  const sessions = ctx.sessions
  if (sessions === undefined) {
    ctx.logger?.warn('[context-assembler] sessions 服务不可用，插件未激活')
    return
  }
  // Persistence is resolved lazily, per request: the service is registered but
  // not necessarily active when this plugin applies, so reading it here would
  // capture undefined and silently reduce the panel to live sessions forever.
  const assembler = new ContextAssembler(
    sessions,
    resolved,
    () => optionalService<SessionPersistenceLike>(ctx, 'sessionPersistence'),
    (message) => ctx.logger?.warn?.(message),
  )
  // Titles and event counts for stored conversations are read from their logs,
  // which costs a full read each; warming them at mount means the picker is
  // already labelled when it first opens instead of showing placeholders.
  assembler.warmIndex()
  mountApi(ctx, assembler, resolved)
  if (resolved.exposeTool) mountTool(ctx, assembler)
  mountAutoPresets(ctx, assembler)
}

// Deliberately NO default export: cordis resolves a module plugin as
// module.default ?? module, so a default export would hide the named `inject`
// above and every `ctx.sessions` read would fail with "cannot get property
// sessions without inject". The reference tool plugins export the same named
// triple for the same reason.

/** Mount the HTTP surface on whichever carrier this profile has. */
function mountApi(ctx: PluginContext, assembler: ContextAssembler, config: ReturnType<typeof resolveConfig>): void {
  const deps = { assembler, config }
  const webServer = optionalService<WebServerLike>(ctx, 'webServer')
  if (webServer !== undefined && typeof webServer.register === 'function') {
    try {
      const dispose = registerWebRoute(webServer, deps)
      ctx.effect?.(() => () => dispose(), 'context-assembler: web route')
      ctx.logger?.info?.('[context-assembler] 已挂载到 /api/context-assembler')
      return
    } catch (error) {
      ctx.logger?.warn?.('[context-assembler] 挂载 webServer 路由失败，改用本地端口：' + String(error))
    }
  }
  void startStandaloneServer(deps)
    .then((server) => {
      ctx.effect?.(() => () => {
        server.close()
      }, 'context-assembler: standalone server')
      ctx.logger?.info?.('[context-assembler] 本地 API http://127.0.0.1:' + config.port)
    })
    .catch((error: unknown) => {
      ctx.logger?.warn?.('[context-assembler] 本地 API 端口启动失败：' + String(error))
    })
}

/** Register the model-facing context tool when a tool registry exists. */
function mountTool(ctx: PluginContext, assembler: ContextAssembler): void {
  const tools = optionalService<ToolRegistryLike>(ctx, 'tools')
  if (tools === undefined || typeof tools.register !== 'function') return
  try {
    const dispose = registerTool(tools, assembler)
    ctx.effect?.(() => () => dispose(), 'context-assembler: context_assembler tool')
  } catch (error) {
    ctx.logger?.warn?.('[context-assembler] 注册 context_assembler 工具失败：' + String(error))
  }
}

/**
 * Apply presets marked auto whenever a turn closes.
 *
 * Opt-in per rule and off for every shipped template: silently rewriting what
 * the model reads is a strong action, so the profile row has to ask for it.
 */
function mountAutoPresets(ctx: PluginContext, assembler: ContextAssembler): void {
  if (typeof ctx.on !== 'function') return
  ctx.on('session/event', (...args: unknown[]) => {
    const event = args[1] as { type?: string } | undefined
    if (event === undefined || event.type !== 'turn/end') return
    const session = args[0] as { id?: string } | undefined
    if (session === undefined || typeof session.id !== 'string') return
    const rules = assembler.presetsFor(session.id)
    if (!rules.some((rule) => rule.enabled && rule.auto === true)) return
    // Fire and forget: the turn is already closing, and a preset that fails must
    // not surface as a rejected turn-end handler.
    void assembler.applyPlan({ sessionId: session.id, ops: [], applyPresets: true }, false).catch((error: unknown) => {
      ctx.logger?.warn?.('[context-assembler] 自动预设失败：' + String(error))
    })
  })
}
