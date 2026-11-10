/**
 * 代码演练引擎的写调用也要带沙箱策略。
 *
 * issue #1 报的不只是论文工具：`defense_code_update` 在 workspace-write 下同样被拒。
 * 引擎是注册期创建的单例，拿不到 per-call 的 session，所以每次调用用 `forSession`
 * 现绑一个——这里钉死"绑定之后写的是第 5 参带策略的 writeText"。
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { AiLearningEngine } from '../src/codewalk/engine.ts'

interface RecordedCall {
  readonly method: string
  readonly args: readonly unknown[]
}

function fakeHost(policy?: unknown) {
  const calls: RecordedCall[] = []
  const fs = {
    async resolve(path: string) {
      return { targetKey: path, displayPath: path }
    },
    async stat() {
      return undefined
    },
    async readText() {
      calls.push({ method: 'readText', args: [] })
      return ''
    },
    async writeText(...args: unknown[]) {
      calls.push({ method: 'writeText', args })
      return {}
    },
  }
  const ctx = {
    get(name: string) {
      if (name === 'fs') return fs
      if (name === 'sandboxPolicy') return policy
      return undefined
    },
    log: { info: () => {}, warn: () => {} },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  }
  return { ctx, calls }
}

const session = { header: { cwd: '/Users/me/project' } }
const config = { gates: { go: { build: ['go', 'build', './...'] } } }

test('forSession 之后的写调用带第 5 参，且策略来自该会话', async () => {
  const policy = {
    resolve(request?: { session?: unknown }) {
      return { mode: 'workspace-write', workspaceRoot: '/Users/me/project', session: request?.session }
    },
  }
  const { ctx, calls } = fakeHost(policy)
  const engine = new AiLearningEngine(ctx as never, config).forSession(session)

  await engine.create('/Users/me/project', { origin: { path: '/Users/me/project', language: 'go' }, scope: { level: 'beginner' } })

  const write = calls.find(call => call.method === 'writeText')
  assert.ok(write !== undefined, 'create 必须落盘')
  assert.equal(write.args.length, 5, `writeText 必须是 5 个参数，实际 ${write.args.length} 个`)
  assert.deepEqual(write.args[4], { mode: 'workspace-write', workspaceRoot: '/Users/me/project', session })
})

test('没有绑定会话时保持原行为（离线/裸后端不做无谓包装）', async () => {
  const { ctx, calls } = fakeHost(undefined)
  const engine = new AiLearningEngine(ctx as never, config)
  await engine.create('/tmp/x', { origin: { path: '/tmp/x', language: 'go' }, scope: { level: 'beginner' } })

  const write = calls.find(call => call.method === 'writeText')
  assert.ok(write !== undefined)
  assert.equal(write.args.length, 3, '未绑定时按原签名写（target, content, expected）')
})
