/**
 * 自动驾驶注入的消息与关卡确认文案。
 *
 * 与闸门消息共用同一条 source 约定：`{ kind: 'plugin', plugin: 'dsh-thesis', form: 'instructions' }`。
 * `form` 是宿主渲染指令的语义形态；`sections` 只属于 snapshot 形态，这里不写。
 *
 * @module dsh-thesis/autopilot
 */

import { randomUUID } from 'node:crypto'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { PLUGIN_SOURCE } from '../gates/messages.ts'
import { autopilotInstruction, type IntentChoice } from './intent.ts'

/** 构造启动指令消息（插件来源、instructions 形态）。 */
export function makeAutopilotMessage(choice: IntentChoice, maxGoalRounds: number): UserMessage {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text: autopilotInstruction(choice, maxGoalRounds) }],
    source: { ...PLUGIN_SOURCE, form: 'instructions' },
  } as UserMessage
}

/**
 * 人工关卡的确认文案（`tools/pre-execute` 的 ask 决策，显示在审批界面）。
 *
 * 一关只问一次，问题只有一个：这一步你认不认。认了流程才会继续推进。
 */
export function gateApprovalReason(request: {
  readonly gate: string
  readonly chapter?: string
  readonly note?: string
}): string {
  const target = request.chapter === undefined ? request.gate : `${request.gate}（${request.chapter}）`
  return [
    `【dsh-thesis · 人工关卡】流程要过「${target}」这一关。`,
    '这是插件里唯一必须由你拍板的地方：过了这关，后面的产出就按它往下走。',
    '',
    '允许 = 这一关通过，流程继续；拒绝 = 打回，让模型先去补该补的东西。',
    request.note === undefined ? '' : `模型给的备注：${request.note}`,
  ].filter(line => line !== '').join('\n')
}
