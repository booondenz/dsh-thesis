/**
 * 版面算法：把规范化模型排成**确定的坐标**。
 *
 * 这里是「图不糙」的关键。四种图的版面规则都很朴素，但足以覆盖本科毕设的绝大多数插图，
 * 而且每条规则都可解释、可测试：
 *
 * - 架构图：层是横向色带，模块在层内按行排布（每行最多 4 个），层与层之间留出箭头的通道；
 * - 流程图：按「最长路径」分层（Kahn 拓扑序），起点在上、终点在下，同级节点横向均分；
 * - E-R 图：实体是表格式图元（标题栏 + 字段行），两列摆放，关系线带基数标注；
 * - 时序图：参与者等距排开，生命线用 draw.io 自带形状，消息按时间从上往下逐行。
 *
 * 所有尺寸都是常量（见 {@link LAYOUT}），没有随机、没有外部依赖，同一份规格永远得到
 * 同一张图——这样它才能被测试，也才能在 diff 里被审阅。
 *
 * @module dsh-thesis/figure/layout
 */

import { STYLE, type FigureCell, type Rect } from './drawio.ts'
import type { FigureModel, FlowEdge } from './spec.ts'

/** 版面常量（单位与 draw.io 一致；A4 纵向页宽 827）。 */
export const LAYOUT = {
  margin: 26,
  /** 内容区宽度上限：A4 纵向、2.54cm 页边距下正文宽约 790，留出导出边距。 */
  contentWidth: 740,
  arch: {
    labelWidth: 96,
    moduleWidth: 140,
    moduleHeight: 50,
    gapX: 16,
    gapY: 16,
    bandPadding: 12,
    bandGap: 42,
  },
  flow: {
    nodeWidth: 176,
    nodeHeight: 54,
    decisionWidth: 150,
    decisionHeight: 86,
    gapX: 36,
    gapY: 48,
  },
  er: {
    columnGap: 96,
    rowGap: 34,
    titleHeight: 30,
    rowHeight: 22,
    bottomPadding: 6,
    minWidth: 156,
    maxWidth: 300,
  },
  sequence: {
    spacing: 170,
    minSpacing: 118,
    boxWidth: 132,
    header: 68,
    messageGap: 46,
    tail: 24,
  },
} as const

/** 版面错误（如流程有环）：与规格错误区分开，调用方都按「生成失败」处理。 */
export class FigureLayoutError extends Error {
  readonly code = 'INVALID_FIGURE_LAYOUT'
  constructor(message: string) {
    super(message)
    this.name = 'FigureLayoutError'
  }
}

/** 一张图的版面结果。 */
export interface FigureDrawing {
  /** 全部图元（custom 图为空——它自带 XML）。 */
  readonly cells: readonly FigureCell[]
  /** 内容宽（导出裁剪后的宽度约等于它）。 */
  readonly width: number
  /** 内容高。 */
  readonly height: number
  /** 排版过程中的提示（不算错误，例如模块被自动换行）。 */
  readonly notes: readonly string[]
}

/** 中文按整字宽、西文按半字宽估算文本像素宽（用于 ER 实体自适应宽度）。 */
export function displayWidth(text: string, fontSize = 12): number {
  let width = 0
  for (const char of text) {
    width += /[\u2e80-\u9fff\uff00-\uffef]/.test(char) ? fontSize : fontSize * 0.56
  }
  return Math.round(width)
}

/** 逐层累进 id，保证同一张图里的 id 唯一且稳定。 */
function idCounter(prefix: string): (hint?: string) => string {
  let next = 0
  return (hint?: string): string => {
    next += 1
    return hint === undefined ? `${prefix}${next}` : `${prefix}${next}-${hint}`
  }
}

// ---------------------------------------------------------------------------
// 架构图
// ---------------------------------------------------------------------------

