/**
 * draw.io 导出链路：探测、命令构造、产物校验、说明渲染。
 *
 * 重点钉住「退出码 0 不等于成功」：桌面版静默失败时，工具必须报错而不是
 * 交出一个 0 字节的 PNG。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as nodePath from 'node:path'
import {
  DEFAULT_SCALE, detectDrawio, drawioGuide, exportDiagram, renderExportNotes,
  type SpawnResult,
} from '../src/figure/lib/export.ts'

function okSpawn(stdout = 'exported'): (command: string, args: readonly string[]) => SpawnResult {
  return () => ({ status: 0, stdout, stderr: null })
}

test('探测：配置路径优先，其次 PATH，最后常见安装目录', () => {
  const configured = detectDrawio({
    configured: 'D:\\tools\\drawio\\drawio.exe',
    exists: path => path === 'D:\\tools\\drawio\\drawio.exe',
    platform: 'win32',
    env: { PATH: 'C:\\Windows' },
  })
  assert.equal(configured.engine?.source, 'config')
  assert.equal(configured.engine?.command, 'D:\\tools\\drawio\\drawio.exe')

  // PATH 探测用「宿主自己的分隔符与 join」：CI 跑在 Linux、开发机跑在 Windows，
  // 写死 win32 的盘符路径会被 POSIX 的 ':' 切碎（'C:\Windows' 里有冒号）。
  const pathDirs = [nodePath.join('/', 'usr', 'bin'), nodePath.join('/', 'opt', 'tools')]
  const fromPath = detectDrawio({
    platform: 'linux',
    env: { PATH: pathDirs.join(nodePath.delimiter) },
    exists: path => path === nodePath.join(pathDirs[1]!, 'drawio'),
  })
  assert.equal(fromPath.engine?.source, 'path')

  const fromCommon = detectDrawio({
    platform: 'win32',
    env: { PATH: '', LOCALAPPDATA: '' },
    exists: path => path === 'C:\\Program Files\\draw.io\\draw.io.exe',
  })
  assert.equal(fromCommon.engine?.source, 'common')
  assert.match(fromCommon.engine?.label ?? '', /安装目录/)
})

test('探测：找不到不是错误，而是可解释的「本机没装」', () => {
  const detection = detectDrawio({ platform: 'win32', env: { PATH: 'C:\\Windows' }, exists: () => false })
  assert.equal(detection.engine, undefined)
  assert.ok(detection.probes.length > 0, '要记录检查过哪些候选路径')
  assert.match(detection.problems.join('\n'), /未发现 draw\.io 桌面版/)
})

test('导出命令：--export --format png --scale 3 --border 10 --output，参数顺序稳定', () => {
  const calls: { command: string; args: readonly string[] }[] = []
  const outcome = exportDiagram(
    { command: 'drawio', label: 'draw.io', source: 'path' },
    'E:\\thesis\\assets\\a.drawio',
    'E:\\thesis\\assets\\a.png',
    {
      scale: 3,
      format: 'png',
      spawn: (command, args) => { calls.push({ command, args }); return { status: 0, stdout: 'ok', stderr: null } },
      exists: () => true,
      size: () => 4096,
    },
  )
  assert.equal(outcome.ok, true)
  assert.equal(outcome.bytes, 4096)
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0]!.args, [
    '--export', '--format', 'png', '--scale', '3', '--border', '10',
    '--output', 'E:\\thesis\\assets\\a.png', 'E:\\thesis\\assets\\a.drawio',
  ])
})

test('导出失败：非 0 退出码必须抛错并带上完整命令', () => {
  assert.throws(() => exportDiagram(
    { command: 'drawio', label: 'draw.io', source: 'path' },
    'a.drawio',
    'a.png',
    { spawn: () => ({ status: 2, stdout: '', stderr: 'invalid file', error: undefined }), exists: () => false },
  ), /退出码 2[\s\S]*invalid file/)
})

test('导出失败：退出码 0 但没写文件 / 写了 0 字节，都不能算成功', () => {
  assert.throws(() => exportDiagram(
    { command: 'drawio', label: 'draw.io', source: 'path' },
    'a.drawio',
    'a.png',
    { spawn: okSpawn(), exists: () => false },
  ), /退出码为 0，但没有写出/)

  assert.throws(() => exportDiagram(
    { command: 'drawio', label: 'draw.io', source: 'path' },
    'a.drawio',
    'a.png',
    { spawn: okSpawn(), exists: () => true, size: () => 0 },
  ), /0 字节/)
})

test('导出失败：命令压根起不来（EPERM/ENOENT）也要说清', () => {
  assert.throws(() => exportDiagram(
    { command: 'drawio', label: 'draw.io', source: 'path' },
    'a.drawio',
    'a.png',
    { spawn: () => { throw new Error('spawn drawio EPERM') } },
  ), /未能启动[\s\S]*EPERM/)
})

test('导出说明：记录探测、命令、退出码与替代路径', () => {
  const detection = detectDrawio({ platform: 'win32', env: { PATH: 'C:\\Windows' }, exists: () => false })
  const notes = renderExportNotes({
    items: [{
      figureRel: '06-论文/assets/图/a.drawio',
      error: 'exit 2',
    }],
    detection,
    format: 'png',
    scale: DEFAULT_SCALE,
    now: new Date('2026-03-01T00:00:00.000Z'),
  })
  assert.match(notes, /# 插图导出说明/)
  assert.match(notes, /未发现 draw\.io 桌面版/)
  assert.match(notes, /2026-03-01T00:00:00\.000Z/)
  assert.match(notes, /app\.diagrams\.net/)
  assert.match(notes, /hediet\.vscode-drawio/)
  assert.match(notes, /winget install --id JGraph\.Draw -e/)
})

test('导出说明：成功的那张记录命令、退出码与产物大小', () => {
  const detection = detectDrawio({ exists: path => path === 'drawio', platform: 'linux' })
  const notes = renderExportNotes({
    items: [{
      figureRel: '06-论文/assets/图/a.drawio',
      imageRel: '06-论文/assets/图/a.png',
      outcome: {
        ok: true,
        outPath: '06-论文/assets/图/a.png',
        bytes: 2048,
        record: {
          label: 'draw.io 导出',
          command: 'drawio',
          args: ['--export', '--format', 'png', '--scale', '3', '--border', '10', '--output', 'a.png', 'a.drawio'],
          status: 0,
          ok: true,
          stdout: '',
          stderr: '',
          elapsedMs: 321,
          timedOut: false,
        },
      },
    }],
    detection,
    format: 'png',
    scale: 3,
  })
  assert.match(notes, /命令：`drawio --export --format png --scale 3 --border 10 --output a\.png a\.drawio`/)
  assert.match(notes, /退出码：0；耗时：321 ms/)
  assert.match(notes, /2048 字节/)
})

test('指引：装桌面版、手工导出、四条硬规则都在', () => {
  const guide = drawioGuide()
  assert.match(guide, /winget install --id JGraph\.Draw -e/)
  assert.match(guide, /sudo snap install drawio/)
  assert.match(guide, /--scale 3 --border 10/)
  assert.match(guide, /app\.diagrams\.net/)
  assert.match(guide, /图题在图下方/)
  assert.match(guide, /thesis_figure action=check/)
})
