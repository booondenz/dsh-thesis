/**
 * 内置 docx 引擎的插图能力：图片按 PNG/JPEG 嵌进 Word，图题在图下方。
 *
 * 断言直接看 OOXML 字节：media 部件、relationship、drawing 的 EMU 尺寸、图题段落。
 * 这是「thesis_figure 导出的 PNG 真能进论文」的最后一段链路。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildDocx, parseMarkdownBlocks, type DocxImage } from '../src/paper/lib/docx.ts'
import { imageFormatOf, readImageInfo } from '../src/paper/lib/image.ts'
import { zipContainsName } from '../src/paper/lib/zip.ts'

const decoder = new TextDecoder()

/** 只取 zip 里所有字节（STORE 未压缩，XML 可直接搜索）。 */
function rawText(zip: Uint8Array): string {
  return decoder.decode(zip)
}

/** 构造一个头部合法的最小 PNG（宽 2、高 1；只用于尺寸解析与打包）。 */
function pngBytes(width = 2, height = 1): Uint8Array {
  const bytes = new Uint8Array(33)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
  bytes.set([0x00, 0x00, 0x00, 0x0d], 8)
  bytes.set([0x49, 0x48, 0x44, 0x52], 12)
  bytes.set([(width >>> 24) & 0xff, (width >>> 16) & 0xff, (width >>> 8) & 0xff, width & 0xff], 16)
  bytes.set([(height >>> 24) & 0xff, (height >>> 16) & 0xff, (height >>> 8) & 0xff, height & 0xff], 20)
  return bytes
}

/** 构造一个头部合法的最小 JPEG（宽 3、高 2）。 */
function jpegBytes(width = 3, height = 2): Uint8Array {
  return new Uint8Array([
    0xff, 0xd8,
    0xff, 0xc0, 0x00, 0x11, 0x08,
    (height >> 8) & 0xff, height & 0xff,
    (width >> 8) & 0xff, width & 0xff,
    0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
  ])
}

test('图片头解析：PNG 与 JPEG 的宽高、格式识别、未知格式返回 undefined', () => {
  assert.deepEqual(readImageInfo(pngBytes(640, 480)), { format: 'png', width: 640, height: 480 })
  assert.deepEqual(readImageInfo(jpegBytes(800, 600)), { format: 'jpeg', width: 800, height: 600 })
  assert.equal(readImageInfo(new Uint8Array([1, 2, 3, 4])), undefined)
  assert.equal(imageFormatOf('a.PNG'), 'png')
  assert.equal(imageFormatOf('a.jpeg'), 'jpeg')
  assert.equal(imageFormatOf('a.gif'), undefined)
})

test('Markdown 解析：独占一行的图片（含 <带空格路径>）识别为 image 块', () => {
  const blocks = parseMarkdownBlocks([
    '# 第 4 章',
    '![图 4-1 系统总体架构图](../assets/图/arch.png)',
    '![](<C:\\Users\\me\\My Pics\\a.png>)',
    '普通段落',
  ].join('\n'))
  assert.deepEqual(blocks.map(block => block.kind), ['h1', 'image', 'image', 'p'])
  assert.deepEqual(blocks[1], { kind: 'image', alt: '图 4-1 系统总体架构图', src: '../assets/图/arch.png' })
  assert.equal((blocks[2] as { src: string }).src, 'C:\\Users\\me\\My Pics\\a.png')
})

test('docx 嵌图：media 部件 + relationship + 居中 drawing + 图题', () => {
  const image = { data: pngBytes(2400, 1200), width: 2400, height: 1200, format: 'png' } as DocxImage
  const bytes = buildDocx({
    title: '测试论文',
    markdown: '## 4.1 总体架构\n\n如图 4-1 所示。\n\n![图 4-1 系统总体架构图](<C:\\t\\arch.png>)\n',
    images: new Map([['C:\\t\\arch.png', image]]),
  })
  assert.equal(zipContainsName(bytes, 'word/media/image1.png'), true)
  assert.equal(zipContainsName(bytes, 'word/_rels/document.xml.rels'), true)
  const text = rawText(bytes)
  assert.match(text, /Extension="png" ContentType="image\/png"/)
  assert.match(text, /Type="http:\/\/schemas\.openxmlformats\.org\/officeDocument\/2006\/relationships\/image" Target="media\/image1\.png"/)
  assert.match(text, /relationships\/styles" Target="styles\.xml"/, '样式部件必须在关系里登记，否则 Word 不应用任何样式')
  assert.match(text, /r:embed="rIdImg1"/)
  assert.match(text, /<w:drawing><wp:inline/)
  assert.match(text, /图 4-1 系统总体架构图/)
  assert.match(text, /w:val="Caption"/)
})

test('docx 嵌图：尺寸按 96dpi 折算并限制在 15cm 栏宽内', () => {
  // 2400px ≈ 25.4cm 的自然宽度，必须被压到 15cm = 5,400,000 EMU。
  const wide = buildDocx({
    title: 't',
    markdown: '![图 1-1 宽图](<C:\\t\\wide.png>)',
    images: new Map([['C:\\t\\wide.png', { data: pngBytes(2400, 1200), width: 2400, height: 1200, format: 'png' }] as [string, DocxImage][]]),
  })
  const wideText = rawText(wide)
  const extent = /<wp:extent cx="(\d+)" cy="(\d+)"\/>/.exec(wideText)
  assert.ok(extent !== null)
  assert.ok(Number(extent[1]) <= 5_400_000, '宽度必须被限制在 15cm')
  assert.equal(Number(extent[1]) / Number(extent[2]), 2, '缩放必须保持宽高比')

  const small = buildDocx({
    title: 't',
    markdown: '![图 1-1 小图](<C:\\t\\small.png>)',
    images: new Map([['C:\\t\\small.png', { data: pngBytes(300, 150), width: 300, height: 150, format: 'png' }] as [string, DocxImage][]]),
  })
  const smallExtent = /<wp:extent cx="(\d+)"/.exec(rawText(small))
  assert.equal(Number(smallExtent![1]), 300 * 9525, '小图按 96dpi 原尺寸放置')
})

test('docx 嵌图：JPEG 用 image/jpeg 的 content-type 与 .jpg 部件名', () => {
  const bytes = buildDocx({
    title: 't',
    markdown: '![图 5-1 运行截图](<C:\\t\\shot.jpg>)',
    images: new Map([['C:\\t\\shot.jpg', { data: jpegBytes(800, 600), width: 800, height: 600, format: 'jpeg' }] as [string, DocxImage][]]),
  })
  assert.equal(zipContainsName(bytes, 'word/media/image1.jpg'), true)
  assert.match(rawText(bytes), /Extension="jpg" ContentType="image\/jpeg"/)
})

test('docx 嵌图：找不到图片时降级为一行可读占位，不静默丢图', () => {
  const bytes = buildDocx({
    title: 't',
    markdown: '![图 4-2 模块图](../assets/图/missing.png)',
    images: new Map(),
  })
  const text = rawText(bytes)
  assert.match(text, /图片文件未找到/)
  assert.match(text, /图 4-2 模块图/)
  assert.equal(zipContainsName(bytes, 'word/media/'), false)
})
