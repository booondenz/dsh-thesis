/**
 * 自动驾驶用到的**最小宿主面**：只要真实宿主对象在结构上满足这些字段即可。
 *
 * 与 `codewalk/host-types.ts` 同一取舍：不在插件里 import `@deepseek-ai/dsh-agent` /
 * `-goal` / `-user-questions`，离线单测才能在没有宿主包树的环境里跑；
 * 真实宿主那边由 `scripts/host-smoke.ts` 复核。
 *
 * @module dsh-thesis/autopilot
 */

/** 一个 agent 上真正用到的字段（委派深度、会话 cwd）。 */
export interface AutopilotAgent {
  readonly id?: string
  readonly options?: { readonly subagentDepth?: number }
  readonly session?: {
    readonly header?: {
      readonly cwd?: string
      /** 持久化会话头里的委派深度：子 agent 大于 0（`delegationDepthOf` 的依据）。 */
      readonly subagentDepth?: number
    }
  }
}

/** 一道选择题的选项。 */
export interface AutopilotOption {
  readonly label: string
  readonly description?: string
}

/** 一道选择题（宿主 `AskUserQuestionItem` 的子集）。 */
export interface AutopilotQuestion {
  readonly id: string
  readonly question: string
  readonly header?: string
  readonly detail?: string
  readonly options?: readonly AutopilotOption[]
  readonly multiSelect?: boolean
}

/** 一个问题的答案（宿主 `AskUserQuestionAnswerItem`）。 */
export interface AutopilotAnswerItem {
  readonly id: string
  readonly selected: readonly string[]
  readonly custom?: string
}

/** `ctx.userQuestions` 的最小面：问一次、拿结构化答案。 */
export interface UserQuestionsService {
  ask(request: {
    readonly questions: readonly AutopilotQuestion[]
    readonly agent?: unknown
    readonly signal?: AbortSignal
  }): Promise<{ readonly answers?: readonly AutopilotAnswerItem[] } | undefined>
}

/** `ctx.goals` 的最小面：建一个目标，剩下的轮次由宿主的 goal-round-driver 驱动。 */
export interface GoalsService {
  create(agent: unknown, request: { readonly objective: string; readonly maxGoalRounds?: number }): unknown
}
