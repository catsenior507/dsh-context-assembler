/**
 * dsh-context-assembler client half: mounts the assembled-context panel into
 * the dsh web GUI.
 *
 * React comes from the shell module table, so the bundle carries no framework
 * copy and the panel shares the shell instance. The mount point is a plain
 * body child rather than a slot: the panel is a floating, always-available
 * surface that must keep working even when a theme plugin reshapes the layout.
 *
 * @module dsh-context-assembler/client
 */
import type { Context } from '@deepseek-ai/cordis'
import React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { ContextAssemblerApp } from './panel'
import './context-assembler.module.css'

const OWNER = 'context-assembler'

/**
 * Mount the panel.
 * @param ctx - the client plugin context.
 */
export function apply(ctx: Context): void {
  const mount = document.createElement('div')
  mount.dataset.dshContextAssemblerRoot = ''
  mount.setAttribute('aria-label', 'assembled context manager')
  document.body.append(mount)

  let root: Root | null = null
  try {
    root = createRoot(mount)
    root.render(React.createElement(ContextAssemblerApp))
  } catch {
    mount.remove()
    throw new Error('[' + OWNER + '] 挂载组装式上下文面板失败：React root 创建出错')
  }

  ctx.effect(() => () => {
    root?.unmount()
    mount.remove()
  }, 'ui-context-assembler: panel lifecycle')
}
