/**
 * draw.io（`.drawio` / mxfile）渲染：把版面模型写成 draw.io 能打开、学生能继续手工编辑的 XML。
 *
 * 为什么不用 Mermaid：Mermaid 是「文本进、自动布局出」，论文里的架构图、ER 图往往被
 * 排成一张挤在一起的网，字号、配色、线型也由渲染器决定。draw.io 的源文件是**显式坐标**
 * 的矢量图，可以精确控制版面、统一风格、导出高分辨率 PNG，并且改动仍可在 draw.io 里完成。
 * 本模块只做两件事：给出一套论文用的风格常量，把 {@link FigureCell} 渲染成 mxfile。
 *
 * 约束（与仓库其它模块一致）：
 * - 零依赖、确定性输出（同样的输入 + 同样的时间，字节完全一致）；
 * - 正文里出现的一切用户文本都要转义，标签里的换行以 `&lt;br&gt;` 表达（draw.io 的 html=1）；
 * - `custom` 图接受模型手写的 mxfile，但必须过 {@link validateMxfile}，不允许脚本与 DOCTYPE。
 *
 * @module dsh-thesis/figure/drawio
 */

/** 平面坐标（draw.io 单位：1 单位 ≈ 0.01 英寸，A4 纵向页宽 827）。 */
export interface Point {
  readonly x: number
  readonly y: number
}

