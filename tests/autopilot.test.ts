/**
 * 自动驾驶的行为测试：不装宿主，用假 Context / 假 fs / 假服务驱动两条监听。
 *
 * 覆盖的是「什么时候不该介入」这类最容易写错的地方：非论文工作区、子 agent、
 * 已经有意图规格的会话都必须**完全安静**；只有「论文工作区 + 主 agent + 还没定过意图」
 * 才问那一道选择题。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  agentDepth,
  installAutopilot,
  selectedLabel,
} from '../src/autopilot/index.ts'
import { HANDS_OFF_LABEL, INTENT_CHOICES, INTENT_QUESTION_ID, intentQuestion } from '../src/autopilot/intent.ts'
import { PAPER_DEFAULTS } from '../src/config.ts'
import { setWorkspaceRoot } from '../src/paper/lib/project.ts'
import { FakeFs } from './paper-fixtures.ts'

const CWD = '/work/thesis'
const LEDGER = '00-管理/进度台账.md'
const SPEC = '00-管理/意图规格.md'

interface Harness {
  readonly ctx: {
    fs: FakeFs
    logger: { debug(): void; info(message: string): void; warn(): void; error(): void }
    on(event: string, listener: (payload: any, next: any) => Promise<any>): () => void
    get(name: string): unknown
  }
  readonly listeners: Map<string, (payload: any, next: any) => Promise<any>>
  readonly asked: Array<{ questions: readonly { id: string }[]; agent?: unknown }>
  readonly goals: Array<{ objective: string; maxGoalRounds?: number }>
  readonly logged: string[]
  readonly fs: FakeFs
}

/** 假宿主：只实现自动驾驶真正用到的表面。 */
function harness(options: {
  answers?: readonly { id: string; selected: readonly string[] }[]
  withQuestions?: boolean
  withGoals?: boolean
} = {}): Harness {
  const listeners = new Map<string, (payload: any, next: any) => Promise<any>>()
  const asked: Harness['asked'] = []
  const goals: Harness['goals'] = []
  const logged: string[] = []
  const fs = new FakeFs()

  const ctx = {
    fs,
    logger: { debug() {}, info: (message: string) => { logged.push(String(message)) }, warn() {}, error() {} },
    on(event: string, listener: (payload: any, next: any) => Promise<any>) {
      listeners.set(event, listener)
      return () => {}
    },
    get(name: string): unknown {
      if (name === 'userQuestions' && options.withQuestions !== false) {
        return {
          async ask(request: { questions: readonly { id: string }[]; agent?: unknown }) {
            asked.push(request)
            return { answers: options.answers ?? [{ id: INTENT_QUESTION_ID, selected: [INTENT_CHOICES[0]!.label] }] }
          },
        }
      }
      if (name === 'goals' && options.withGoals !== false) {
        return {
          create(_agent: unknown, request: { objective: string; maxGoalRounds?: number }) {
            goals.push(request)
            return { ref: 1 }
          },
        }
      }
      return undefined
    },
  }
  return { ctx, listeners, asked, goals, logged, fs }
}

function options(overrides: Partial<{ enabled: boolean; maxGoalRounds: number; gateApproval: boolean }> = {}) {
  return { ...PAPER_DEFAULTS.autopilot, specRel: PAPER_DEFAULTS.intake.specRel, ...overrides }
}

function rootAgent(depth = 0) {
  return {
    id: 'agent-1',
    options: { subagentDepth: depth },
    session: { header: { cwd: CWD, subagentDepth: depth } },
  }
}

function preStep(downstream: unknown = { kind: 'enter', messages: [] }) {
  return async () => downstream
}

/** 把宿主接上，并 seed 一个「有台账、没有意图规格」的论文工作区。 */
async function boot(options: { seed?: boolean; withSpec?: boolean; harnessOptions?: Parameters<typeof harness>[0] } = {}) {
  setWorkspaceRoot(undefined)
  const h = harness(options.harnessOptions ?? {})
  if (options.seed !== false) {
    await h.fs.writeText({ displayPath: `${CWD}/${LEDGER}` }, '# 进度台账\n')
    if (options.withSpec === true) await h.fs.writeText({ displayPath: `${CWD}/${SPEC}` }, '# 意图规格\n')
  }
  installAutopilot(h.ctx as never, options_)
  return h
}

const options_ = options()

test('agentDepth：头里的深度与运行时选项取较大值（子 agent 一律不介入）', () => {
  assert.equal(agentDepth({}), 0)
  assert.equal(agentDepth({ session: { header: { subagentDepth: 2 } } }), 2)
  assert.equal(agentDepth({ options: { subagentDepth: 1 }, session: { header: { subagentDepth: 3 } } }), 3)
})

test('selectedLabel：按问题 id 取选中项，取不到时退回自定义文本', () => {
  assert.equal(selectedLabel({ answers: [{ id: INTENT_QUESTION_ID, selected: ['A'] }] }), 'A')
  assert.equal(selectedLabel({ answers: [{ id: 'other', selected: ['B'] }] }), 'B')
  assert.equal(selectedLabel({ answers: [{ id: INTENT_QUESTION_ID, selected: [], custom: '我自己写的' }] }), '我自己写的')
  assert.equal(selectedLabel({ answers: [] }), undefined)
  assert.equal(selectedLabel(undefined), undefined)
})

