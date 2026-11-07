import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isTableCaption, renderTableXml } from '../src/paper/lib/docx.ts'

const ROWS = [
  ['轮次', '选主耗时/ms', '恢复调度耗时/ms', '说明'],
  ['1', '361', '467', '主节点被 kill -9 后重新选主'],
  ['2', '303', '946', 'idle'],
]

test('三线表：只有顶线/底线与表头栏目线，没有竖线和内部横线', () => {
  const xml = renderTableXml(ROWS)
  assert.match(xml, /<w:top w:val="single" w:sz="12"/)
  assert.match(xml, /<w:bottom w:val="single" w:sz="12"/)
  assert.match(xml, /<w:left w:val="none"/)
  assert.match(xml, /<w:right w:val="none"/)
  assert.match(xml, /<w:insideH w:val="none"/)
  assert.match(xml, /<w:insideV w:val="none"/)
  // 不再套用 Word 的 Table Grid 全框线样式
  assert.doesNotMatch(xml, /TableGrid|w:tblStyle/)
  // 表头单元格有栏目线（0.75pt），且只有表头那一行有
  const headerRules = xml.match(/<w:bottom w:val="single" w:sz="6"/g) ?? []
  assert.equal(headerRules.length, ROWS[0]!.length)
})

test('三线表：表头加粗居中、跨页重复，正文五号', () => {
  const xml = renderTableXml(ROWS)
  assert.equal((xml.match(/<w:tblHeader\/>/g) ?? []).length, 1)
  assert.equal((xml.match(/<w:cantSplit\/>/g) ?? []).length, ROWS.length)
  assert.match(xml, /<w:sz w:val="21"\/>/)
  const headerCell = xml.split('<w:tr>')[1]!
  assert.match(headerCell, /<w:b\/>/)
  assert.match(headerCell, /<w:jc w:val="center"\/>/)
})

test('三线表：数字列居中、文字列左对齐', () => {
  const xml = renderTableXml(ROWS)
  // 第 2/3 列是数字，第 4 列是说明文字
  const bodyRow = xml.split('<w:tr>')[2]!
  const cells = bodyRow.split('<w:tc>').slice(1)
  assert.match(cells[1]!, /<w:jc w:val="center"\/>/)
  assert.match(cells[2]!, /<w:jc w:val="center"\/>/)
  assert.match(cells[3]!, /<w:jc w:val="left"\/>/)
})

test('三线表：单元格里的反引号与星号不会漏进 Word', () => {
  const xml = renderTableXml([['模块', '职责'], ['`internal/raft`', '**选举**与复制']])
  assert.match(xml, />internal\/raft</)
  assert.match(xml, />选举</)
  assert.doesNotMatch(xml, /`/)
  assert.doesNotMatch(xml, /\*\*/)
})

test('三线表：列数按最宽行补齐，空单元格也能生成', () => {
  const xml = renderTableXml([['a', 'b', 'c'], ['1']])
  assert.equal((xml.match(/<w:gridCol\/>/g) ?? []).length, 3)
  assert.equal((xml.match(/<w:tr>/g) ?? []).length, 2)
})

test('表题识别：`表 4-1 模块划分` 走 Caption，正文里的「表 4-1 所示」不算', () => {
  assert.equal(isTableCaption('表 4-1 模块划分'), true)
  assert.equal(isTableCaption('表 6-2 3 节点故障转移结果（三次）'), true)
  assert.equal(isTableCaption('如表 4-1 所示，系统分为六层。'), false)
  assert.equal(isTableCaption('表格是论文的重要组成部分。'), false)
})