function buildArchitecture(model: Extract<FigureModel, { kind: 'architecture' }>['model']): FigureDrawing {
  const cfg = LAYOUT.arch
  const notes: string[] = []
  const cells: FigureCell[] = []
  const nextVertex = idCounter('v')
  const nextEdge = idCounter('e')

  const moduleAreaWidth = LAYOUT.contentWidth - cfg.labelWidth - cfg.bandPadding * 2
  const perRow = Math.max(1, Math.floor((moduleAreaWidth + cfg.gapX) / (cfg.moduleWidth + cfg.gapX)))
  const bandWidth = LAYOUT.contentWidth

  const bandIds = new Map<string, string>()
  const moduleIds = new Map<string, string>()
  let y = LAYOUT.margin

  for (const layer of model.layers) {
    const rows = Math.ceil(layer.modules.length / perRow)
    if (rows > 1) notes.push(`「${layer.name}」有 ${layer.modules.length} 个模块，超过每行 ${perRow} 个，自动折成 ${rows} 行`)
    const bandHeight = rows * cfg.moduleHeight + (rows - 1) * cfg.gapY + cfg.bandPadding * 2

    const bandId = nextVertex('band')
    bandIds.set(layer.name, bandId)
    cells.push({
      kind: 'vertex',
      id: bandId,
      value: '',
      style: STYLE.layerBand,
      rect: { x: LAYOUT.margin, y, width: bandWidth, height: bandHeight },
    })

    const labelId = nextVertex('label')
    cells.push({
      kind: 'vertex',
      id: labelId,
      value: layer.note === undefined ? layer.name : `${layer.name}\n${layer.note}`,
      style: STYLE.layerLabel,
      rect: { x: LAYOUT.margin, y, width: cfg.labelWidth, height: bandHeight },
    })

    layer.modules.forEach((module, index) => {
      const row = Math.floor(index / perRow)
      const col = index % perRow
      const moduleId = nextVertex('box')
      moduleIds.set(module.text, moduleId)
      const rect: Rect = {
        x: LAYOUT.margin + cfg.labelWidth + cfg.bandPadding + col * (cfg.moduleWidth + cfg.gapX),
        y: y + cfg.bandPadding + row * (cfg.moduleHeight + cfg.gapY),
        width: cfg.moduleWidth,
        height: cfg.moduleHeight,
      }
      cells.push({
        kind: 'vertex',
        id: moduleId,
        value: module.note === undefined ? module.text : `${module.text}\n${module.note}`,
        style: module.accent === true ? STYLE.moduleAccent : STYLE.module,
        rect,
      })
    })

    y += bandHeight + cfg.bandGap
  }

  const height = y - cfg.bandGap + LAYOUT.margin
  const centerX = LAYOUT.margin + cfg.labelWidth + (bandWidth - cfg.labelWidth) / 2

  if (model.edges.length === 0) {
    // 没有指名连线时，画「层 → 层」的默认调用箭头：分层架构的读法就是从上层到下层。
    for (let index = 0; index < model.layers.length - 1; index += 1) {
      const from = bandIds.get(model.layers[index]!.name)
      const to = bandIds.get(model.layers[index + 1]!.name)
      if (from === undefined || to === undefined) continue
      cells.push({
        kind: 'edge',
        id: nextEdge(),
        value: '',
        style: `${STYLE.edge}exitX=${(centerX - LAYOUT.margin) / bandWidth};exitY=1;entryX=${(centerX - LAYOUT.margin) / bandWidth};entryY=0;`,
        source: from,
        target: to,
      })
    }
  } else {
    for (const edge of model.edges) {
      const from = moduleIds.get(edge.from) ?? bandIds.get(edge.from)
      const to = moduleIds.get(edge.to) ?? bandIds.get(edge.to)
      if (from === undefined || to === undefined) throw new FigureLayoutError(`连线端点「${edge.from} → ${edge.to}」在版面里找不到`)
      cells.push({
        kind: 'edge',
        id: nextEdge(),
        value: edge.label ?? '',
        style: STYLE.edge,
        source: from,
        target: to,
      })
    }
  }

  return { cells, width: LAYOUT.contentWidth + LAYOUT.margin * 2, height, notes }
}

