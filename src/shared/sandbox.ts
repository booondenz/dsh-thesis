/**
 * 沙箱策略透传：给 `ctx.fs` 的写调用补上第 5 参 `sandboxPolicy`。
 *
 * 宿主的写签名是 `writeText(target, content, expected?, signal?, sandboxPolicy?)`，
 * 第 5 参决定这次写**按哪个会话的可写根**判定。省略它，宿主退回部署默认策略
 * （`workspaceRoot = process.cwd()`），于是 `workspace-write` 模式下连"写用户自己的
 * 工作区"都会被判成越界：`FS_SANDBOX_DENIED`。临时目录能写、工作区不能写，就是这个原因。
 *
 * 用法：工具执行体里把 `ctx.fs` 换成 `sandboxedFs(ctx, exec.agent?.session)`；
 * 中间件里把 `agent.session` 传进来即可。读操作不受影响（原样透传）。
 *
 * @module dsh-thesis/shared/sandbox
 */

import type { Context } from '@deepseek-ai/cordis'
import type { FileSystem } from '@deepseek-ai/dsh-fs'

/** 宿主组合的沙箱策略服务（`ctx.sandboxPolicy`）的最小面。 */
interface SandboxPolicyServiceShape {
  resolve(request?: { session?: unknown }): unknown
}

/**
 * 解析本次调用该用的沙箱策略。
 *
 * 宿主没组合该服务时返回 `undefined`（例如离线测试、裸本机后端），
 * 此时保持原行为——不传第 5 参，由宿主自己兜底。
 */
export function resolveSandboxPolicy(ctx: Context, session: unknown): unknown {
  const service = ctx.get('sandboxPolicy') as SandboxPolicyServiceShape | undefined
  if (service === undefined) return undefined
  return service.resolve(session === undefined ? {} : { session })
}

/** 需要补策略的写方法（读取类方法原样透传，多一次参数会改变语义）。 */
const WRITE_METHODS = new Set<string>(['writeText', 'editText'])

/**
 * 返回一个"写操作自动带上会话沙箱策略"的 `ctx.fs`。
 *
 * 只包 `writeText`/`editText`，其余属性和方法原样透传，因此调用方无需任何改动，
 * 插件里所有 lib 层的 `fs.writeText(...)` 都会自动拿到正确的策略。
 */
export function sandboxedFs(ctx: Context, session: unknown): FileSystem {
  const fs = ctx.fs
  const policy = resolveSandboxPolicy(ctx, session)
  if (policy === undefined) return fs

  return new Proxy(fs, {
    get(target, property, receiver): unknown {
      const value = Reflect.get(target, property, receiver)
      if (typeof property !== 'string' || !WRITE_METHODS.has(property) || typeof value !== 'function') {
        return value
      }
      const method = value as (...args: unknown[]) => Promise<unknown>
      // 前四个参数原样转发，策略固定为本次调用解析出来的那一套。
      return (file: unknown, content: unknown, expected?: unknown, signal?: unknown) =>
        method.call(fs, file, content, expected, signal, policy)
    },
  })
}
