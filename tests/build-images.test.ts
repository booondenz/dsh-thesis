/**
 * thesis_build 的插图链路：章节里的 `![](路径)` → 真实图片字节 → docx 里的 media 部件。
 *
 * 用真实临时目录跑（图片是二进制，内存文件系统装不下），断言「学生写完正文、跑一次
 * 构建，图真的出现在 Word 里」。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import { tmpdir } from 'node:os'
import { readdir } from 'node:fs/promises'
import { runBuild, buildSummary } from '../src/paper/tools/build.ts'
import { zipContainsName } from '../src/paper/lib/zip.ts'

/** 真实磁盘适型的 FileSystem（与 e2e 里的一致）。 */
const realFs = {
  async resolve(path: string, opts?: { cwd?: string }) {
    const resolved = opts?.cwd !== undefined && !isAbsolute(path) ? join(opts.cwd, path) : path
    return { displayPath: resolved }
  },
  async readText(target: { displayPath: string }) {
    return await readFile(target.displayPath, 'utf8')
  },
  async writeText(target: { displayPath: string }, content: string) {
    await mkdir(dirname(target.displayPath), { recursive: true })
    await writeFile(target.displayPath, content, 'utf8')
    return { version: 1 }
  },
  async listDir(target: { displayPath: string }) {
    const entries = await readdir(target.displayPath, { withFileTypes: true })
    return entries.map(entry => ({ name: entry.name, isDirectory: entry.isDirectory() }))
  },
  async stat(target: { displayPath: string }) {
    try {
      const info = await stat(target.displayPath)
      return { isDirectory: info.isDirectory(), size: info.size, version: info.mtimeMs }
    } catch {
      return undefined
    }
  },
}

async function writeBinary(absPath: string, data: Uint8Array): Promise<void> {
  await mkdir(dirname(absPath), { recursive: true })
  await writeFile(absPath, data)
}

function pngBytes(width = 2400, height = 1200): Uint8Array {
  const bytes = new Uint8Array(33)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
  bytes.set([0x00, 0x00, 0x00, 0x0d], 8)
  bytes.set([0x49, 0x48, 0x44, 0x52], 12)
  bytes.set([(width >>> 24) & 0xff, (width >>> 16) & 0xff, (width >>> 8) & 0xff, width & 0xff], 16)
  bytes.set([(height >>> 24) & 0xff, (height >>> 16) & 0xff, (height >>> 8) & 0xff, height & 0xff], 20)
  return bytes
}

async function makeWorkspace(name: string, chapter: string): Promise<string> {
  const root = join(tmpdir(), `dsh-build-images-${process.pid}-${name}`)
  await rm(root, { recursive: true, force: true })
  await mkdir(join(root, '00-管理'), { recursive: true })
  await mkdir(join(root, '06-论文/章节'), { recursive: true })
  await mkdir(join(root, '06-论文/产出'), { recursive: true })
  await writeFile(join(root, '00-管理/进度台账.md'), '# 进度台账\n', 'utf8')
  await writeFile(join(root, '06-论文/章节/04-系统设计.md'), `# 第 4 章 系统设计\n\n${chapter}\n`, 'utf8')
  return root
}

test('构建：章节引用的 PNG 被嵌入 docx（media + drawing + 图题）', async () => {
  const root = await makeWorkspace('ok', [
    '- [x] 已阅读本章',
    '',
    '如图 4-1 所示，系统采用分层架构。',
    '',
    '![图 4-1 系统总体架构图](../assets/图/arch.png)',
  ].join('\n'))
  await mkdir(join(root, '06-论文/assets/图'), { recursive: true })
  await writeFile(join(root, '06-论文/assets/图/arch.png'), pngBytes(2400, 1200))

  const outcome = await runBuild(realFs, { engine: 'internal' }, root, undefined, writeBinary)
  assert.equal(outcome.engine, 'internal')
  assert.equal(outcome.images, 1)
  assert.deepEqual(outcome.imageProblems, [])
  assert.deepEqual(outcome.chapters, ['04-系统设计'])

  const docx = await readFile(join(root, '06-论文/产出/论文.docx'))
  assert.equal(zipContainsName(new Uint8Array(docx), 'word/media/image1.png'), true)
  const text = new TextDecoder().decode(new Uint8Array(docx))
  assert.match(text, /<w:drawing>/)
  assert.match(text, /图 4-1 系统总体架构图/)

  const note = await readFile(join(root, '06-论文/产出/构建说明.md'), 'utf8')
  assert.match(note, /插图：1 张已嵌入/)
  const summary = buildSummary(outcome)
  assert.match(summary, /插图：1 张已嵌入/)

  await rm(root, { recursive: true, force: true })
})

test('构建：图片路径写错时不静默丢图——docx 里留占位，构建说明列问题', async () => {
  const root = await makeWorkspace('missing', [
    '- [x] 已阅读本章',
    '',
    '![图 4-2 模块图](../assets/图/typo.png)',
  ].join('\n'))
  const outcome = await runBuild(realFs, { engine: 'internal' }, root, undefined, writeBinary)
  assert.equal(outcome.images, 0)
  assert.equal(outcome.imageProblems.length, 1)
  assert.match(outcome.imageProblems[0]!, /图片不存在/)

  const docx = await readFile(join(root, '06-论文/产出/论文.docx'))
  const text = new TextDecoder().decode(new Uint8Array(docx))
  assert.match(text, /图片文件未找到/)
  assert.equal(zipContainsName(new Uint8Array(docx), 'word/media/'), false)

  const note = await readFile(join(root, '06-论文/产出/构建说明.md'), 'utf8')
  assert.match(note, /1 处有问题/)
  assert.match(buildSummary(outcome), /需处理/)

  await rm(root, { recursive: true, force: true })
})
