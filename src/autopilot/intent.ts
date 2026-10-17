/**
 * 自动驾驶的文案与意图选项：**一次只问一个问题**，答案决定接下来跑到哪一步。
 *
 * 这里的文本是插件直接呈现给用户的（不是给模型的），所以用词要能让人一眼选：
 * 三档常见起点 + 一个「先别自动跑」。选完就不再打断，直到撞上人工关卡。
 *
 * @module dsh-thesis/autopilot
 */

/** 意图选择题的问题 id（宿主按 id 把答案回传）。 */
export const INTENT_QUESTION_ID = 'dsh-thesis.intent'

/** 一档意图：选项文案 + 目标 + 启动指令里要向模型交代的边界。 */
export interface IntentChoice {
  /** 选项标签（用户看到的那一行）。 */
  readonly label: string
  /** 选项说明（UI 可渲染在标签下方）。 */
  readonly description: string
  /** 写进 goal 的目标（宿主按它渲染续跑提示）。 */
  readonly objective: string
  /** 注入给模型的第一条指令正文；空串表示「用户不要自动跑」。 */
  readonly instruction: string
}

/** 「先别自动跑」的选项标签：回答它等于关掉本次自动驾驶。 */
export const HANDS_OFF_LABEL = '先别自动跑，我自己来'

/** 三档起点 + 一个关闭项（顺序即 UI 顺序）。 */
export const INTENT_CHOICES: readonly IntentChoice[] = [
  {
    label: '从零走到答辩（九阶段全跑）',
    description: '材料 → 追问 → 文献 → 设计 → 实现 → 测试 → 论文 → 合规 → 答辩，中间只在人工关卡停下来问你。',
    objective: '在 dsh-thesis 论文工作区里把毕业设计从材料推进到论文 docx 与答辩材料，按九阶段与 G1-G4 关卡推进，撞关卡时停下来问用户一次。',
    instruction: [
      '本次会话已开启**自动驾驶**：用户刚选了「从零走到答辩」。',
      '按 `thesis-pipeline` 技能推进，顺序：`thesis_progress action=report` 看当前阶段 → 缺工作区就 `thesis_init` → 有材料就 `thesis_ingest` → 用 `thesis_intake` 逐题追问（一次一个）把要求问成意图规格 → 文献 → 逐章写作与评审 → 全文检查 → 构建 → 原创性自查 → 答辩。',
      '省时间的并行部分（例如各章写作、逐章检查、文献笔记）用 subagent / workflow 扇出，但**结论必须落盘到工作区**，不要只留在子 agent 的上下文里。',
    ].join('\n'),
  },
  {
    label: '已有材料/初稿，补齐合规与答辩',
    description: '不重写已有章节；先做引用与格式检查、降重自查，再出答辩材料与幻灯。',
    objective: '在已有的 dsh-thesis 论文工作区里补齐合规检查（引用/字数/图表/术语/模板）、原创性自查与答辩材料，不重写已有正文。',
    instruction: [
      '本次会话已开启**自动驾驶**：用户刚选了「已有材料/初稿，补齐合规与答辩」。',
      '先 `thesis_progress action=report` 与 `thesis_check` 看清现状，再按缺口补：引用 bidirectional 一致、字数区间、图表编号、术语定义顺序、样式自查、原创性复测，最后 `thesis_defense` + `thesis_slides`。',
      '**不要重写用户已有的正文**；发现必须改动的地方，先记进决定日志再动。',
    ].join('\n'),
  },
  {
    label: '只做答辩准备',
    description: '答辩素材、预答辩问题库、幻灯与讲稿，以及把系统拆成讲得清的模块。',
    objective: '只做答辩准备：答辩素材、六类问题库、答辩幻灯与讲稿，以及代码演练（把系统拆成讲得清的模块）。',
    instruction: [
      '本次会话已开启**自动驾驶**：用户刚选了「只做答辩准备」。',
      '顺序：`thesis_defense` 出素材与问题库 → `thesis_slides outline` 出幻灯骨架并逐页补齐讲稿与证据锚点 → `thesis_slides check` 自查 → 需要讲实现细节时用 `defense_code_*` 做代码演练。',
      '幻灯以 Markdown 为准，pptx 转换探测不到外部引擎时如实说明，不假装成功。',
    ].join('\n'),
  },
  {
    label: HANDS_OFF_LABEL,
    description: '本次不建目标、不自动续跑，照常一问一答。',
    objective: '',
    instruction: '',
  },
]

/** 把用户选的标签映射回一档意图；认不出来时返回 undefined（按「关掉」处理）。 */
export function choiceOfLabel(label: string): IntentChoice | undefined {
  const normalized = label.trim()
  return INTENT_CHOICES.find(choice => choice.label === normalized)
}

/** 构造那一道选择题。 */
export function intentQuestion(): {
  readonly id: string
  readonly header: string
  readonly question: string
  readonly detail: string
  readonly options: readonly { readonly label: string; readonly description: string }[]
} {
  return {
    id: INTENT_QUESTION_ID,
    header: '确认意图',
    question: '这次想让我做到哪一步？选一个我就一路跑下去。',
    detail: '只在人工关卡（选题/逐章验收/开题/提交自查）停下来问你；其余步骤我自己推进。',
    options: INTENT_CHOICES.map(choice => ({ label: choice.label, description: choice.description })),
  }
}

/** 启动指令消息的正文（含「这条不是用户需求」的免责声明）。 */
export function autopilotInstruction(choice: IntentChoice, maxGoalRounds: number): string {
  return [
    '【dsh-thesis · 自动驾驶】',
    choice.instruction,
    '',
    `目标已登记（最多 ${maxGoalRounds} 轮自动续跑）。每轮结束前，用 \`thesis_progress action=report\` 看一眼台账，确认下一步是该继续、该停下来问，还是该收尾。`,
    '规矩：',
    '1. 人工关卡（G1-G4）由**用户**拍板——轮到你过闸时，插件会弹一次确认，不要自己替用户过。',
    '2. 数据与文献只能来自真实运行与真实检索；拿不到就如实说，绝不编造。',
    '3. 大段独立的写作/检查用子 agent 并行，但**产出必须写进工作区文件**，子 agent 的结论不落盘等于没做。',
    '4. 该收尾时把 `update_goal` 标完成，并给出一页「做了什么 / 待你确认」的清单。',
    '',
    '注意：这条消息由插件注入，不是用户需求的一部分。',
  ].join('\n')
}