// ---------------------------------------------------------------------------
// 流程图
// ---------------------------------------------------------------------------

/** Kahn 拓扑序 + 最长路径分层；有环时抛错（流程图不允许环）。 */
function rankFlow(model: Extract<FigureModel, { kind: 'flow' }>['model']): Map<string, number> {
  const incoming = new Map<string, string[]>(model.nodes.map(node => [node.id, []]))
  const outgoing = new Map<string, string[]>(model.nodes.map(node => [node.id, []]))
  for (const edge of model.edges) {
    incoming.get(edge.to)?.push(edge.from)
    outgoing.get(edge.from)?.push(edge.to)
  }

  const inDegree = new Map<string, number>(model.nodes.map(node => [node.id, (incoming.get(node.id) ?? []).length]))
  const queue = model.nodes.filter(node => inDegree.get(node.id) === 0).map(node => node.id)
  const order: string[] = []
  while (queue.length > 0) {
    const id = queue.shift()!
    order.push(id)
    for (const next of outgoing.get(id) ?? []) {
      const remaining = (inDegree.get(next) ?? 0) - 1
      inDegree.set(next, remaining)
      if (remaining === 0) queue.push(next)
    }
  }
  if (order.length !== model.nodes.length) {
    const stuck = model.nodes.filter(node => (inDegree.get(node.id) ?? 0) > 0).map(node => node.text)
    throw new FigureLayoutError(`流程图存在环（${stuck.join(' → ')} 之间互相指回）。请拆掉回边，或用「返回上一步」之类的节点替代。`)
  }

  const rank = new Map<string, number>(model.nodes.map(node => [node.id, 0]))
  for (const id of order) {
    for (const next of outgoing.get(id) ?? []) {
      rank.set(next, Math.max(rank.get(next) ?? 0, (rank.get(id) ?? 0) + 1))
    }
  }
  return rank
}

/**
 * 主干路径：从 start 出发，每一步优先走「非否」的分支。
 *
 * 为什么需要它：如果每一层都把节点均匀铺开，判断节点的「是」分支会被挤到一边，
 * 整张流程图的阅读主线变成一条斜线。把主干固定在竖直中线上、把「否/失败」分支摆到
 * 右侧，才是教材里常见、也最好讲的那种流程图。
 */
function flowMainPath(model: Extract<FigureModel, { kind: 'flow' }>['model']): Set<string> {
  const byId = new Map(model.nodes.map(node => [node.id, node]))
  const outgoing = new Map<string, FlowEdge[]>()
  for (const edge of model.edges) {
    const bucket = outgoing.get(edge.from) ?? []
    bucket.push(edge)
    outgoing.set(edge.from, bucket)
  }
  const incomingCount = new Map<string, number>(model.nodes.map(node => [node.id, 0]))
  for (const edge of model.edges) incomingCount.set(edge.to, (incomingCount.get(edge.to) ?? 0) + 1)

  const start = model.nodes.find(node => node.kind === 'start')
    ?? model.nodes.find(node => (incomingCount.get(node.id) ?? 0) === 0)
    ?? model.nodes[0]
  const path = new Set<string>()
  let current = start
  while (current !== undefined && !path.has(current.id)) {
    path.add(current.id)
    const outs = outgoing.get(current.id) ?? []
    if (outs.length === 0) break
    const preferred = outs.find(edge => !/^(否|不通过|失败|错误|no|n|false)$/i.test((edge.label ?? '').trim())) ?? outs[0]
    current = preferred === undefined ? undefined : byId.get(preferred.to)
  }
  return path
}

