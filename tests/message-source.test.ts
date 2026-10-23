/**
 * 注入消息的 source kind 回归测试。
 *
 * 背景：v4 会话格式要求消息 source 是「生产者自有 kind」，兜底值 `plugin`
 * 会在写会话日志时抛 `format v4 message requires a producer-owned source kind`，
 * 2.0.1 因此让论文工作区里的新会话直接起不来。这里把约定钉死：
 * 常量正确，且 src/ 里不再出现 `kind: 'plugin'` 这种写法。
 *
 * @module dsh-thesis/tests/message-source
 */

import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { THESIS_SOURCE, THESIS_SOURCE_KIND } from '../src/shared/message-source.ts'

const SRC = fileURLToPath(new URL('../src/', import.meta.url))

/** 递归收集 src/ 下的 .ts 文件。 */
function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...sourceFiles(path))
    else if (entry.name.endsWith('.ts')) out.push(path)
  }
  return out
}

test('注入消息的生产者 kind 是 plugin:dsh-thesis', () => {
  assert.equal(THESIS_SOURCE_KIND, 'plugin:dsh-thesis')
  assert.equal(THESIS_SOURCE.kind, THESIS_SOURCE_KIND)
  assert.notEqual(THESIS_SOURCE_KIND, 'plugin', 'v4 会话格式禁止兜底 kind')
})

test('src/ 里没有任何消息用兜底 kind plugin', () => {
  const offenders = sourceFiles(SRC)
    .filter(path => readFileSync(path, 'utf8').includes("kind: 'plugin'"))
    .map(path => path.slice(SRC.length))
  assert.deepEqual(offenders, [], `这些文件还在用 kind: 'plugin'：${offenders.join(', ')}`)
})
