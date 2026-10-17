/**
 * 自动驾驶：插件在后台把流程推起来，人只在两处出现——**开头选一次意图**、**过关卡时拍一次板**。
 *
 * 为什么不让人敲命令：命令是给人操作 CLI 的入口，而这里真正的主角是模型与流水线。
 * 插件要做的不是再提供一套动词，而是：
 *
 * 1. `agent/pre-step`：认出「这是论文工作区、用户还没定过意图」→ 问一道选择题
 *    （`ctx.userQuestions.ask`，三四档常见起点）→ 把答案写进决定日志 →
 *    `ctx.goals.create` 建目标（宿主的 goal-round-driver 此后自动续轮）→
 *    注入一条 operating contract（怎么推进、怎么并行、哪里必须停）。
 * 2. `tools/pre-execute`：模型要过 G1-G4 时拦一次 `ask`，由人在审批界面拍板。
 *
 * 两条铁律：**只对主 agent 生效**（子 agent 委派深度 > 0 一律跳过）、
 * **只对论文工作区生效**（找不到台账就完全不介入，别的项目里装了这个插件也不受干扰）。
 *
 * @module dsh-thesis/autopilot
 */

import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { PreToolDecision } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import type { AutopilotOptions } from '../config.ts'
import { findThesisRoot } from '../paper/lib/project.ts'
import { runDecision } from '../paper/tools/decision.ts'
import { choiceOfLabel, INTENT_QUESTION_ID, intentQuestion, type IntentChoice } from './intent.ts'
import { gateApprovalReason, makeAutopilotMessage } from './messages.ts'
import type { AutopilotAnswerItem, AutopilotAgent, GoalsService, UserQuestionsService } from './types.ts'

/** 一个 agent 的委派深度：与宿主 `delegationDepthOf` 同一条规则（头里的深度只增不减）。 */
export function agentDepth(agent: AutopilotAgent): number {
  const fromHeader = agent.session?.header?.subagentDepth ?? 0
  const fromOptions = agent.options?.subagentDepth ?? 0
  return Math.max(fromHeader, fromOptions)
}

/** 从结构化答案里取出被选中的标签（兼容多选与自定义输入）。 */
export function selectedLabel(answer: { readonly answers?: readonly AutopilotAnswerItem[] } | undefined): string | undefined {
  const item = answer?.answers?.find(entry => entry.id === INTENT_QUESTION_ID) ?? answer?.answers?.[0]
  if (item === undefined) return undefined
  const picked = item.selected?.[0]
  if (typeof picked === 'string' && picked.trim() !== '') return picked
  if (typeof item.custom === 'string' && item.custom.trim() !== '') return item.custom
  return undefined
}

/** 意图规格是否已经存在（存在就不再打扰：用户已经定过要求，或已经跑过一轮）。 */
async function specExists(ctx: Context, root: string, specRel: string, signal?: AbortSignal): Promise<boolean> {
  try {
    await ctx.fs.readText(await ctx.fs.resolve(`${root}/${specRel}`, { signal }), signal)
    return true
  } catch {
    return false
  }
}

/** 装配参数：配置里的自动驾驶块 + 意图规格落盘位置（与 intake 共用同一份配置）。 */
export interface AutopilotInstallOptions extends AutopilotOptions {
  /** 意图规格文件相对论文工作区根的位置。 */
  readonly specRel: string
}

/**
 * 装上自动驾驶的两处监听。
 *
 * 顺序关键：`agent/pre-step` 先 `await next()` 再注入（与写作意图闸门同一约定），
 * 任何异常都吞成「不介入」，绝不把错误抛进 agent 循环。
 */