function buildFlow(model: Extract<FigureModel, { kind: 'flow' }>['model']): FigureDrawing {
  const cfg = LAYOUT.flow
  const notes: string[] = []
  const cells: FigureCell[] = []
  const nextVertex = idCounter('v')
  const nextEdge = idCounter('e')
  const rank = rankFlow(model)
  const mainPath = flowMainPath(model)

  const rows = new Map<number, typeof model.nodes[number][]>()
  for (const node of model.nodes) {
    const row = rank.get(node.id) ?? 0
    const bucket = rows.get(row) ?? []
    bucket.push(node)
    rows.set(row, bucket)
  }

  const rowRanks = [...rows.keys()].sort((a, b) => a - b)
  const nodeWidthOf = (node: { kind: string }): number => (node.kind === 'decision' ? cfg.decisionWidth : cfg.nodeWidth)
  const nodeHeightOf = (node: { kind: string }): number => (node.kind === 'decision' ? cfg.decisionHeight : cfg.nodeHeight)

  // 先以「中轴 x=0」排布，最后整体平移：主干节点落在中轴上，其它节点摆在它右侧。
  const nodeIds = new Map<string, string>()
  const positions = new Map<string, Rect>()
  let minX = 0
  let maxX = 0
  rowRanks.forEach((rankNo, rowIndex) => {
    const nodes = rows.get(rankNo) ?? []
    const rowY = LAYOUT.margin + rowIndex * (cfg.nodeHeight + cfg.gapY)
    if (nodes.length > 1) notes.push(`第 ${rankNo + 1} 层有 ${nodes.length} 个并行节点（${nodes.map(n => n.text).join('、')}）`)
    const main = nodes.find(node => mainPath.has(node.id))
    const mainWidth = main === undefined ? 0 : nodeWidthOf(main)
    const others = nodes.filter(node => node !== main)
    const othersWidth = others.reduce((sum, node) => sum + nodeWidthOf(node), 0) + Math.max(0, others.length - 1) * cfg.gapX
    const rowWidth = mainWidth + (main !== undefined && others.length > 0 ? cfg.gapX : 0) + othersWidth
    let cursor = main === undefined ? -rowWidth / 2 : -mainWidth / 2
    if (main !== undefined) {
      const nodeWidth = nodeWidthOf(main)
      const nodeHeight = nodeHeightOf(main)
      const rect: Rect = { x: cursor, y: rowY + (cfg.nodeHeight - nodeHeight) / 2, width: nodeWidth, height: nodeHeight }
      positions.set(main.id, rect)
      cursor += nodeWidth + cfg.gapX
    } else {
      cursor = -rowWidth / 2
    }
    for (const node of others) {
      const nodeWidth = nodeWidthOf(node)
      const nodeHeight = nodeHeightOf(node)
      positions.set(node.id, { x: cursor, y: rowY + (cfg.nodeHeight - nodeHeight) / 2, width: nodeWidth, height: nodeHeight })
      cursor += nodeWidth + cfg.gapX
    }
  })
  for (const rect of positions.values()) {
    minX = Math.min(minX, rect.x)
    maxX = Math.max(maxX, rect.x + rect.width)
  }
  const width = Math.max(460, maxX - minX + LAYOUT.margin * 2)
  const shift = LAYOUT.margin - minX
  for (const [id, rect] of positions) {
    positions.set(id, { ...rect, x: rect.x + shift })
  }

  for (const node of model.nodes) {
    const rect = positions.get(node.id)
    if (rect === undefined) continue
    const id = nextVertex('node')
    nodeIds.set(node.id, id)
    const style = node.kind === 'start' ? STYLE.start : node.kind === 'end' ? STYLE.end : node.kind === 'decision' ? STYLE.decision : STYLE.module
    cells.push({
      kind: 'vertex',
      id,
      value: node.note === undefined ? node.text : `${node.text}\n${node.note}`,
      style,
      rect,
    })
  }

  for (const edge of model.edges) {
    const source = nodeIds.get(edge.from)
    const target = nodeIds.get(edge.to)
    if (source === undefined || target === undefined) throw new FigureLayoutError(`连线端点「${edge.from} → ${edge.to}」在版面里找不到`)
    const fromRect = positions.get(edge.from)
    const toRect = positions.get(edge.to)
    const horizontal = fromRect !== undefined && toRect !== undefined && Math.abs(fromRect.y - toRect.y) < 1
    cells.push({
      kind: 'edge',
      id: nextEdge(),
      value: edge.label ?? '',
      style: horizontal
        ? `${STYLE.edge}exitX=1;exitY=0.5;entryX=0;entryY=0.5;`
        : `${STYLE.edge}exitX=0.5;exitY=1;entryX=0.5;entryY=0;`,
      source,
      target,
    })
  }

  const height = LAYOUT.margin + rowRanks.length * (cfg.nodeHeight + cfg.gapY) - cfg.gapY + LAYOUT.margin
  return { cells, width, height, notes }
}

