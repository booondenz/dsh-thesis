/**
 * 沙箱策略透传：写调用必须带上「本次会话」的 sandboxPolicy。
 *
 * 这里的用例直接对着宿主签名写：`writeText(target, content, expected?, signal?, sandboxPolicy?)`。
 * 少传第 5 参时宿主的实际表现是：workspace-write 下连会话工作区都被判越界（FS_SANDBOX_DENIED），
 * 只有宿主临时区放行——这正是 issue #1 描述的现象，所以这里钉死"第 5 参一定在"。
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveSandboxPolicy, sandboxedFs } from '../src/shared/sandbox.ts'

interface Call {
  readonly method: string
  readonly args: readonly unknown[]
}

/** 假 ctx：只提供 fs 与 sandboxPolicy 服务，记录所有调用参数。 */
function fakeContext(policy?: unknown) {
  const calls: Call[] = []
  const fs = {
    async resolve(path: string) {
      calls.push({ method: 'resolve', args: [path] })
      return { targetKey: path, displayPath: path }
    },
    async readText(target: unknown, signal?: unknown) {
      calls.push({ method: 'readText', args: [target, signal] })
      return ''
    },
    async writeText(...args: unknown[]) {
      calls.push({ method: 'writeText', args })
      return {}
    },
    async editText(...args: unknown[]) {
      calls.push({ method: 'editText', args })
      return {}
    },
  }
  const ctx = {
    fs,
    get(name: string) {
      if (name !== 'sandboxPolicy') return undefined
      return policy
    },
  }
  return { ctx, fs, calls }
}

const run = (ctx: unknown) => ctx as never
const session = { header: { cwd: '/Users/me/Documents/thesis' } }

test('写调用带上第 5 参：策略由当前会话解析', async () => {
  const requested: unknown[] = []
  const policy = {
    resolve(request?: { session?: unknown }) {
      requested.push(request)
      return { mode: 'workspace-write', workspaceRoot: '/Users/me/Documents/thesis' }
    },
  }
  const { ctx, calls } = fakeContext(policy)
  const fs = sandboxedFs(run(ctx), session)
  const signal = new AbortController().signal

  await fs.writeText({ targetKey: 'x' }, 'hello', undefined, signal)

  const write = calls.find(call => call.method === 'writeText')
  assert.ok(write !== undefined, '必须真的调用宿主的 writeText')
  assert.equal(write.args.length, 5, `writeText 必须是 5 个参数，实际 ${write.args.length} 个`)
  assert.deepEqual(write.args[4], { mode: 'workspace-write', workspaceRoot: '/Users/me/Documents/thesis' })
  assert.deepEqual(requested, [{ session }], '解析策略时要带上本次会话')
})

test('editText 同样带策略（宿主对两个写方法签名一致）', async () => {
  const policy = { resolve: () => ({ mode: 'workspace-write', workspaceRoot: '/tmp' }) }
  const { ctx, calls } = fakeContext(policy)
  await sandboxedFs(run(ctx), session).editText({ targetKey: 'x' }, { find: 'a', replace: 'b' })

  const edit = calls.find(call => call.method === 'editText')
  assert.ok(edit !== undefined)
  assert.equal(edit.args.length, 5)
})

test('没有沙箱服务时原样返回（离线测试 / 裸本机后端不做无谓包装）', () => {
  const { ctx, fs } = fakeContext(undefined)
  assert.equal(sandboxedFs(run(ctx), session), fs, '拿不到策略时应返回原始 fs')
  assert.equal(resolveSandboxPolicy(run(ctx), session), undefined)
})

test('读操作不受影响：参数个数与调用路径保持原样', async () => {
  const policy = { resolve: () => ({ mode: 'workspace-write' }) }
  const { ctx, calls } = fakeContext(policy)
  const fs = sandboxedFs(run(ctx), session)

  const target = await fs.resolve('/tmp/x')
  await fs.readText(target, undefined)

  assert.deepEqual(calls.map(call => call.method), ['resolve', 'readText'])
  assert.equal(calls[1]!.args.length, 2, 'readText 不能多出一个策略参数')
})

test('没有会话时按「无 session」解析，而不是把 undefined 当 session 传下去', () => {
  const requested: unknown[] = []
  const policy = {
    resolve(request?: { session?: unknown }) {
      requested.push(request)
      return { mode: 'danger-full-access' }
    },
  }
  const { ctx } = fakeContext(policy)
  assert.deepEqual(resolveSandboxPolicy(run(ctx), undefined), { mode: 'danger-full-access' })
  assert.deepEqual(requested, [{}])
})
