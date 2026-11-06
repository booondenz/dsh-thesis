/**
 * 图的「结构化规格」：模型只需描述**有什么**，不描述**放在哪**。
 *
 * 教学场景里的图之所以糙，多半不是因为画得少，而是因为让模型直接写坐标：
 * 节点一多就重叠、箭头乱穿、字号忽大忽小。于是这里把输入收窄成业务语义
 * （层与模块、步骤与分支、实体与字段、参与者与消息），坐标交给
 * `layout.ts` 的确定性版面算法——同样的输入永远得到同一张图。
 *
 * 解析是**严格**的：字段缺失、引用不存在的节点、重名，全部当场报错并给出示例，
 * 绝不让一张「少了两个模块」的图静默落盘。
 *
 * @module dsh-thesis/figure/spec
 */

/** 支持的图种类。 */
export type FigureKind = 'architecture' | 'flow' | 'er' | 'sequence' | 'custom'

/** 全部种类的取值（用于工具参数的枚举与报错提示）。 */
export const FIGURE_KINDS: readonly FigureKind[] = ['architecture', 'flow', 'er', 'sequence', 'custom']

/** 规格非法：带上**怎么改**的提示，模型据此重试。 */
export class FigureSpecError extends Error {
  readonly code = 'INVALID_FIGURE_SPEC'
  constructor(message: string) {
    super(message)
    this.name = 'FigureSpecError'
  }
}

// ---------------------------------------------------------------------------
// 规范化后的模型
// ---------------------------------------------------------------------------

export interface ArchModule {
  readonly text: string
  readonly note?: string
  readonly accent?: boolean
}

export interface ArchLayer {
  readonly name: string
  readonly note?: string
  readonly modules: readonly ArchModule[]
}

export interface ArchEdge {
  readonly from: string
  readonly to: string
  readonly label?: string
}

export interface ArchitectureModel {
  readonly layers: readonly ArchLayer[]
  readonly edges: readonly ArchEdge[]
}

export type FlowNodeKind = 'start' | 'process' | 'decision' | 'end'

export interface FlowNode {
  readonly id: string
  readonly text: string
  readonly note?: string
  readonly kind: FlowNodeKind
}

export interface FlowEdge {
  readonly from: string
  readonly to: string
  readonly label?: string
}

export interface FlowModel {
  readonly nodes: readonly FlowNode[]
  readonly edges: readonly FlowEdge[]
}

export interface ErField {
  readonly name: string
  readonly type?: string
  readonly key?: boolean
}

export interface ErEntity {
  readonly name: string
  readonly fields: readonly ErField[]
}

export interface ErRelation {
  readonly from: string
  readonly to: string
  readonly label?: string
  readonly cardinality?: string
}

export interface ErModel {
  readonly entities: readonly ErEntity[]
  readonly relations: readonly ErRelation[]
}

export interface SeqParticipant {
  readonly id: string
  readonly text: string
}

export type SeqMessageKind = 'call' | 'return'

export interface SeqMessage {
  readonly from: string
  readonly to: string
  readonly text: string
  readonly kind: SeqMessageKind
}

export interface SequenceModel {
  readonly participants: readonly SeqParticipant[]
  readonly messages: readonly SeqMessage[]
}

export interface CustomModel {
  readonly xml: string
}

export type FigureModel =
  | { readonly kind: 'architecture'; readonly model: ArchitectureModel }
  | { readonly kind: 'flow'; readonly model: FlowModel }
  | { readonly kind: 'er'; readonly model: ErModel }
  | { readonly kind: 'sequence'; readonly model: SequenceModel }
  | { readonly kind: 'custom'; readonly model: CustomModel }

// ---------------------------------------------------------------------------
// 校验小工具
// ---------------------------------------------------------------------------

function fail(message: string): never {
  throw new FigureSpecError(message)
}