// ---------------------------------------------------------------------------
// E-R 图
// ---------------------------------------------------------------------------

function buildEr(model: Extract<FigureModel, { kind: 'er' }>['model']): FigureDrawing {
  const cfg = LAYOUT.er
  const cells: FigureCell[] = []
  const notes: string[] = []
  const nextVertex = idCounter('v')
  const nextEdge = idCounter('e')

  const entityWidth = new Map<string, number>()
  for (const entity of model.entities) {
    const titleWidth = displayWidth(entity.name, 12) + 28
    const fieldWidth = Math.max(...entity.fields.map(field => displayWidth(`${field.key === true ? 'PK ' : ''}${field.name}${field.type === undefined ? '' : ` : ${field.type}`}`, 11) + 24))
    const width = Math.min(cfg.maxWidth, Math.max(cfg.minWidth, titleWidth, fieldWidth))
    entityWidth.set(entity.name, width)
  }
  const maxWidth = Math.max(...entityWidth.values())
  const columns = model.entities.length > 1 ? 2 : 1
  const width = LAYOUT.margin * 2 + maxWidth * columns + (columns - 1) * cfg.columnGap

  const entityIds = new Map<string, string>()
  const columnY = new Array<number>(columns).fill(LAYOUT.margin)
  model.entities.forEach((entity, index) => {
    const column = index % columns
    const widthForEntity = entityWidth.get(entity.name) ?? cfg.minWidth
    const height = cfg.titleHeight + entity.fields.length * cfg.rowHeight + cfg.bottomPadding
    const x = LAYOUT.margin + column * (maxWidth + cfg.columnGap)
    const y = columnY[column] ?? LAYOUT.margin

    const id = nextVertex('entity')
    entityIds.set(entity.name, id)
    // 不可见的容器先画（在下层）：关系线连到整张表，而不是某一行；
    // 先入队保证它垫在标题与字段下面，不遮挡文字与点击。
    cells.push({
      kind: 'vertex',
      id,
      value: '',
      style: 'rounded=0;whiteSpace=wrap;html=1;fillColor=none;strokeColor=none;',
      rect: { x, y, width: widthForEntity, height },
    })
    cells.push({
      kind: 'vertex',
      id: `${id}-title`,
      value: entity.name,
      style: STYLE.entityTitle,
      rect: { x, y, width: widthForEntity, height: cfg.titleHeight },
    })
    entity.fields.forEach((field, fieldIndex) => {
      const parts = [`${field.key === true ? 'PK  ' : ''}${field.name}`]
      if (field.type !== undefined) parts.push(field.type)
      cells.push({
        kind: 'vertex',
        id: `${id}-f${fieldIndex + 1}`,
        value: parts.join('  '),
        style: STYLE.entityRow,
        rect: { x, y: y + cfg.titleHeight + fieldIndex * cfg.rowHeight, width: widthForEntity, height: cfg.rowHeight },
      })
    })
    columnY[column] = y + height + cfg.rowGap
  })

  for (const relation of model.relations) {
    const source = entityIds.get(relation.from)
    const target = entityIds.get(relation.to)
    if (source === undefined || target === undefined) throw new FigureLayoutError(`关系端点「${relation.from} → ${relation.to}」在版面里找不到`)
    const label = [relation.cardinality, relation.label].filter(part => part !== undefined && part !== '').join(' ')
    cells.push({
      kind: 'edge',
      id: nextEdge(),
      value: label,
      style: `${STYLE.edge}endArrow=none;startArrow=none;`,
      source,
      target,
    })
  }

  const height = Math.max(...columnY) - cfg.rowGap + LAYOUT.margin
  return { cells, width, height, notes }
}