/** 矩形几何。 */
export interface Rect {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/** 一条要落进 mxGraphModel 的图元。 */
export type FigureCell =
  | {
    readonly kind: 'vertex'
    readonly id: string
    readonly value: string
    readonly style: string
    readonly rect: Rect
  }
  | {
    readonly kind: 'edge'
    readonly id: string
    readonly value: string
    readonly style: string
    readonly source: string
    readonly target: string
    /** 手工折点（缺省交给 draw.io 的正交路由）。 */
    readonly points?: readonly Point[]
  }

// ---------------------------------------------------------------------------
// 风格：论文插图用的统一预设
// ---------------------------------------------------------------------------

/**
 * 统一的插图风格。
 *
 * 取色原则：低饱和的蓝灰主色 + 大面积留白，黑白打印仍然分得清层次；
 * 中文用宋体、层名用黑体，与论文正文的字体习惯一致（字体缺失时 draw.io 会回退，
 * 不会影响图的可读性）。
 */
export const STYLE = {
  /** 分层容器的底色（虚线框，不抢内容的注意力）。 */
  layerBand: 'rounded=0;whiteSpace=wrap;html=1;fillColor=#F7F9FC;strokeColor=#C3CEDC;dashed=1;dashPattern=6 4;',
  /** 分层名（左侧竖条）。 */
  layerLabel: 'rounded=0;whiteSpace=wrap;html=1;fillColor=#E9EFF7;strokeColor=#C3CEDC;fontFamily=SimHei;fontSize=12;fontStyle=1;',
  /** 普通模块。 */
  module: 'rounded=1;arcSize=10;whiteSpace=wrap;html=1;fillColor=#FFFFFF;strokeColor=#6E8FB5;fontFamily=SimSun;fontSize=12;',
  /** 强调模块（系统的核心 / 答辩要讲的那一块）。 */
  moduleAccent: 'rounded=1;arcSize=10;whiteSpace=wrap;html=1;fillColor=#DCE8F6;strokeColor=#3F6D9E;fontFamily=SimSun;fontSize=12;fontStyle=1;',
  /** 流程起点。 */
  start: 'rounded=1;arcSize=50;whiteSpace=wrap;html=1;fillColor=#E4F1DC;strokeColor=#6B9E5A;fontFamily=SimSun;fontSize=12;fontStyle=1;',
  /** 流程终点。 */
  end: 'rounded=1;arcSize=50;whiteSpace=wrap;html=1;fillColor=#F6E4E4;strokeColor=#B06A6A;fontFamily=SimSun;fontSize=12;fontStyle=1;',
  /** 判断节点（菱形）。 */
  decision: 'rhombus;whiteSpace=wrap;html=1;fillColor=#FFF6E0;strokeColor=#C9A24A;fontFamily=SimSun;fontSize=12;',
  /** ER 实体标题栏。 */
  entityTitle: 'rounded=0;whiteSpace=wrap;html=1;fillColor=#DCE8F6;strokeColor=#3F6D9E;fontFamily=SimHei;fontSize=12;fontStyle=1;',
  /** ER 实体字段行。 */
  entityRow: 'rounded=0;whiteSpace=wrap;html=1;align=left;spacingLeft=8;fillColor=#FFFFFF;strokeColor=#9FB3C8;fontFamily=SimSun;fontSize=11;',
  /** 时序图参与者（draw.io 自带生命线形状）。 */
  lifeline: 'shape=umlLifeline;perimeter=lifelinePerimeter;whiteSpace=wrap;html=1;container=0;collapsible=0;recursiveResize=0;outlineConnect=0;fontFamily=SimSun;fontSize=12;',
  /** 实线箭头（调用 / 依赖）。标签加白底，压在线上也读得清。 */
  edge: 'edgeStyle=orthogonalEdgeStyle;rounded=1;html=1;endArrow=block;endFill=1;strokeColor=#5F7F9F;labelBackgroundColor=#FFFFFF;fontFamily=SimSun;fontSize=11;',
  /** 虚线箭头（返回 / 弱依赖）。 */
  edgeDashed: 'edgeStyle=orthogonalEdgeStyle;rounded=1;html=1;endArrow=open;endFill=0;dashed=1;strokeColor=#5F7F9F;labelBackgroundColor=#FFFFFF;fontFamily=SimSun;fontSize=11;',
  /** 时序图消息（水平箭头，无正交折线）。 */
  message: 'html=1;verticalAlign=bottom;endArrow=block;endFill=1;rounded=0;strokeColor=#3F6D9E;labelBackgroundColor=#FFFFFF;fontFamily=SimSun;fontSize=11;',
  /** 时序图返回消息。 */
  messageReturn: 'html=1;verticalAlign=bottom;endArrow=open;endFill=0;dashed=1;rounded=0;strokeColor=#5F7F9F;labelBackgroundColor=#FFFFFF;fontFamily=SimSun;fontSize=11;',
} as const

// ---------------------------------------------------------------------------
// 转义与渲染
// ---------------------------------------------------------------------------

/** XML 属性值转义（顺序有关：`&` 必须先转）。 */
export function escapeXmlAttr(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

/** draw.io 标签：逐行转义后用 `&lt;br&gt;` 连接（html=1 时渲染成换行）。 */
export function labelValue(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map(line => escapeXmlAttr(line.trimEnd()))
    .join('&lt;br&gt;')
}

/** 数字统一保留两位小数，避免浮点尾巴让 diff 噪音变大。 */
function num(value: number): string {
  const rounded = Math.round(value * 100) / 100
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(2)
}

function renderGeometry(cell: Extract<FigureCell, { kind: 'vertex' }>): string {
  const { x, y, width, height } = cell.rect
  return `<mxGeometry x="${num(x)}" y="${num(y)}" width="${num(width)}" height="${num(height)}" as="geometry" />`
}

function renderEdgeGeometry(cell: Extract<FigureCell, { kind: 'edge' }>): string {
  const points = cell.points ?? []
  if (points.length === 0) return '<mxGeometry relative="1" as="geometry" />'
  const rendered = points.map(p => `<mxPoint x="${num(p.x)}" y="${num(p.y)}" />`).join('')
  return `<mxGeometry relative="1" as="geometry"><Array as="points">${rendered}</Array></mxGeometry>`
}

function renderCell(cell: FigureCell): string {
  if (cell.kind === 'vertex') {
    // 所有图元都挂在根层、用**绝对坐标**：mxGraph 里子图元的 geometry 是相对父图元的，
    // 把模块嵌进层带（parent=band）会让坐标整体再偏移一次，图直接错位。
    // 层带与模块的包含关系靠视觉位置表达，不靠 cell 嵌套。
    // 标签走 labelValue：换行转成 `&lt;br&gt;`（html=1 时 draw.io 才认多行）。
    return `<mxCell id="${escapeXmlAttr(cell.id)}" value="${labelValue(cell.value)}" style="${escapeXmlAttr(cell.style)}" vertex="1" parent="1">${renderGeometry(cell)}</mxCell>`
  }
  return `<mxCell id="${escapeXmlAttr(cell.id)}" value="${labelValue(cell.value)}" style="${escapeXmlAttr(cell.style)}" edge="1" parent="1" source="${escapeXmlAttr(cell.source)}" target="${escapeXmlAttr(cell.target)}">${renderEdgeGeometry(cell)}</mxCell>`
}

/** mxfile 渲染参数。 */
export interface MxFileOptions {
  /** 图名（写进 `<diagram name>`，也是 draw.io 里的页签标题）。 */
  readonly name: string
  readonly cells: readonly FigureCell[]
  /** 页面宽（缺省 A4 纵向 827）。导出时 `--border` 会在内容外留白，页码本身不参与裁剪。 */
  readonly pageWidth?: number
  /** 页面高（缺省按内容推算，最小 A4 纵向 1169）。 */
  readonly pageHeight?: number
  /** 渲染时间（测试注入固定值；缺省当前时间）。 */
  readonly now?: Date
}

/** A4 纵向页宽（draw.io 单位）。 */
export const DEFAULT_PAGE_WIDTH = 827
/** A4 纵向页高。 */
export const DEFAULT_PAGE_HEIGHT = 1169

/**
 * 渲染完整的 `.drawio` 文本。
 *
 * 顶层版本号写死为 `24.0.0`：draw.io 对高版本文件会走兼容分支，低版本号最稳；
 * `host/agent` 标成 dsh-thesis，便于学生一眼看出这张图是谁生成的。
 */
export function renderMxfile(options: MxFileOptions): string {
  const now = options.now ?? new Date()
  const pageWidth = options.pageWidth ?? DEFAULT_PAGE_WIDTH
  const pageHeight = options.pageHeight ?? DEFAULT_PAGE_HEIGHT
  const cells = options.cells.map(renderCell).join('')
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<mxfile host="dsh-thesis" modified="${now.toISOString()}" agent="dsh-thesis" version="24.0.0" type="device">`,
    `  <diagram id="dsh-thesis-figure" name="${escapeXmlAttr(options.name)}">`,
    `    <mxGraphModel dx="${pageWidth}" dy="${pageHeight}" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="${pageWidth}" pageHeight="${pageHeight}" math="0" shadow="0">`,
    '      <root>',
    '        <mxCell id="0" />',
    '        <mxCell id="1" parent="0" />',
    `        ${cells}`,
    '      </root>',
    '    </mxGraphModel>',
    '  </diagram>',
    '</mxfile>',
    '',
  ].join('\n')
}

/** 自定义 mxfile 的校验结论。 */
export type MxfileCheck = { readonly ok: true } | { readonly ok: false; readonly reason: string }

/**
 * 校验 `custom` 图的手写 XML。
 *
 * 只做结构性检查（足够挡住「贴错内容」「贴成 SVG」这类事故），不做完整 XML 解析：
 * 真解析需要额外依赖，而 draw.io 自己会在打开时报语法错。拒绝 `<!DOCTYPE` 与 `<script`
 * 是安全底线：mxfile 可以内嵌 HTML 标签，脚本一旦被执行就是宿主风险。
 */
export function validateMxfile(xml: string): MxfileCheck {
  const text = xml.trim()
  if (text === '') return { ok: false, reason: 'custom 图的 xml 为空' }
  if (/<!DOCTYPE/i.test(text)) return { ok: false, reason: 'custom 图的 xml 不允许 <!DOCTYPE（draw.io 也不需要）' }
  if (/<script[\s>]/i.test(text)) return { ok: false, reason: 'custom 图的 xml 不允许 <script>' }
  if (!/^<\?xml[^>]*\?>\s*<mxfile[\s>]/i.test(text) && !/^<mxfile[\s>]/i.test(text)) {
    return { ok: false, reason: 'custom 图必须以 <mxfile> 开头（draw.io 的「文件 → 另存为 .drawio」就是这种格式）' }
  }
  if (!/<mxGraphModel[\s>]/i.test(text)) return { ok: false, reason: 'custom 图缺少 <mxGraphModel>（不是有效的 draw.io 图）' }
  if (!/<root[\s>]/i.test(text)) return { ok: false, reason: 'custom 图缺少 <root>（mxGraphModel 里必须有一个根层）' }
  return { ok: true }
}