export function installAutopilot(ctx: Context, options: AutopilotInstallOptions): void {
  if (!options.enabled) return
  const started = new Set<string>()

  ctx.on('agent/pre-step', async (payload: {
    readonly agent?: AutopilotAgent
    readonly signal?: AbortSignal
  }, next: () => Promise<PreStepDecision>): Promise<PreStepDecision> => {
    const downstream = await next()
    if (downstream.kind !== 'enter') return downstream
    const agent = payload.agent
    if (agent === undefined) return downstream
    if (agentDepth(agent) > 0) return downstream

    const key = agent.id ?? 'anonymous'
    if (started.has(key)) return downstream

    let root: string | null = null
    try {
      root = await findThesisRoot(ctx.fs, agent.session?.header?.cwd, payload.signal)
    } catch {
      // 配置的 workspace 写错、台账读不出来：都不属于「自动驾驶」该处理的场景。
      return downstream
    }
    if (root === null) return downstream
    started.add(key)

    if (await specExists(ctx, root, options.specRel, payload.signal)) {
      ctx.logger.info('dsh-thesis: 已有意图规格，自动驾驶不再重复询问，按现有规格推进。')
      return downstream
    }

    const choice = await askIntent(ctx, agent, payload.signal)
    if (choice === undefined) return downstream

    try {
      await runDecision(
        ctx.fs,
        { content: `自动驾驶启动：本次意图 = 「${choice.label}」（用户在启动选择题里确认；目标上限 ${options.maxGoalRounds} 轮）` },
        root,
        payload.signal,
      )
    } catch (error) {
      ctx.logger.warn(`dsh-thesis: 自动驾驶意图写进决定日志失败：${error instanceof Error ? error.message : String(error)}`)
    }

    armGoal(ctx, agent, choice, options.maxGoalRounds)
    return { kind: 'enter', messages: [...downstream.messages, makeAutopilotMessage(choice, options.maxGoalRounds)] }
  })

  if (options.gateApproval) installGateApproval(ctx)
}

/** 问那一道选择题；拿不到答案（没有答题面 / 用户取消 / 选了「先别自动跑」）时返回 undefined。 */
async function askIntent(ctx: Context, agent: AutopilotAgent, signal?: AbortSignal): Promise<IntentChoice | undefined> {
  const service = ctx.get('userQuestions') as UserQuestionsService | undefined
  if (service === undefined || typeof service.ask !== 'function') {
    ctx.logger.info('dsh-thesis: 宿主没有 userQuestions 服务，自动驾驶跳过意图询问（改为按现有上下文推进）。')
    return undefined
  }
  try {
    const answer = await service.ask({ questions: [intentQuestion()], agent, ...(signal === undefined ? {} : { signal }) })
    const label = selectedLabel(answer)
    if (label === undefined) return undefined
    const choice = choiceOfLabel(label)
    // 认不出的标签（例如用户自己输入了别的）按「关掉自动驾驶」处理，绝不猜。
    if (choice === undefined || choice.objective === '') {
      ctx.logger.info(`dsh-thesis: 用户没有选择自动推进（${label}）。`)
      return undefined
    }
    return choice
  } catch (error) {
    ctx.logger.info(`dsh-thesis: 意图选择题没有拿到答案（${error instanceof Error ? error.message : String(error)}），本次不自动推进。`)
    return undefined
  }
}

/** 建目标：宿主的目标轮驱动器会按它自动续轮，直到完成或轮数用尽。 */
function armGoal(ctx: Context, agent: AutopilotAgent, choice: IntentChoice, maxGoalRounds: number): void {
  const goals = ctx.get('goals') as GoalsService | undefined
  if (goals === undefined || typeof goals.create !== 'function') {
    ctx.logger.info('dsh-thesis: 宿主没有 goals 服务，自动驾驶只推进当前一轮（不会自动续轮）。')
    return
  }
  try {
    goals.create(agent, { objective: choice.objective, maxGoalRounds })
  } catch (error) {
    ctx.logger.warn(`dsh-thesis: 建目标失败，本轮流完就停：${error instanceof Error ? error.message : String(error)}`)
  }
}

/** 人工关卡拦截：模型要过 G1-G4 时，先让人在审批界面拍一次板。 */
function installGateApproval(ctx: Context): void {
  ctx.on('tools/pre-execute', async (exec: {
    readonly name?: string
    readonly agent?: unknown
    readonly arguments?: unknown
  }, next: () => Promise<PreToolDecision>): Promise<PreToolDecision> => {
    if (exec.agent === undefined) return next()
    if (exec.name !== 'thesis_progress') return next()
    const args = exec.arguments as { action?: unknown; gate?: unknown; pass?: unknown; chapter?: unknown; note?: unknown } | undefined
    if (args === undefined || args.action !== 'gate' || args.pass !== true) return next()
    const gate = typeof args.gate === 'string' ? args.gate.toUpperCase() : '关卡'
    const chapter = typeof args.chapter === 'string' ? args.chapter : undefined
    const note = typeof args.note === 'string' ? args.note : undefined
    return {
      kind: 'ask',
      reason: gateApprovalReason({ gate, ...(chapter === undefined ? {} : { chapter }), ...(note === undefined ? {} : { note }) }),
    }
  })
}