// ---------------------------------------------------------------------------
// 时序图
// ---------------------------------------------------------------------------

function buildSequence(model: Extract<FigureModel, { kind: 'sequence' }>['model']): FigureDrawing {
  const cfg = LAYOUT.sequence
  const cells: FigureCell[] = []
  const notes: string[] = []
  const nextVertex = idCounter('v')
  const nextEdge = idCounter('e')

  const count = model.participants.length
  const spacing = count > 1
    ? Math.min(cfg.spacing, Math.max(cfg.minSpacing, Math.floor((LAYOUT.contentWidth - cfg.boxWidth) / (count - 1))))
    : cfg.spacing
  const width = LAYOUT.margin * 2 + cfg.boxWidth + (count - 1) * spacing
  const lifelineHeight = cfg.header + Math.max(1, model.messages.length) * cfg.messageGap + cfg.tail

  const lifelineIds = new Map<string, string>()
  const centers = new Map<string, number>()
  model.participants.forEach((participant, index) => {
    const centerX = LAYOUT.margin + cfg.boxWidth / 2 + index * spacing
    const id = nextVertex('life')
    lifelineIds.set(participant.id, id)
    centers.set(participant.id, centerX)
    cells.push({
      kind: 'vertex',
      id,
      value: participant.text,
      style: STYLE.lifeline,
      rect: { x: centerX - cfg.boxWidth / 2, y: LAYOUT.margin, width: cfg.boxWidth, height: lifelineHeight },
    })
  })

  model.messages.forEach((message, index) => {
    const y = LAYOUT.margin + cfg.header + index * cfg.messageGap
    const source = lifelineIds.get(message.from)
    const target = lifelineIds.get(message.to)
    const fromCenter = centers.get(message.from)
    if (source === undefined || target === undefined || fromCenter === undefined) {
      throw new FigureLayoutError(`消息「${message.text}」的参与者在版面里找不到`)
    }
    const fraction = (y - LAYOUT.margin) / lifelineHeight
    const base = message.kind === 'return' ? STYLE.messageReturn : STYLE.message
    if (message.from === message.to) {
      // 自调用：从生命线右侧绕一个小回环再回来（draw.io 的折点由 Array 提供）。
      const loopX = fromCenter + cfg.boxWidth / 2 + 36
      const returnFraction = (y + 28 - LAYOUT.margin) / lifelineHeight
      cells.push({
        kind: 'edge',
        id: nextEdge(),
        value: message.text,
        style: `${base}exitX=1;exitY=${fraction.toFixed(3)};entryX=1;entryY=${returnFraction.toFixed(3)};`,
        source,
        target,
        points: [{ x: loopX, y }, { x: loopX, y: y + 28 }],
      })
      return
    }
    cells.push({
      kind: 'edge',
      id: nextEdge(),
      value: message.text,
      style: `${base}exitX=0.5;exitY=${fraction.toFixed(3)};entryX=0.5;entryY=${fraction.toFixed(3)};`,
      source,
      target,
    })
  })

  return { cells, width, height: LAYOUT.margin * 2 + lifelineHeight, notes }
}

// ---------------------------------------------------------------------------

/** 按图种类构建版面。 */
export function buildDrawing(model: FigureModel): FigureDrawing {
  switch (model.kind) {
    case 'architecture': return buildArchitecture(model.model)
    case 'flow': return buildFlow(model.model)
    case 'er': return buildEr(model.model)
    case 'sequence': return buildSequence(model.model)
    case 'custom': return { cells: [], width: 0, height: 0, notes: ['custom 图直接使用你提供的 XML，不做版面计算'] }
  }
}
