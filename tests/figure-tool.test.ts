/**
 * `thesis_figure` 工具层：建图 → 导出 → 体检，跑在内存文件系统上。
 *
 * 这里验证的是「学生视角的闭环」：工具真的把 .drawio 写进 assets/图、
 * 图题真的按章号自动编号、没装 draw.io 时真的不假装成功、check 真的能
 * 从章节正文里认出图片引用。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as nodePath from 'node:path'
import { FakeFs } from './paper-fixtures.ts'
import {
  FIGURE_DIR, FIGURE_INVENTORY, FIGURE_NOTES,
  extractReferences, nextFigureIndex, resolveChapter, runFigureAction, slugify,
} from '../src/figure/actions.ts'
import type { DrawioDetection, ExportOutcome } from '../src/figure/lib/export.ts'

const ROOT = nodePath.resolve('/tmp/thesis-figure')
const OPTIONS = { scale: 3, timeoutMs: 1000 }

async function write(fs: FakeFs, rel: string, content: string): Promise<void> {
  await fs.writeText(await fs.resolve(nodePath.join(ROOT, rel)), content)
}

async function makeWorkspace(): Promise<FakeFs> {
  const fs = new FakeFs()
  await write(fs, '00-管理/进度台账.md', '# 进度台账\n')
  return fs
}

const ENGINE: DrawioDetection = {
  engine: { command: 'drawio', label: 'draw.io（测试替身）', source: 'path' },
  probes: ['drawio'],
  problems: [],
}

function fakeExport(outPath: string): ExportOutcome {
  return {
    ok: true,
    outPath,
    bytes: 4096,
    record: {
      label: 'draw.io 导出',
      command: 'drawio',
      args: ['--export', '--format', 'png', '--scale', '3', '--border', '10', '--output', outPath, 'x.drawio'],
      status: 0,
      ok: true,
      stdout: '',
      stderr: '',
      elapsedMs: 12,
      timedOut: false,
    },
  }
}

test('小工具：文件名清洗、章节解析、图号递增、引用解析', () => {
  assert.equal(slugify('系统 总体/架构图'), '系统-总体-架构图')
  assert.equal(slugify('  '), '')
  assert.deepEqual(resolveChapter('04-系统设计'), { file: '04-系统设计', chapterNo: 4 })
  assert.deepEqual(resolveChapter('4'), { file: '04-系统设计', chapterNo: 4 })
  assert.deepEqual(resolveChapter('系统设计'), { file: '04-系统设计', chapterNo: 4 })
  assert.equal(resolveChapter('第九章'), undefined)
  assert.equal(nextFigureIndex('如图 4-1 所示，图 4-1 xxx；图 4-2 yyy', 4), 3)
  assert.equal(nextFigureIndex('没有图', 4), 1)
  const refs = extractReferences('正文\n![图 4-1 架构图](../assets/图/a.png)\n后续')
  assert.deepEqual(refs, [{ line: 2, alt: '图 4-1 架构图', src: '../assets/图/a.png' }])
})

test('create：写 .drawio、按章自动编号、给出可直接粘贴的 Markdown', async () => {
  const fs = await makeWorkspace()
  const text = await runFigureAction(fs, ROOT, {
    action: 'create',
    kind: 'architecture',
    title: '系统总体架构图',
    chapter: '04-系统设计',
    spec: {
      layers: [
        { name: '表现层', modules: ['Vue 页面', '路由'] },
        { name: '数据层', modules: ['MySQL'] },
      ],
    },
  }, OPTIONS, undefined, { detect: () => ENGINE, runExport: (_engine, _src, outPath) => fakeExport(outPath) })

  assert.match(text, /已生成图源文件：06-论文\/assets\/图\/系统总体架构图\.drawio/)
  assert.match(text, /图题：图 4-1 系统总体架构图/)
  assert.match(text, /导出：06-论文\/assets\/图\/系统总体架构图\.png/)
  assert.match(text, /如图 4-1 所示/)
  const source = fs.peek(nodePath.join(ROOT, FIGURE_DIR, '系统总体架构图.drawio'))!
  assert.match(source, /<mxfile/)
  assert.match(source, /Vue 页面/)
  assert.match(source, /name="系统总体架构图"/)
  assert.ok(fs.peek(nodePath.join(ROOT, FIGURE_NOTES))!.includes('# 插图导出说明'), '导出说明必须落盘')
})

test('create：章节里已有 图 4-1 时自动编号为 4-2', async () => {
  const fs = await makeWorkspace()
  await write(fs, '06-论文/章节/04-系统设计.md', '# 第 4 章\n\n如图 4-1 所示。\n\n![图 4-1 已有图](../assets/图/old.png)\n')
  const text = await runFigureAction(fs, ROOT, {
    action: 'create',
    kind: 'er',
    name: 'db-er',
    title: '数据库 E-R 图',
    chapter: '4',
    export: false,
    spec: {
      entities: [{ name: '用户', fields: [{ name: 'id', type: 'bigint', key: true }] }],
    },
  }, OPTIONS, undefined, { detect: () => ({ probes: [], problems: [] }) })
  assert.match(text, /图题：图 4-2 数据库 E-R 图/)
  assert.match(text, /导出：已跳过（export=false）/)
})

test('create：custom 手写 mxfile 原样落盘并同样导出', async () => {
  const fs = await makeWorkspace()
  const xml = '<mxfile><diagram><mxGraphModel><root><mxCell id="0"/></root></mxGraphModel></diagram></mxfile>'
  const text = await runFigureAction(fs, ROOT, {
    action: 'create',
    kind: 'custom',
    name: 'my-uml',
    title: '用例图',
    chapter: '3',
    spec: { xml },
  }, OPTIONS, undefined, { detect: () => ENGINE, runExport: (_engine, _src, outPath) => fakeExport(outPath) })
  assert.equal(fs.peek(nodePath.join(ROOT, FIGURE_DIR, 'my-uml.drawio')), xml, 'custom 图不做二次包装')
  assert.match(text, /图题：图 3-1 用例图/)
  assert.match(text, /导出：06-论文\/assets\/图\/my-uml\.png/)
})

test('create：同名不覆盖，force 时旧图另存备份', async () => {
  const fs = await makeWorkspace()
  const args = {
    action: 'create' as const,
    kind: 'flow' as const,
    name: 'flow',
    title: '业务流程图',
    export: false as const,
    spec: {
      nodes: [{ id: 's', text: '开始', kind: 'start' as const }],
      edges: [],
    },
  }
  // 流程至少需要一条边，先用合法规格建一次
  const valid = {
    ...args,
    spec: {
      nodes: [{ id: 's', text: '开始', kind: 'start' as const }, { id: 'e', text: '结束', kind: 'end' as const }],
      edges: [{ from: 's', to: 'e' }],
    },
  }
  await runFigureAction(fs, ROOT, valid, OPTIONS, undefined, { detect: () => ({ probes: [], problems: [] }) })
  await assert.rejects(
    () => runFigureAction(fs, ROOT, valid, OPTIONS, undefined, { detect: () => ({ probes: [], problems: [] }) }),
    /已存在/,
  )
  await write(fs, '06-论文/assets/图/旧.drawio', 'old')
  const forced = await runFigureAction(fs, ROOT, { ...valid, name: '旧', force: true }, OPTIONS, undefined, {
    detect: () => ({ probes: [], problems: [] }),
    now: () => new Date('2026-03-01T00:00:00.000Z'),
  })
  assert.match(forced, /旧文件已备份：06-论文\/assets\/图\/历史\/旧-2026-03-01T00-00-00-000Z\.drawio/)
})

test('create：本机没有 draw.io 时只提示不失败，源文件仍然可用', async () => {
  const fs = await makeWorkspace()
  const text = await runFigureAction(fs, ROOT, {
    action: 'create',
    kind: 'architecture',
    name: 'arch',
    title: '架构图',
    chapter: '4',
    spec: { layers: [{ name: '层', modules: ['模块'] }] },
  }, OPTIONS, undefined, { detect: () => ({ probes: [], problems: ['本机未发现 draw.io 桌面版'] }) })
  assert.match(text, /导出：未执行 —— 本机没有找到 draw\.io 桌面版/)
  assert.match(text, /action=guide/)
  assert.ok(fs.peek(nodePath.join(ROOT, FIGURE_DIR, 'arch.drawio'))!.includes('<mxfile'))
})

test('create：导出失败也保留源文件，并在说明里记下原因', async () => {
  const fs = await makeWorkspace()
  const text = await runFigureAction(fs, ROOT, {
    action: 'create',
    kind: 'sequence',
    name: 'seq',
    title: '登录时序图',
    chapter: '5',
    spec: {
      participants: ['浏览器', '服务'],
      messages: [{ from: '浏览器', to: '服务', text: 'POST /login' }],
    },
  }, OPTIONS, undefined, {
    detect: () => ENGINE,
    runExport: () => { throw new Error('draw.io 导出失败（退出码 1）') },
  })
  assert.match(text, /导出：失败 —— draw\.io 导出失败/)
  assert.ok(fs.peek(nodePath.join(ROOT, FIGURE_NOTES))!.includes('未产出图片'))
})

test('export：没有引擎时抛错并写说明；有引擎时逐张报告', async () => {
  const fs = await makeWorkspace()
  await write(fs, '06-论文/assets/图/a.drawio', '<mxfile><mxGraphModel><root><mxCell id="0"/></root></mxGraphModel></mxfile>')
  await write(fs, '06-论文/assets/图/b.drawio', '<mxfile><mxGraphModel><root><mxCell id="0"/></root></mxGraphModel></mxfile>')

  await assert.rejects(
    () => runFigureAction(fs, ROOT, { action: 'export' }, OPTIONS, undefined, { detect: () => ({ probes: [], problems: ['未安装'] }) }),
    /未发现 draw\.io 桌面版/,
  )

  const text = await runFigureAction(fs, ROOT, { action: 'export', format: 'png' }, OPTIONS, undefined, {
    detect: () => ENGINE,
    runExport: (_engine, _src, outPath) => fakeExport(outPath),
  })
  assert.match(text, /导出完成：2\/2 张（png，3×）/)
  assert.match(text, /a\.drawio → 06-论文\/assets\/图\/a\.png/)
})

test('export：部分失败时如实报告失败张数', async () => {
  const fs = await makeWorkspace()
  await write(fs, '06-论文/assets/图/a.drawio', '<mxfile/>')
  await assert.rejects(
    () => runFigureAction(fs, ROOT, { action: 'export' }, OPTIONS, undefined, {
      detect: () => ENGINE,
      runExport: () => { throw new Error('exit 1') },
    }),
    /1 张图导出失败/,
  )
})

test('check：从章节正文认出引用，产出图表清单', async () => {
  const fs = await makeWorkspace()
  await write(fs, '06-论文/assets/图/arch.drawio', '<mxfile/>')
  await write(fs, '06-论文/assets/图/arch.png', 'png-bytes')
  await write(fs, '06-论文/章节/04-系统设计.md', '# 第 4 章\n\n如图 4-1 所示。\n\n![图 4-1 系统总体架构图](../assets/图/arch.png)\n')
  const text = await runFigureAction(fs, ROOT, { action: 'check' }, OPTIONS, undefined, {
    detect: () => ({ probes: [], problems: [] }),
  })
  assert.match(text, /图表体检：1 张图，0 个必须修的问题/)
  const inventory = fs.peek(nodePath.join(ROOT, FIGURE_INVENTORY))!
  assert.match(inventory, /\| arch \| 06-论文\/assets\/图\/arch\.drawio \| 06-论文\/assets\/图\/arch\.png \| 04-系统设计 \|/)
})

test('check：引用断链与缺图题会被抓出来', async () => {
  const fs = await makeWorkspace()
  await write(fs, '06-论文/assets/图/arch.drawio', '<mxfile/>')
  await write(fs, '06-论文/章节/04-系统设计.md', '# 第 4 章\n\n![架构图](../assets/图/typo.png)\n')
  const text = await runFigureAction(fs, ROOT, { action: 'check' }, OPTIONS, undefined, {
    detect: () => ({ probes: [], problems: [] }),
  })
  assert.match(text, /引用的图片不存在/)
  assert.match(text, /缺少规范图题/)
  assert.match(text, /没有导出件/)
})

test('guide：不需要论文工作区也能给出指引', async () => {
  const fs = new FakeFs()
  const text = await runFigureAction(fs, undefined, { action: 'guide' }, OPTIONS)
  assert.match(text, /winget install --id JGraph\.Draw -e/)
})

test('不在论文工作区时给出与其它工具一致的错误', async () => {
  const fs = new FakeFs()
  await assert.rejects(
    () => runFigureAction(fs, undefined, { action: 'check' }, OPTIONS),
    /未找到论文工作区/,
  )
})
