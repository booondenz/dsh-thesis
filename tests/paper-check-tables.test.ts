import { test } from 'node:test'
import assert from 'node:assert/strict'
import { countTablesAndCaptions } from '../src/paper/lib/check.ts'

test('表格/表题计数：有表有题时相等', () => {
  const text = [
    '系统划分为六个模块，如表 4-1 所示。',
    '',
    '表 4-1 模块划分',
    '',
    '| 模块 | 职责 |',
    '|---|---|',
    '| raft | 选举与复制 |',
    '',
    '表 4-2 核心数据结构',
    '',
    '| 结构 | 字段 |',
    '|---|---|',
    '| Task | ID/Name |',
  ].join('\n')
  assert.deepEqual(countTablesAndCaptions(text, 4), { tables: 2, captions: 2 })
})

test('表格/表题计数：正文里的「如表 4-1 所示」不算表题', () => {
  const text = '如表 4-1 所示，系统分为六层。\n\n| 层 | 职责 |\n|---|---|\n| 接入 | 路由 |'
  assert.deepEqual(countTablesAndCaptions(text, 4), { tables: 1, captions: 0 })
})

test('表格/表题计数：别的章的表题不算本章（按章号匹配）', () => {
  const text = '表 5-1 别的章\n\n| a | b |\n|---|---|\n| 1 | 2 |'
  assert.deepEqual(countTablesAndCaptions(text, 4), { tables: 1, captions: 0 })
})

test('表格/表题计数：连续多个表块分别计数', () => {
  const text = [
    '| a | b |',
    '|---|---|',
    '',
    '正文一段。',
    '',
    '| c | d |',
    '|---|---|',
  ].join('\n')
  assert.equal(countTablesAndCaptions(text, 3).tables, 2)
})