function asRecord(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${path} 必须是对象，实际是 ${value === null ? 'null' : Array.isArray(value) ? '数组' : typeof value}`)
  }
  return value as Record<string, unknown>
}

function asArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) fail(`${path} 必须是数组`)
  return value
}

function requiredText(value: unknown, path: string): string {
  if (typeof value !== 'string') fail(`${path} 必须是字符串`)
  const text = value.trim()
  if (text === '') fail(`${path} 不能为空`)
  return text
}

function optionalText(value: unknown, path: string): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') fail(`${path} 必须是字符串`)
  const text = value.trim()
  return text === '' ? undefined : text
}

function optionalBool(value: unknown, path: string): boolean | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'boolean') fail(`${path} 必须是布尔值`)
  return value
}

/** 一个引用（边/关系）的解析表：同时接受 id 与显示文本。 */
function makeResolver(entries: readonly { readonly id: string; readonly text: string }[], path: string): (name: string) => string {
  const byId = new Map<string, string>()
  const byText = new Map<string, string>()
  for (const entry of entries) {
    if (byId.has(entry.id)) fail(`${path} 里 id「${entry.id}」重复`)
    byId.set(entry.id, entry.id)
    byText.set(entry.text, entry.id)
  }
  return (name: string): string => {
    const id = byId.get(name) ?? byText.get(name)
    if (id === undefined) {
      const known = [...byId.keys()].join('、')
      fail(`${path} 引用了不存在的节点「${name}」；可用的是：${known}`)
    }
    return id
  }
}

// ---------------------------------------------------------------------------
// 各类型的解析
// ---------------------------------------------------------------------------

const ARCH_EXAMPLE = '{"layers":[{"name":"表现层","modules":["Vue 页面","路由与状态"]},{"name":"业务层","modules":["任务服务","用户服务"]}],"edges":[{"from":"Vue 页面","to":"任务服务","label":"HTTP/JSON"}]}'

function parseArchitecture(raw: unknown): ArchitectureModel {
  const record = asRecord(raw, 'architecture 的 spec')
  const layersRaw = asArray(record.layers, 'architecture.layers（不能为空）')
  if (layersRaw.length === 0) fail(`architecture.layers 不能为空，示例：${ARCH_EXAMPLE}`)

  const layers: ArchLayer[] = layersRaw.map((layerRaw, index) => {
    const path = `architecture.layers[${index}]`
    const layer = asRecord(layerRaw, path)
    const name = requiredText(layer.name, `${path}.name`)
    const note = optionalText(layer.note, `${path}.note`)
    const modulesRaw = asArray(layer.modules, `${path}.modules（每层至少一个模块）`)
    if (modulesRaw.length === 0) fail(`${path}.modules 不能为空：每一层至少要有一个模块`)
    const modules: ArchModule[] = modulesRaw.map((moduleRaw, moduleIndex) => {
      const modulePath = `${path}.modules[${moduleIndex}]`
      if (typeof moduleRaw === 'string') return { text: requiredText(moduleRaw, modulePath) }
      const module = asRecord(moduleRaw, modulePath)
      const text = requiredText(module.text, `${modulePath}.text`)
      const moduleNote = optionalText(module.note, `${modulePath}.note`)
      const accent = optionalBool(module.accent, `${modulePath}.accent`)
      return { text, ...(moduleNote !== undefined ? { note: moduleNote } : {}), ...(accent === true ? { accent: true } : {}) }
    })
    return { name, ...(note !== undefined ? { note } : {}), modules }
  })

  // 模块名在全图内必须唯一：边用名字引用节点，重名就无法判断指向哪一个。
  // 层名同理：连通向层带的默认箭头也靠名字找终点。
  const layerNames = new Set<string>()
  for (const layer of layers) {
    if (layerNames.has(layer.name)) fail(`architecture 里层名「${layer.name}」重复：层名用于连线引用，必须唯一。`)
    layerNames.add(layer.name)
  }
  const seen = new Map<string, string>()
  for (const layer of layers) {
    for (const module of layer.modules) {
      const previous = seen.get(module.text)
      if (previous !== undefined) {
        fail(`architecture 里模块名「${module.text}」重复（分别在「${previous}」与「${layer.name}」）。边用名字引用节点，模块名必须全图唯一。`)
      }
      seen.set(module.text, layer.name)
    }
  }

  const targets = [
    ...layers.map(layer => ({ id: layer.name, text: layer.name })),
    ...layers.flatMap(layer => layer.modules.map(module => ({ id: module.text, text: module.text }))),
  ]
  const resolve = makeResolver(targets, 'architecture.edges')

  const edgesRaw = record.edges === undefined ? [] : asArray(record.edges, 'architecture.edges')
  const edges: ArchEdge[] = edgesRaw.map((edgeRaw, index) => {
    const path = `architecture.edges[${index}]`
    const edge = asRecord(edgeRaw, path)
    const from = resolve(requiredText(edge.from, `${path}.from`))
    const to = resolve(requiredText(edge.to, `${path}.to`))
    if (from === to) fail(`${path} 的 from 与 to 相同（「${from}」），图里不允许自环`)
    const label = optionalText(edge.label, `${path}.label`)
    return { from, to, ...(label !== undefined ? { label } : {}) }
  })

  return { layers, edges }
}

const FLOW_EXAMPLE = '{"nodes":[{"id":"start","text":"提交申请","kind":"start"},{"id":"check","text":"参数合法?","kind":"decision"},{"id":"save","text":"写入数据库","kind":"process"}],"edges":[{"from":"start","to":"check"},{"from":"check","to":"save","label":"是"}]}'

function parseFlow(raw: unknown): FlowModel {
  const record = asRecord(raw, 'flow 的 spec')
  const nodesRaw = asArray(record.nodes, 'flow.nodes（不能为空）')
  if (nodesRaw.length === 0) fail(`flow.nodes 不能为空，示例：${FLOW_EXAMPLE}`)

  const nodes: FlowNode[] = nodesRaw.map((nodeRaw, index) => {
    const path = `flow.nodes[${index}]`
    const node = asRecord(nodeRaw, path)
    const id = optionalText(node.id, `${path}.id`) ?? `n${index + 1}`
    const text = requiredText(node.text, `${path}.text`)
    const note = optionalText(node.note, `${path}.note`)
    const kindRaw = optionalText(node.kind, `${path}.kind`) ?? 'process'
    if (kindRaw !== 'start' && kindRaw !== 'process' && kindRaw !== 'decision' && kindRaw !== 'end') {
      fail(`${path}.kind 只能是 start / process / decision / end，实际是「${kindRaw}」`)
    }
    return { id, text, kind: kindRaw, ...(note !== undefined ? { note } : {}) }
  })
  if (nodes.filter(node => node.kind === 'start').length === 0) {
    fail('flow 至少需要一个 kind="start" 的节点（流程从哪开始必须说清楚）')
  }

  const resolve = makeResolver(nodes.map(node => ({ id: node.id, text: node.text })), 'flow.edges')
  const edgesRaw = asArray(record.edges, 'flow.edges（没有连线的流程无法成图）')
  if (edgesRaw.length === 0) fail('flow.edges 不能为空：至少要把起点连到下一个节点')
  const edges: FlowEdge[] = edgesRaw.map((edgeRaw, index) => {
    const path = `flow.edges[${index}]`
    const edge = asRecord(edgeRaw, path)
    const from = resolve(requiredText(edge.from, `${path}.from`))
    const to = resolve(requiredText(edge.to, `${path}.to`))
    if (from === to) fail(`${path} 的 from 与 to 相同（「${from}」），图里不允许自环`)
    const label = optionalText(edge.label, `${path}.label`)
    return { from, to, ...(label !== undefined ? { label } : {}) }
  })

  return { nodes, edges }
}

const ER_EXAMPLE = '{"entities":[{"name":"用户","fields":[{"name":"id","type":"bigint","key":true},{"name":"用户名","type":"varchar(32)"}]},{"name":"任务","fields":[{"name":"id","type":"bigint","key":true},{"name":"标题","type":"varchar(64)"}]}],"relations":[{"from":"用户","to":"任务","label":"创建","cardinality":"1:N"}]}'

function parseEr(raw: unknown): ErModel {
  const record = asRecord(raw, 'er 的 spec')
  const entitiesRaw = asArray(record.entities, 'er.entities（不能为空）')
  if (entitiesRaw.length === 0) fail(`er.entities 不能为空，示例：${ER_EXAMPLE}`)

  const entities: ErEntity[] = entitiesRaw.map((entityRaw, index) => {
    const path = `er.entities[${index}]`
    const entity = asRecord(entityRaw, path)
    const name = requiredText(entity.name, `${path}.name`)
    const fieldsRaw = asArray(entity.fields, `${path}.fields（每个实体至少一个字段）`)
    if (fieldsRaw.length === 0) fail(`${path}.fields 不能为空：实体「${name}」至少要有一个字段`)
    const fields: ErField[] = fieldsRaw.map((fieldRaw, fieldIndex) => {
      const fieldPath = `${path}.fields[${fieldIndex}]`
      const field = asRecord(fieldRaw, fieldPath)
      const fieldName = requiredText(field.name, `${fieldPath}.name`)
      const type = optionalText(field.type, `${fieldPath}.type`)
      const key = optionalBool(field.key, `${fieldPath}.key`)
      return { name: fieldName, ...(type !== undefined ? { type } : {}), ...(key === true ? { key: true } : {}) }
    })
    return { name, fields }
  })

  const resolve = makeResolver(entities.map(entity => ({ id: entity.name, text: entity.name })), 'er.relations')
  const relationsRaw = record.relations === undefined ? [] : asArray(record.relations, 'er.relations')
  const relations: ErRelation[] = relationsRaw.map((relationRaw, index) => {
    const path = `er.relations[${index}]`
    const relation = asRecord(relationRaw, path)
    const from = resolve(requiredText(relation.from, `${path}.from`))
    const to = resolve(requiredText(relation.to, `${path}.to`))
    if (from === to) fail(`${path} 的 from 与 to 相同（「${from}」），图里不允许自环`)
    const label = optionalText(relation.label, `${path}.label`)
    const cardinality = optionalText(relation.cardinality, `${path}.cardinality`)
    if (cardinality !== undefined && !/^[1NnMm]\s*[:：]\s*[1NnMm]$/.test(cardinality)) {
      fail(`${path}.cardinality 只能写成 1:1 / 1:N / N:1 / M:N，实际是「${cardinality}」`)
    }
    return { from, to, ...(label !== undefined ? { label } : {}), ...(cardinality !== undefined ? { cardinality } : {}) }
  })

  return { entities, relations }
}

const SEQ_EXAMPLE = '{"participants":["浏览器","Web 服务","MySQL"],"messages":[{"from":"浏览器","to":"Web 服务","text":"POST /api/tasks"},{"from":"Web 服务","to":"MySQL","text":"INSERT"},{"from":"MySQL","to":"Web 服务","text":"ok","kind":"return"}]}'

function parseSequence(raw: unknown): SequenceModel {
  const record = asRecord(raw, 'sequence 的 spec')
  const participantsRaw = asArray(record.participants, 'sequence.participants（不能为空）')
  if (participantsRaw.length < 2) fail(`sequence.participants 至少要有两个参与者，示例：${SEQ_EXAMPLE}`)
  const participants: SeqParticipant[] = participantsRaw.map((participantRaw, index) => {
    const path = `sequence.participants[${index}]`
    if (typeof participantRaw === 'string') {
      const text = requiredText(participantRaw, path)
      return { id: text, text }
    }
    const participant = asRecord(participantRaw, path)
    const text = requiredText(participant.text, `${path}.text`)
    const id = optionalText(participant.id, `${path}.id`) ?? text
    return { id, text }
  })
  const resolve = makeResolver(participants, 'sequence.messages')

  const messagesRaw = asArray(record.messages, 'sequence.messages（不能为空）')
  if (messagesRaw.length === 0) fail(`sequence.messages 不能为空，示例：${SEQ_EXAMPLE}`)
  const messages: SeqMessage[] = messagesRaw.map((messageRaw, index) => {
    const path = `sequence.messages[${index}]`
    const message = asRecord(messageRaw, path)
    const from = resolve(requiredText(message.from, `${path}.from`))
    const to = resolve(requiredText(message.to, `${path}.to`))
    const text = requiredText(message.text, `${path}.text`)
    const kindRaw = optionalText(message.kind, `${path}.kind`) ?? 'call'
    if (kindRaw !== 'call' && kindRaw !== 'return') fail(`${path}.kind 只能是 call / return，实际是「${kindRaw}」`)
    return { from, to, text, kind: kindRaw }
  })

  return { participants, messages }
}

function parseCustom(raw: unknown): CustomModel {
  const record = asRecord(raw, 'custom 的 spec')
  const xml = requiredText(record.xml, 'custom.xml（draw.io 文件全文）')
  return { xml }
}

/** 解析并校验规格；成功时返回规范化模型，失败时抛 {@link FigureSpecError}。 */
export function parseFigureModel(kind: string, raw: unknown): FigureModel {
  if (raw === undefined || raw === null) {
    fail(`缺少 spec：${kind} 图需要结构化规格，另可用 thesis_figure action=create 的示例参数。`)
  }
  switch (kind) {
    case 'architecture': return { kind, model: parseArchitecture(raw) }
    case 'flow': return { kind, model: parseFlow(raw) }
    case 'er': return { kind, model: parseEr(raw) }
    case 'sequence': return { kind, model: parseSequence(raw) }
    case 'custom': return { kind, model: parseCustom(raw) }
    default:
      fail(`未知图种类「${kind}」，可选：${FIGURE_KINDS.join(' / ')}`)
  }
}

/** 一句话概括模型规模（工具返回值里给模型看，确认自己传对了）。 */
export function describeModel(model: FigureModel): string {
  switch (model.kind) {
    case 'architecture':
      return `${model.model.layers.length} 层 / ${model.model.layers.reduce((sum, layer) => sum + layer.modules.length, 0)} 个模块 / ${model.model.edges.length} 条连线`
    case 'flow': return `${model.model.nodes.length} 个节点 / ${model.model.edges.length} 条连线`
    case 'er': return `${model.model.entities.length} 个实体 / ${model.model.relations.length} 条关系`
    case 'sequence': return `${model.model.participants.length} 个参与者 / ${model.model.messages.length} 条消息`
    case 'custom': return `手写 mxfile（${model.model.xml.length} 字符）`
  }
}
