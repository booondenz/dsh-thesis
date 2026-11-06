/**
 * 图表体检：四类真实的「图出问题」场景。
 *
 * 每条断言都对应学生真会踩的坑：图改了没重导、正文引用断链、图题没编号、
 * 图号跳号、图躺尸在 assets 里没人用、导出分辨率不够印刷。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  checkFigures, parseCaption, renderFigureReport, stemOf,
  type FigureCheckInput,
} from '../src/figure/lib/check.ts'

const SOURCE = '06-论文/assets/图/arch.drawio'
const IMAGE = '06-论文/assets/图/arch.png'

function input(overrides: Partial<FigureCheckInput> = {}): FigureCheckInput {
  return {
    sources: [{ path: SOURCE, mtimeMs: 1000 }],
    images: [{ path: IMAGE, mtimeMs: 2000, widthPx: 2400 }],
    references: [{
      chapter: '04-系统设计',
      chapterNo: 4,
      line: 12,
      alt: '图 4-1 系统总体架构图',
      src: '../assets/图/arch.png',
      resolvedPath: IMAGE,
    }],
    ...overrides,
  }
}

test('图题解析：只认「图 章号-序号 标题」', () => {
  assert.deepEqual(parseCaption('图 4-1 系统总体架构图'), { chapter: 4, index: 1 })
  assert.deepEqual(parseCaption('图4-12 接口时序图'), { chapter: 4, index: 12 })
  assert.equal(parseCaption('系统总体架构图'), undefined)
  assert.equal(parseCaption('图 4-1'), undefined, '没有图名不算规范图题')
  assert.equal(stemOf('06-论文/assets/图/arch.png'), 'arch')
})

test('一切正常时零问题，清单里能对上源文件与导出件', () => {
  const result = checkFigures(input())
  assert.equal(result.errors, 0)
  assert.equal(result.warnings, 0)
  assert.equal(result.entries.length, 1)
  assert.equal(result.entries[0]!.source, SOURCE)
  assert.equal(result.entries[0]!.image, IMAGE)
  assert.deepEqual(result.entries[0]!.references, ['04-系统设计'])
})

test('源文件没有导出件 → error（图源在但论文里没有图）', () => {
  const result = checkFigures(input({ images: [], references: [] }))
  assert.equal(result.errors, 1)
  assert.match(result.issues[0]!.message, /没有导出件/)
  assert.match(result.issues[0]!.message, /thesis_figure action=export/)
})

test('导出件比源文件旧 → warn（改过图但忘了重导）', () => {
  const result = checkFigures(input({ images: [{ path: IMAGE, mtimeMs: 500, widthPx: 2400 }] }))
  assert.equal(result.errors, 0)
  assert.equal(result.warnings, 1)
  assert.match(result.issues[0]!.message, /比源文件 .* 旧/)
})

test('正文引用的图片不存在 → error，并提示相对章节文件的写法', () => {
  const result = checkFigures(input({
    references: [{ chapter: '04-系统设计', chapterNo: 4, line: 12, alt: '图 4-1 系统总体架构图', src: '../assets/图/typo.png' }],
  }))
  assert.equal(result.errors, 1)
  assert.match(result.issues[0]!.message, /引用的图片不存在/)
  assert.match(result.issues[0]!.message, /\.\.\/assets\/图\//)
})

test('图片没有规范图题 → error；图题章号写错 → error', () => {
  const missing = checkFigures(input({
    references: [{ chapter: '04-系统设计', chapterNo: 4, line: 12, alt: '', src: '../assets/图/arch.png', resolvedPath: IMAGE }],
  }))
  assert.equal(missing.errors, 1)
  assert.match(missing.issues[0]!.message, /缺少规范图题/)

  const wrongChapter = checkFigures(input({
    references: [{ chapter: '04-系统设计', chapterNo: 4, line: 12, alt: '图 3-1 系统总体架构图', src: '../assets/图/arch.png', resolvedPath: IMAGE }],
  }))
  assert.equal(wrongChapter.errors, 1)
  assert.match(wrongChapter.issues[0]!.message, /图题章号是 3/)
})

test('同章图号必须连续 → 跳号/重号都是 error', () => {
  const result = checkFigures(input({
    images: [
      { path: IMAGE, mtimeMs: 2000, widthPx: 2400 },
      { path: '06-论文/assets/图/flow.png', mtimeMs: 2000, widthPx: 2400 },
    ],
    sources: [{ path: SOURCE, mtimeMs: 1000 }, { path: '06-论文/assets/图/flow.drawio', mtimeMs: 1000 }],
    references: [
      { chapter: '04-系统设计', chapterNo: 4, line: 12, alt: '图 4-1 系统总体架构图', src: '../assets/图/arch.png', resolvedPath: IMAGE },
      { chapter: '04-系统设计', chapterNo: 4, line: 30, alt: '图 4-3 业务流程图', src: '../assets/图/flow.png', resolvedPath: '06-论文/assets/图/flow.png' },
    ],
  }))
  assert.equal(result.errors, 1)
  assert.match(result.issues[0]!.message, /中间缺 4-2/)

  const duplicate = checkFigures(input({
    references: [
      { chapter: '04-系统设计', chapterNo: 4, line: 12, alt: '图 4-1 系统总体架构图', src: '../assets/图/arch.png', resolvedPath: IMAGE },
      { chapter: '04-系统设计', chapterNo: 4, line: 20, alt: '图 4-1 重复的图题', src: '../assets/图/arch.png', resolvedPath: IMAGE },
    ],
  }))
  assert.equal(duplicate.errors, 1)
  assert.match(duplicate.issues[0]!.message, /图号不能重复/)
})

test('第一张图不是 -1 时：正文提到过前一张就放行，否则报断档', () => {
  const base = {
    references: [{ chapter: '04-系统设计', chapterNo: 4, line: 12, alt: '图 4-2 业务流程图', src: '../assets/图/arch.png', resolvedPath: IMAGE }],
  }
  const mentioned = checkFigures({
    ...input(base),
    chapterTexts: [{ chapter: '04-系统设计', text: '如图 4-1 所示，这是架构图。' }],
  })
  assert.equal(mentioned.errors, 0, '正文提到过 图 4-1，说明前面还有一张（例如截图），不算断档')

  const missingPrevious = checkFigures({
    ...input(base),
    chapterTexts: [{ chapter: '04-系统设计', text: '本章只有一张图。' }],
  })
  assert.equal(missingPrevious.errors, 1)
  assert.match(missingPrevious.issues[0]!.message, /缺 图 4-1/)
})

test('图躺在 assets 里没人引用 / 分辨率过低 → warn（不阻塞，但要修）', () => {
  const unused = checkFigures(input({ references: [] }))
  assert.equal(unused.warnings, 1, '没人引用的图只提示一次')
  assert.ok(unused.issues.some(issue => /没有被任何章节引用/.test(issue.message)))

  const lowRes = checkFigures(input({ images: [{ path: IMAGE, mtimeMs: 2000, widthPx: 600 }] }))
  assert.equal(lowRes.errors, 0)
  assert.ok(lowRes.issues.some(issue => /只有 600px 宽/.test(issue.message)))
})

test('报告：清单表格 + 结论 + 合计，可随论文提交', () => {
  const result = checkFigures(input({ images: [] , references: [] }))
  const report = renderFigureReport(result, new Date('2026-03-01T00:00:00.000Z'))
  assert.match(report, /# 图表清单/)
  assert.match(report, /\| arch \| 06-论文\/assets\/图\/arch\.drawio \| （未导出） \|/)
  assert.match(report, /合计：1 个必须修的问题/)
  assert.match(report, /thesis_figure action=check/)
})
