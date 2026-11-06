/**
 * 插图底层：规格校验 → 版面 → mxfile 渲染。
 *
 * 这些断言都在钉「确定性与可解释性」：同样的规格必须得到同样的图，
 * 排出来的图元必须落在页内、层与层不重叠、有环的流程必须被拒绝。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { escapeXmlAttr, labelValue, renderMxfile, STYLE, validateMxfile, type FigureCell } from '../src/figure/lib/drawio.ts'
import {
  FigureSpecError, describeModel, parseFigureModel,
  type ArchitectureModel, type SequenceModel,
} from '../src/figure/lib/spec.ts'
import { FigureLayoutError, LAYOUT, buildDrawing, displayWidth } from '../src/figure/lib/layout.ts'

// ---------------------------------------------------------------------------
// 转义与渲染
// ---------------------------------------------------------------------------

test('XML 转义：& < > " 全部转义，顺序正确（& 先转）', () => {
  assert.equal(escapeXmlAttr('a & b < c > d "e"'), 'a &amp; b &lt; c &gt; d &quot;e&quot;')
  assert.equal(escapeXmlAttr('&lt;'), '&amp;lt;')
  assert.equal(labelValue('第一行\n第二行'), '第一行&lt;br&gt;第二行')
})

test('渲染 mxfile：结构完整、中文与特殊字符不破坏 XML、时间固定时可复现', () => {
  const cells: FigureCell[] = [
    { kind: 'vertex', id: 'n1', value: '任务 & 用户 <服务>', style: STYLE.module, rect: { x: 10, y: 20, width: 140, height: 50 } },
    { kind: 'edge', id: 'e1', value: '', style: STYLE.edge, source: 'n1', target: 'n1' },
  ]
  const now = new Date('2026-03-01T00:00:00.000Z')
  const xml = renderMxfile({ name: '系统总体架构图', cells, now })
  assert.match(xml, /<mxfile host="dsh-thesis" modified="2026-03-01T00:00:00.000Z"/)
  assert.match(xml, /<diagram id="dsh-thesis-figure" name="系统总体架构图">/)
  assert.match(xml, /<mxCell id="0" \/>/)
  assert.match(xml, /value="任务 &amp; 用户 &lt;服务&gt;"/)
  assert.match(xml, /<mxGeometry x="10" y="20" width="140" height="50" as="geometry" \/>/)
  assert.equal(renderMxfile({ name: 'x', cells, now }), renderMxfile({ name: 'x', cells, now }), '同输入必须字节一致')
})

test('渲染 mxfile：折点用 Array/points 表达', () => {
  const xml = renderMxfile({
    name: 'x',
    cells: [{ kind: 'edge', id: 'e1', value: '', style: STYLE.edge, source: 'a', target: 'b', points: [{ x: 1, y: 2 }, { x: 3, y: 4 }] }],
  })
  assert.match(xml, /<Array as="points"><mxPoint x="1" y="2" \/><mxPoint x="3" y="4" \/><\/Array>/)
})

test('渲染 mxfile：多行标签转成 &lt;br&gt;（draw.io 的 html=1 换行）', () => {
  const xml = renderMxfile({
    name: 'x',
    cells: [{ kind: 'vertex', id: 'n1', value: '第一行\n第二行', style: STYLE.module, rect: { x: 0, y: 0, width: 10, height: 10 } }],
  })
  assert.match(xml, /value="第一行&lt;br&gt;第二行"/)
  assert.doesNotMatch(xml, /value="第一行\n第二行"/)
})

test('custom 图校验：必须是 mxfile + mxGraphModel + root，拒绝 DOCTYPE 与 script', () => {
  assert.equal(validateMxfile('<mxfile><diagram><mxGraphModel><root><mxCell id="0"/></root></mxGraphModel></diagram></mxfile>').ok, true)
  assert.equal(validateMxfile('<svg></svg>').ok, false)
  assert.equal(validateMxfile('<?xml version="1.0"?><!DOCTYPE x><mxfile><mxGraphModel><root/></mxGraphModel></mxfile>').ok, false)
  assert.equal(validateMxfile('<mxfile><mxGraphModel><root><script>1</script></root></mxGraphModel></mxfile>').ok, false)
})

// ---------------------------------------------------------------------------
// 规格校验
// ---------------------------------------------------------------------------

test('architecture：层与模块必填，模块名全图唯一，边只认已存在的节点', () => {
  const model = parseFigureModel('architecture', {
    layers: [
      { name: '表现层', modules: ['Vue 页面', { text: '路由', accent: true }] },
      { name: '数据层', modules: ['MySQL'] },
    ],
    edges: [{ from: 'Vue 页面', to: 'MySQL', label: 'SQL' }],
  })
  assert.equal(model.kind, 'architecture')
  assert.equal(describeModel(model), '2 层 / 3 个模块 / 1 条连线')

  assert.throws(() => parseFigureModel('architecture', { layers: [] }), FigureSpecError)
  assert.throws(() => parseFigureModel('architecture', { layers: [{ name: 'A', modules: [] }] }), /modules 不能为空/)
  assert.throws(() => parseFigureModel('architecture', {
    layers: [{ name: 'A', modules: ['同一模块'] }, { name: 'B', modules: ['同一模块'] }],
  }), /模块名「同一模块」重复/)
  assert.throws(() => parseFigureModel('architecture', {
    layers: [{ name: '同一层', modules: ['X'] }, { name: '同一层', modules: ['Y'] }],
  }), /层名「同一层」重复/)
  assert.throws(() => parseFigureModel('architecture', {
    layers: [{ name: 'A', modules: ['X'] }],
    edges: [{ from: 'X', to: '不存在' }],
  }), /引用了不存在的节点「不存在」/)
})

test('flow：必须有 start、边必须连到节点、kind 只能取四值', () => {
  const model = parseFigureModel('flow', {
    nodes: [
      { id: 's', text: '提交', kind: 'start' },
      { id: 'd', text: '合法?', kind: 'decision' },
      { id: 'e', text: '完成', kind: 'end' },
    ],
    edges: [{ from: 's', to: 'd' }, { from: 'd', to: 'e', label: '是' }],
  })
  assert.equal(model.kind, 'flow')
  assert.throws(() => parseFigureModel('flow', { nodes: [{ text: '没有起点' }], edges: [] }), /至少需要一个 kind="start"/)
  assert.throws(() => parseFigureModel('flow', { nodes: [{ text: 'x', kind: 'start' }], edges: [] }), /edges 不能为空/)
  assert.throws(() => parseFigureModel('flow', {
    nodes: [{ text: 'x', kind: 'start', id: 'x' }],
    edges: [{ from: 'x', to: 'y' }],
  }), /不存在的节点「y」/)
})

test('flow 版面：有环必须被拒绝，而不是画成一张乱网', () => {
  const model = parseFigureModel('flow', {
    nodes: [
      { id: 'a', text: 'A', kind: 'start' },
      { id: 'b', text: 'B' },
    ],
    edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'a' }],
  })
  assert.throws(() => buildDrawing(model), FigureLayoutError)
})

test('er：字段必填、基数写法受限、关系端点必须存在', () => {
  const model = parseFigureModel('er', {
    entities: [
      { name: '用户', fields: [{ name: 'id', type: 'bigint', key: true }, { name: '名字', type: 'varchar(32)' }] },
      { name: '任务', fields: [{ name: 'id', type: 'bigint', key: true }] },
    ],
    relations: [{ from: '用户', to: '任务', label: '创建', cardinality: '1:N' }],
  })
  assert.equal(model.kind, 'er')
  assert.throws(() => parseFigureModel('er', { entities: [{ name: '用户', fields: [] }] }), /至少要有一个字段/)
  assert.throws(() => parseFigureModel('er', {
    entities: [{ name: '用户', fields: [{ name: 'id' }] }],
    relations: [{ from: '用户', to: '用户', cardinality: '1:N' }],
  }), /不允许自环/)
  assert.throws(() => parseFigureModel('er', {
    entities: [{ name: 'A', fields: [{ name: 'id' }] }, { name: 'B', fields: [{ name: 'id' }] }],
    relations: [{ from: 'A', to: 'B', cardinality: '一对多' }],
  }), /cardinality 只能写成/)
})

test('sequence：至少两个参与者，消息必须指向参与者', () => {
  const model = parseFigureModel('sequence', {
    participants: ['浏览器', '服务'],
    messages: [{ from: '浏览器', to: '服务', text: 'GET /tasks' }],
  })
  assert.equal(model.kind, 'sequence')
  assert.throws(() => parseFigureModel('sequence', { participants: ['只有一个'], messages: [] }), /至少要有两个参与者/)
  assert.throws(() => parseFigureModel('sequence', {
    participants: ['A', 'B'],
    messages: [{ from: 'A', to: 'C', text: 'x' }],
  }), /不存在的节点「C」/)
})

test('未知种类与缺失 spec 都给出可读错误', () => {
  assert.throws(() => parseFigureModel('venn', {}), /未知图种类「venn」/)
  assert.throws(() => parseFigureModel('er', undefined), /缺少 spec/)
})

// ---------------------------------------------------------------------------
// 版面
// ---------------------------------------------------------------------------

function rectsOf(cells: readonly FigureCell[]): { x: number; y: number; width: number; height: number }[] {
  return cells.filter(cell => cell.kind === 'vertex').map(cell => (cell as Extract<FigureCell, { kind: 'vertex' }>).rect)
}

test('架构图版面：层带自上而下不重叠，模块落在层带内，层间有默认箭头', () => {
  const model = parseFigureModel('architecture', {
    layers: [
      { name: '前端', modules: ['页面', '路由', '状态'] },
      { name: '后端', modules: ['接口层', '服务层', '数据访问层', '缓存', '任务调度'] },
      { name: '数据', modules: ['MySQL'] },
    ],
  })
  const drawing = buildDrawing(model)
  const bands = drawing.cells.filter(cell => cell.kind === 'vertex' && cell.style === STYLE.layerBand)
  assert.equal(bands.length, 3)
  const ys = bands.map(band => (band as Extract<FigureCell, { kind: 'vertex' }>).rect.y)
  assert.deepEqual([...ys].sort((a, b) => a - b), ys, '层带必须按输入顺序自上而下')
  for (let index = 1; index < bands.length; index += 1) {
    const previous = (bands[index - 1] as Extract<FigureCell, { kind: 'vertex' }>).rect
    const current = (bands[index] as Extract<FigureCell, { kind: 'vertex' }>).rect
    assert.ok(current.y >= previous.y + previous.height, '层带之间不能重叠')
  }
  const firstBand = (bands[0] as Extract<FigureCell, { kind: 'vertex' }>).rect
  for (const rect of rectsOf(drawing.cells)) {
    assert.ok(rect.x >= 0 && rect.y >= 0, '图元不能跑到页面外')
    assert.ok(rect.x + rect.width <= drawing.width, '图元不能超出内容宽')
  }
  const firstBandId = (bands[0] as Extract<FigureCell, { kind: 'vertex' }>).id
  // 图元都挂在根层（绝对坐标）；「在层带里」靠几何位置判断，不靠 cell 嵌套。
  const modulesInFirstBand = drawing.cells.filter((cell): cell is Extract<FigureCell, { kind: 'vertex' }> => {
    if (cell.kind !== 'vertex' || cell.id === firstBandId || cell.style === STYLE.layerLabel) return false
    const rect = cell.rect
    return rect.y >= firstBand.y && rect.y + rect.height <= firstBand.y + firstBand.height
  })
  assert.ok(modulesInFirstBand.length >= 3, '第一层的模块应落在层带内')
  for (const cell of modulesInFirstBand) {
    const rect = (cell as Extract<FigureCell, { kind: 'vertex' }>).rect
    assert.ok(rect.y >= firstBand.y && rect.y + rect.height <= firstBand.y + firstBand.height, '模块必须落在层带内')
  }
  const edges = drawing.cells.filter(cell => cell.kind === 'edge')
  assert.equal(edges.length, 2, '三层之间应有两条默认调用箭头')
  assert.ok(drawing.height > 0 && drawing.notes.length >= 1, '5 个模块的层应提示自动折行')
})

test('流程图版面：按最长路径分层，箭头从下层节点的底部指向下层', () => {
  const model = parseFigureModel('flow', {
    nodes: [
      { id: 's', text: '开始', kind: 'start' },
      { id: 'a', text: '校验' },
      { id: 'd', text: '通过?', kind: 'decision' },
      { id: 'b', text: '拒绝', kind: 'end' },
      { id: 'e', text: '保存', kind: 'process' },
      { id: 'f', text: '结束', kind: 'end' },
    ],
    edges: [
      { from: 's', to: 'a' },
      { from: 'a', to: 'd' },
      { from: 'd', to: 'b', label: '否' },
      { from: 'd', to: 'e', label: '是' },
      { from: 'e', to: 'f' },
    ],
  })
  const drawing = buildDrawing(model)
  const vertices = drawing.cells.filter(cell => cell.kind === 'vertex') as Extract<FigureCell, { kind: 'vertex' }>[]
  const byText = new Map(vertices.map(cell => [cell.value, cell.rect]))
  const start = byText.get('开始')!
  const end = byText.get('结束')!
  assert.ok(start.y < end.y, '起点在上、终点在下')
  const decision = byText.get('通过?')!
  assert.ok(decision.width < start.width, '菱形比矩形窄（版面常量）')
  for (const edge of drawing.cells.filter(cell => cell.kind === 'edge') as Extract<FigureCell, { kind: 'edge' }>[]) {
    assert.match(edge.style, /exitX=0\.5;exitY=1;entryX=0\.5;entryY=0;/, '竖向连线使用下→上锚点')
  }
})

test('E-R 版面：实体是标题栏 + 字段行，两列排布，关系线不带箭头', () => {
  const model = parseFigureModel('er', {
    entities: [
      { name: '用户', fields: [{ name: 'id', type: 'bigint', key: true }, { name: '用户名', type: 'varchar(32)' }] },
      { name: '任务', fields: [{ name: 'id', type: 'bigint', key: true }, { name: '标题', type: 'varchar(64)' }] },
      { name: '标签', fields: [{ name: 'id', type: 'bigint', key: true }] },
    ],
    relations: [
      { from: '用户', to: '任务', label: '创建', cardinality: '1:N' },
      { from: '任务', to: '标签', cardinality: 'M:N' },
    ],
  })
  const drawing = buildDrawing(model)
  const vertices = drawing.cells.filter(cell => cell.kind === 'vertex') as Extract<FigureCell, { kind: 'vertex' }>[]
  const titles = vertices.filter(cell => cell.style === STYLE.entityTitle)
  assert.equal(titles.length, 3)
  assert.equal(vertices.filter(cell => cell.style === STYLE.entityRow).length, 5, '3 个实体的字段行合计 5 行')
  const xs = new Set(titles.map(cell => cell.rect.x))
  assert.equal(xs.size, 2, '三个实体应分两列摆放')
  const relations = drawing.cells.filter(cell => cell.kind === 'edge') as Extract<FigureCell, { kind: 'edge' }>[]
  assert.equal(relations.length, 2)
  assert.match(relations[0]!.value, /1:N 创建/)
  assert.match(relations[0]!.style, /endArrow=none;startArrow=none;/)
})

test('时序图版面：参与者等距、生命线等高、消息按时间向下', () => {
  const model = parseFigureModel('sequence', {
    participants: ['浏览器', 'Web 服务', 'MySQL'],
    messages: [
      { from: '浏览器', to: 'Web 服务', text: 'POST /api/tasks' },
      { from: 'Web 服务', to: 'MySQL', text: 'INSERT' },
      { from: 'MySQL', to: 'Web 服务', text: 'ok', kind: 'return' },
    ],
  })
  const drawing = buildDrawing(model)
  const lifelines = drawing.cells.filter(cell => cell.kind === 'vertex') as Extract<FigureCell, { kind: 'vertex' }>[]
  assert.equal(lifelines.length, 3)
  const heights = new Set(lifelines.map(cell => cell.rect.height))
  assert.equal(heights.size, 1, '生命线等高')
  const gaps = lifelines.slice(1).map((cell, index) => cell.rect.x - lifelines[index]!.rect.x)
  assert.ok(gaps.every(gap => Math.abs(gap - gaps[0]!) < 0.01), '参与者等距')
  const messages = drawing.cells.filter(cell => cell.kind === 'edge') as Extract<FigureCell, { kind: 'edge' }>[]
  assert.equal(messages.length, 3)
  const fractions = messages.map(message => Number(/exitY=([\d.]+)/.exec(message.style)![1]))
  assert.deepEqual([...fractions].sort((a, b) => a - b), fractions, '消息按时间顺序自上而下')
  assert.match(messages[2]!.style, /dashed=1/, '返回消息用虚线')
})

test('文本宽度估算：中文按整字宽、西文按半字宽', () => {
  assert.ok(displayWidth('任务管理') > displayWidth('task'))
  assert.equal(displayWidth(''), 0)
  assert.equal(LAYOUT.contentWidth <= 740, true)
})
