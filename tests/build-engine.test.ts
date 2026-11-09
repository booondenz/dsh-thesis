/**
 * 构建引擎选择：pandoc / python-docx / 内置引擎的优先级与降级。
 *
 * 这些用例把"真机上装没装"换成布尔输入，钉死的是**决策**而不是环境：
 * 有学校模板的 pandoc 最准 → 没有则 python-docx 排版最全 → 再退无模板的 pandoc
 * → 最后才是内置引擎。
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { chooseEngine, engineLabel } from '../src/paper/tools/build.ts'
import { detectPythonDocx } from '../src/paper/lib/py-docx.ts'

const matrix: Array<{ name: string, input: Parameters<typeof chooseEngine>[0], expected: string }> = [
  { name: '有模板的 pandoc 最优先（学校样式最准）', input: { requested: 'auto', hasPandoc: true, hasTemplate: true, hasPython: true }, expected: 'pandoc' },
  { name: '没有模板就走 python-docx（排版更全）', input: { requested: 'auto', hasPandoc: true, hasTemplate: false, hasPython: true }, expected: 'py' },
  { name: '只有 python-docx 时用它', input: { requested: 'auto', hasPandoc: false, hasTemplate: false, hasPython: true }, expected: 'py' },
  { name: '只有 pandoc（无模板）也用它', input: { requested: 'auto', hasPandoc: true, hasTemplate: false, hasPython: false }, expected: 'pandoc' },
  { name: '都没有就退回内置引擎', input: { requested: 'auto', hasPandoc: false, hasTemplate: false, hasPython: false }, expected: 'internal' },
  { name: '显式 internal 不被抢占', input: { requested: 'internal', hasPandoc: true, hasTemplate: true, hasPython: true }, expected: 'internal' },
  { name: '显式 py', input: { requested: 'py', hasPandoc: true, hasTemplate: true, hasPython: true }, expected: 'py' },
]

for (const item of matrix) {
  test(`引擎选择：${item.name}`, () => {
    assert.equal(chooseEngine(item.input), item.expected)
  })
}

test('引擎选择：显式请求但环境不具备时给可读错误，而不是静默降级', () => {
  assert.throws(
    () => chooseEngine({ requested: 'pandoc', hasPandoc: false, hasTemplate: false, hasPython: true }),
    /未安装 pandoc/,
  )
  assert.throws(
    () => chooseEngine({ requested: 'py', hasPandoc: false, hasTemplate: false, hasPython: false }),
    /python-docx/,
  )
})

test('引擎名字：三种引擎各自可读，且不把内置引擎说成"学校模板排版"', () => {
  assert.match(engineLabel('py'), /python-docx/)
  assert.match(engineLabel('pandoc'), /pandoc/)
  assert.match(engineLabel('internal'), /内置/)
  assert.doesNotMatch(engineLabel('internal'), /模板/)
})

test('python 探测：跳过 import 失败的候选，记录探测路径', () => {
  const attempted: string[] = []
  const detection = detectPythonDocx({
    env: { DSH_THESIS_PYTHON: '/opt/fake/python' },
    probe: (command) => {
      attempted.push(command)
      const ok = command === 'python'
      return {
        ok,
        status: ok ? 0 : 1,
        stdout: ok ? '1.2.0' : '',
        stderr: '',
        error: undefined,
        timedOut: false,
      }
    },
  })
  assert.equal(detection.python?.version, '1.2.0', '应采用第一个能 import docx 的解释器')
  assert.equal(detection.python?.source, 'path')
  assert.ok(detection.probes.includes('/opt/fake/python'), '探测过配置的那一个')
})

test('python 探测：全都不可用时返回空，而不是猜一个', () => {
  const detection = detectPythonDocx({
    env: {},
    probe: () => ({ ok: false, status: 1, stdout: '', stderr: 'No module named docx', error: undefined, timedOut: false }),
  })
  assert.equal(detection.python, undefined)
  assert.ok(detection.probes.length > 0, '要留下探测痕迹供构建说明使用')
})

test('随包发布的排版脚本存在（files 里少了 assets 就会在这里红）', () => {
  const script = fileURLToPath(new URL('../assets/build_docx.py', import.meta.url))
  assert.ok(existsSync(script), `缺少 ${script}`)
})