test('intentQuestion：四档选项、带 header 与说明、单选', () => {
  const question = intentQuestion()
  assert.equal(question.id, INTENT_QUESTION_ID)
  assert.equal(question.options.length, 4)
  assert.equal(question.options[3]!.label, HANDS_OFF_LABEL)
  assert.ok(question.header.length > 0)
  assert.ok(question.question.includes('做到哪一步'))
})

test('论文工作区 + 主 agent + 没有意图规格：问一次、记日志、建目标、注入指令', async () => {
  const h = await boot()
  const listener = h.listeners.get('agent/pre-step')!
  const decision = await listener({ agent: rootAgent(), signal: undefined }, preStep())

  assert.equal(h.asked.length, 1, '只问一次')
  assert.equal(decision.kind, 'enter')
  assert.equal(decision.messages.length, 1, '注入一条启动指令')
  assert.equal(decision.messages[0].source.plugin, 'dsh-thesis')
  assert.equal(decision.messages[0].source.form, 'instructions')
  assert.match(decision.messages[0].content[0].text, /自动驾驶/)
  assert.equal(h.goals.length, 1)
  assert.equal(h.goals[0]!.objective, INTENT_CHOICES[0]!.objective)
  assert.equal(h.goals[0]!.maxGoalRounds, PAPER_DEFAULTS.autopilot.maxGoalRounds)
  assert.ok(h.fs.peek(`${CWD}/00-管理/决定日志.md`)?.includes('自动驾驶启动'), '意图要写进决定日志')
})

test('同一个 agent 只问一次（第二轮不再打扰）', async () => {
  const h = await boot()
  const listener = h.listeners.get('agent/pre-step')!
  await listener({ agent: rootAgent() }, preStep())
  const again = await listener({ agent: rootAgent() }, preStep())
  assert.equal(h.asked.length, 1)
  assert.equal(again.messages.length, 0)
})

test('不是论文工作区：完全不介入（别的项目里装了也不受影响）', async () => {
  const h = await boot({ seed: false })
  const listener = h.listeners.get('agent/pre-step')!
  const decision = await listener({ agent: rootAgent() }, preStep())
  assert.equal(h.asked.length, 0)
  assert.equal(h.goals.length, 0)
  assert.equal(decision.messages.length, 0)
})

test('子 agent：完全不介入（委派深度 > 0）', async () => {
  const h = await boot()
  const listener = h.listeners.get('agent/pre-step')!
  const decision = await listener({ agent: rootAgent(1) }, preStep())
  assert.equal(h.asked.length, 0)
  assert.equal(decision.messages.length, 0)
})

test('已有意图规格：不重复问，只记一条日志', async () => {
  const h = await boot({ withSpec: true })
  const listener = h.listeners.get('agent/pre-step')!
  const decision = await listener({ agent: rootAgent() }, preStep())
  assert.equal(h.asked.length, 0)
  assert.equal(h.goals.length, 0)
  assert.equal(decision.messages.length, 0)
  assert.ok(h.logged.some(line => line.includes('已有意图规格')))
})

test('用户选「先别自动跑」：不建目标、不注入指令', async () => {
  const h = await boot({
    harnessOptions: { answers: [{ id: INTENT_QUESTION_ID, selected: [HANDS_OFF_LABEL] }] },
  })
  const listener = h.listeners.get('agent/pre-step')!
  const decision = await listener({ agent: rootAgent() }, preStep())
  assert.equal(decision.messages.length, 0)
  assert.equal(h.goals.length, 0)
})

test('宿主没有 userQuestions / goals 服务：安静退化成单轮（不抛错）', async () => {
  const h = await boot({ harnessOptions: { withQuestions: false, withGoals: false } })
  const listener = h.listeners.get('agent/pre-step')!
  const decision = await listener({ agent: rootAgent() }, preStep())
  assert.equal(decision.kind, 'enter')
  assert.equal(decision.messages.length, 0)
  assert.equal(h.goals.length, 0)
  assert.ok(h.logged.some(line => line.includes('userQuestions')))
})

test('关卡拍板：模型要过 G1-G4 时先问人，别的工具调用不拦', async () => {
  const h = await boot()
  const gate = h.listeners.get('tools/pre-execute')!

  const passthrough = async () => ({ kind: 'allow' as const })
  assert.deepEqual(await gate({ name: 'thesis_init', agent: {} }, passthrough), { kind: 'allow' })
  assert.deepEqual(await gate({ name: 'thesis_progress', agent: {}, arguments: { action: 'report' } }, passthrough), { kind: 'allow' })

  const decision = await gate(
    { name: 'thesis_progress', agent: {}, arguments: { action: 'gate', gate: 'G2', pass: true, chapter: '01-绪论', note: '字数与引用都过' } },
    passthrough,
  )
  assert.equal(decision.kind, 'ask')
  assert.match(decision.reason, /人工关卡/)
  assert.match(decision.reason, /G2/)
  assert.match(decision.reason, /01-绪论/)

  // 没有 agent（程序化调用）不拦。
  assert.deepEqual(await gate({ name: 'thesis_progress', arguments: { action: 'gate', gate: 'G2', pass: true } }, passthrough), { kind: 'allow' })
})

test('总开关关掉：一条监听都不装', () => {
  setWorkspaceRoot(undefined)
  const h = harness()
  installAutopilot(h.ctx as never, options({ enabled: false }))
  assert.equal(h.listeners.size, 0)
})
