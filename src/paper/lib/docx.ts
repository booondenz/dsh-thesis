/**
 * 零依赖 .docx 生成：Markdown-lite → WordprocessingML。
 *
 * 覆盖论文写作实际用到的 Markdown 子集：
 * - 标题 # / ## / ###（H1 每章另起一页）
 * - 段落、粗体 **text**、行内代码 `code`、链接 [text](url)
 * - 无序列表 - item、表格 | a | b |
 * - G2 清单 - [ ] / - [x] 保持为列表项文本
 *
 * 中文排版：正文宋体 + Times New Roman、1.5 倍行距；标题黑体。
 * 这是内置过渡引擎；机器装有 pandoc 时 thesis_build 优先走 pandoc。
 */

import { buildZip, type ZipEntry } from './zip.ts'

const encoder = new TextEncoder()

// ---------------------------------------------------------------------------
// 块级解析
// ---------------------------------------------------------------------------

type Block =
  | { readonly kind: 'h1' | 'h2' | 'h3'; readonly text: string }
  | { readonly kind: 'p'; readonly text: string }
  | { readonly kind: 'bullet'; readonly text: string }
  | { readonly kind: 'table'; readonly rows: readonly (readonly string[])[] }
  | { readonly kind: 'image'; readonly alt: string; readonly src: string }

export function parseMarkdownBlocks(markdown: string): Block[] {
  const blocks: Block[] = []
  const lines = markdown.split('\n')
  let i = 0
  while (i < lines.length) {
    const line = lines[i]!
    const trimmed = line.trim()

    if (trimmed === '' || /^-{3,}$/.test(trimmed)) {
      i += 1
      continue
    }

    // 图片：独占一行的 `![图题](路径)`；路径可写成 `<...>`（构建时会改写为绝对路径）。
    // 图题（alt）在图**下方**，与论文规范一致。
    const image = /^!\[([^\]]*)\]\(\s*(?:<([^>]+)>|([^)\s]+))(?:\s+"[^"]*")?\s*\)$/.exec(trimmed)
    if (image !== null) {
      blocks.push({ kind: 'image', alt: image[1] ?? '', src: image[2] ?? image[3] ?? '' })
      i += 1
      continue
    }

    // 表格：连续的 | 行（跳过分隔行）
    if (trimmed.startsWith('|') && trimmed.endsWith('|')) {
      const rows: string[][] = []
      while (i < lines.length) {
        const candidate = lines[i]!.trim()
        if (!(candidate.startsWith('|') && candidate.endsWith('|'))) break
        const cells = candidate.slice(1, -1).split('|').map(c => c.trim())
        const isSeparator = cells.every(c => /^:?-{2,}:?$/.test(c))
        if (!isSeparator && cells.some(c => c !== '')) rows.push(cells)
        i += 1
      }
      if (rows.length > 0) blocks.push({ kind: 'table', rows })
      continue
    }

    const h = /^(#{1,3})\s+(.*)$/.exec(line)
    if (h !== null) {
      const level = h[1]!.length
      const kind = level === 1 ? 'h1' as const : level === 2 ? 'h2' as const : 'h3' as const
      blocks.push({ kind, text: h[2]!.trim() })
      i += 1
      continue
    }

    if (/^[-*]\s+/.test(trimmed)) {
      blocks.push({ kind: 'bullet', text: trimmed.replace(/^[-*]\s+/, '') })
      i += 1
      continue
    }

    blocks.push({ kind: 'p', text: trimmed.replace(/^>\s?/, '') })
    i += 1
  }
  return blocks
}

// ---------------------------------------------------------------------------
// 行内解析与 XML
// ---------------------------------------------------------------------------

function escapeXml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

interface Run {
  readonly text: string
  readonly bold: boolean
}

function parseInline(text: string): Run[] {
  const runs: Run[] = []
  // 先还原链接为文字
  const noLinks = text.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
  const parts = noLinks.split(/(\*\*[^*]+\*\*|`[^`]+`)/g)
  for (const part of parts) {
    if (part === '' || part === undefined) continue
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
      runs.push({ text: part.slice(2, -2), bold: true })
    } else if (part.startsWith('`') && part.endsWith('`') && part.length > 1) {
      runs.push({ text: part.slice(1, -1), bold: false })
    } else {
      runs.push({ text: part, bold: false })
    }
  }
  return runs
}

function runsXml(runs: readonly Run[]): string {
  return runs.map(run =>
    `<w:r><w:rPr>${run.bold ? '<w:b/>' : ''}</w:rPr><w:t xml:space="preserve">${escapeXml(run.text)}</w:t></w:r>`,
  ).join('')
}

function paragraphXml(text: string, styleId?: string, pageBreakBefore = false): string {
  const pPr = styleId !== undefined || pageBreakBefore
    ? `<w:pPr>${styleId !== undefined ? `<w:pStyle w:val="${styleId}"/>` : ''}${pageBreakBefore ? '<w:pageBreakBefore/>' : ''}</w:pPr>`
    : ''
  return `<w:p>${pPr}${runsXml(parseInline(text))}</w:p>`
}

function blockXml(block: Exclude<Block, { kind: 'image' }>): string {
  switch (block.kind) {
    case 'h1': return paragraphXml(block.text, 'Heading1', true)
    case 'h2': return paragraphXml(block.text, 'Heading2')
    case 'h3': return paragraphXml(block.text, 'Heading3')
    case 'p': return paragraphXml(block.text)
    case 'bullet': return paragraphXml(`• ${block.text}`, 'ListBullet')
    case 'table': {
      const rows = block.rows.map(row => {
        const cells = row.map(cell => `<w:tc><w:p>${runsXml(parseInline(cell))}</w:p></w:tc>`).join('')
        return `<w:tr>${cells}</w:tr>`
      }).join('')
      return `<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="0" w:type="auto"/></w:tblPr>${rows}</w:tbl>`
    }
  }
}

// ---------------------------------------------------------------------------
// 文档装配
// ---------------------------------------------------------------------------

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>
`

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:docDefaults>
    <w:rPrDefault><w:rPr>
      <w:rFonts w:ascii="Times New Roman" w:eastAsia="宋体" w:hAnsi="Times New Roman"/>
      <w:sz w:val="24"/><w:szCs w:val="24"/>
    </w:rPr></w:rPrDefault>
    <w:pPrDefault><w:pPr><w:spacing w:line="360" w:lineRule="auto"/></w:pPr></w:pPrDefault>
  </w:docDefaults>
  <w:style w:type="paragraph" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
  <w:style w:type="paragraph" w:styleId="TitlePage">
    <w:name w:val="Title Page"/>
    <w:pPr><w:jc w:val="center"/><w:spacing w:before="1200" w:after="240"/></w:pPr>
    <w:rPr><w:rFonts w:eastAsia="黑体"/><w:b/><w:sz w:val="44"/><w:szCs w:val="44"/></w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Subtitle">
    <w:name w:val="Subtitle"/>
    <w:pPr><w:jc w:val="center"/><w:spacing w:after="240"/></w:pPr>
    <w:rPr><w:sz w:val="28"/><w:szCs w:val="28"/></w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Heading1">
    <w:name w:val="heading 1"/>
    <w:pPr><w:spacing w:before="240" w:after="120"/></w:pPr>
    <w:rPr><w:rFonts w:eastAsia="黑体"/><w:b/><w:sz w:val="32"/><w:szCs w:val="32"/></w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Heading2">
    <w:name w:val="heading 2"/>
    <w:pPr><w:spacing w:before="200" w:after="100"/></w:pPr>
    <w:rPr><w:rFonts w:eastAsia="黑体"/><w:b/><w:sz w:val="28"/><w:szCs w:val="28"/></w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Heading3">
    <w:name w:val="heading 3"/>
    <w:pPr><w:spacing w:before="160" w:after="80"/></w:pPr>
    <w:rPr><w:rFonts w:eastAsia="黑体"/><w:b/><w:sz w:val="26"/><w:szCs w:val="26"/></w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="ListBullet"><w:name w:val="List Bullet"/></w:style>
  <w:style w:type="paragraph" w:styleId="Caption">
    <w:name w:val="caption"/>
    <w:pPr><w:jc w:val="center"/><w:spacing w:before="40" w:after="200"/></w:pPr>
    <w:rPr><w:rFonts w:eastAsia="宋体"/><w:sz w:val="21"/><w:szCs w:val="21"/></w:rPr>
  </w:style>
  <w:style w:type="table" w:styleId="TableGrid">
    <w:name w:val="Table Grid"/>
    <w:tblPr>
      <w:tblBorders>
        <w:top w:val="single" w:sz="4" w:color="000000"/>
        <w:left w:val="single" w:sz="4" w:color="000000"/>
        <w:bottom w:val="single" w:sz="4" w:color="000000"/>
        <w:right w:val="single" w:sz="4" w:color="000000"/>
        <w:insideH w:val="single" w:sz="4" w:color="000000"/>
        <w:insideV w:val="single" w:sz="4" w:color="000000"/>
      </w:tblBorders>
    </w:tblPr>
  </w:style>
</w:styles>
`

/** 要嵌进 docx 的图片（由 thesis_build 从章节里的 `![](路径)` 收集）。 */
export interface DocxImage {
  readonly data: Uint8Array
  /** 像素宽（文件头解析得到）。 */
  readonly width: number
  /** 像素高。 */
  readonly height: number
  readonly format: 'png' | 'jpeg'
}

export interface DocxOptions {
  readonly title: string
  readonly markdown: string
  /** 图片绝对路径 → 图片字节与像素尺寸；缺省的图片降级为一行占位文字。 */
  readonly images?: ReadonlyMap<string, DocxImage>
}

/** 1 像素按 96dpi 折算的 EMU。 */
const EMU_PER_PIXEL = 9_525
/** 正文栏宽（A4、2.54cm 页边距约 15.9cm），插图最宽取 15cm。 */
const MAX_IMAGE_WIDTH_EMU = 5_400_000
/** 单张图最高 20cm：再高就会把图题挤到下一页。 */
const MAX_IMAGE_HEIGHT_EMU = 7_200_000

interface ImagePart {
  readonly rId: string
  readonly partName: string
  readonly data: Uint8Array
  readonly format: 'png' | 'jpeg'
}

/** 按像素尺寸算出等比例缩放后的 EMU 宽高。 */
function imageExtent(image: DocxImage): { readonly cx: number; readonly cy: number } {
  let cx = Math.max(1, image.width) * EMU_PER_PIXEL
  let cy = Math.max(1, image.height) * EMU_PER_PIXEL
  const widthScale = Math.min(1, MAX_IMAGE_WIDTH_EMU / cx)
  cx = Math.round(cx * widthScale)
  cy = Math.round(cy * widthScale)
  if (cy > MAX_IMAGE_HEIGHT_EMU) {
    const heightScale = MAX_IMAGE_HEIGHT_EMU / cy
    cx = Math.round(cx * heightScale)
    cy = Math.round(cy * heightScale)
  }
  return { cx, cy }
}

/**
 * 一张图的 WordprocessingML：居中段落 + inline drawing + 图题。
 *
 * 图题用单独的 Caption 段落（居中、五号），而不是塞进图片的替代文字里：
 * 论文的图题必须能被选中、能被目录/交叉引用识别，也才能通过"图题在图下方"的检查。
 */
function imageXml(alt: string, part: ImagePart | undefined, image: DocxImage | undefined, index: number): string {
  if (part === undefined || image === undefined) {
    const missing = alt === '' ? '图片缺失' : alt
    return paragraphXml(`［${missing}：图片文件未找到，请检查路径］`)
  }
  const { cx, cy } = imageExtent(image)
  const drawing = `<w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0">`
    + `<wp:extent cx="${cx}" cy="${cy}"/><wp:effectExtent l="0" t="0" r="0" b="0"/>`
    + `<wp:docPr id="${index}" name="图片 ${index}"/><wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr>`
    + '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic>'
    + `<pic:nvPicPr><pic:cNvPr id="${index}" name="${escapeXml(part.partName)}"/><pic:cNvPicPr/></pic:nvPicPr>`
    + `<pic:blipFill><a:blip r:embed="${part.rId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>`
    + `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>`
    + '</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing>'
  const imageParagraph = `<w:p><w:pPr><w:jc w:val="center"/><w:spacing w:before="120" w:after="60"/></w:pPr><w:r>${drawing}</w:r></w:p>`
  const caption = alt === ''
    ? ''
    : `<w:p><w:pPr><w:pStyle w:val="Caption"/><w:jc w:val="center"/></w:pPr><w:r><w:t xml:space="preserve">${escapeXml(alt)}</w:t></w:r></w:p>`
  return imageParagraph + caption
}

/**
 * 生成完整 .docx 字节。title 渲染为封面页；markdown 为正文（章节合并内容）。
 *
 * 图片按 `images` 里的字节嵌入：`![图 4-1 系统总体架构图](绝对路径)` 会变成
 * 「居中的图 + 图下方的图题」。找不到字节的图片降级成一行可读的占位文字——
 * 缺图必须在 Word 里一眼看见，不能静默消失。
 */
export function buildDocx(opts: DocxOptions): Uint8Array {
  const blocks = parseMarkdownBlocks(opts.markdown)
  const body: string[] = []
  body.push(paragraphXml(opts.title, 'TitlePage'))
  body.push(paragraphXml('本科毕业论文（设计）', 'Subtitle'))
  body.push('<w:p/>')

  const parts: ImagePart[] = []
  const formats = new Set<'png' | 'jpeg'>()
  let imageIndex = 0
  for (const block of blocks) {
    if (block.kind !== 'image') {
      body.push(blockXml(block))
      continue
    }
    imageIndex += 1
    const image = opts.images?.get(block.src)
    let part: ImagePart | undefined
    if (image !== undefined) {
      const extension = image.format === 'png' ? 'png' : 'jpg'
      part = {
        rId: `rIdImg${imageIndex}`,
        partName: `media/image${imageIndex}.${extension}`,
        data: image.data,
        format: image.format,
      }
      parts.push(part)
      formats.add(image.format)
    }
    body.push(imageXml(block.alt, part, image, imageIndex))
  }

  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">
  <w:body>
    ${body.join('')}
    <w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr>
  </w:body>
</w:document>
`

  const entries: ZipEntry[] = [
    { name: '[Content_Types].xml', data: encoder.encode(contentTypes(formats)) },
    { name: '_rels/.rels', data: encoder.encode(ROOT_RELS) },
    { name: 'word/document.xml', data: encoder.encode(document) },
    { name: 'word/styles.xml', data: encoder.encode(STYLES) },
    { name: 'word/_rels/document.xml.rels', data: encoder.encode(documentRels(parts)) },
  ]
  for (const part of parts) {
    entries.push({ name: `word/${part.partName}`, data: part.data })
  }
  return buildZip(entries)
}

/** `[Content_Types].xml`：基础部件 + 实际用到的图片格式。 */
function contentTypes(formats: ReadonlySet<'png' | 'jpeg'>): string {
  const defaults = [
    ...(formats.has('png') ? ['  <Default Extension="png" ContentType="image/png"/>'] : []),
    ...(formats.has('jpeg') ? ['  <Default Extension="jpg" ContentType="image/jpeg"/>'] : []),
  ].join('\n')
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
${defaults === '' ? '' : `${defaults}\n`}  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
</Types>
`
}

/**
 * `word/_rels/document.xml.rels`：样式部件必须在关系里**显式登记**。
 *
 * 这一条曾经漏过：`styles.xml` 写进了包、`[Content_Types].xml` 也声明了，但没有
 * relationship 时 Word 不会应用任何样式（标题、图题全变成普通正文），python-docx
 * 更是直接只看到 4 个内置样式。图片关系与样式关系都从这里出。
 */
function documentRels(parts: readonly ImagePart[]): string {
  const relationships = [
    '  <Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>',
    ...parts.map(part => `  <Relationship Id="${part.rId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="${part.partName}"/>`),
  ].join('\n')
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${relationships}
</Relationships>
`
}
