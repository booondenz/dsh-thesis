/**
 * python-docx 排版引擎：把 `assets/build_docx.py` 跑起来。
 *
 * 为什么要有这条路：内置引擎（`lib/docx.ts`）是零依赖兜底，只覆盖基础排版；
 * 封面、目录域、分节页码、页眉横线这些"纸面规矩"用 python-docx 写要可靠得多。
 * DSH 自带的运行时就包含 python-docx，所以优先用它，拿不到再退回内置引擎。
 *
 * 脚本来源：`assets/build_docx.py`（随包发布，`package.json` 的 `files` 里有 assets）。
 * 它只认一个 JSON 配置文件，读哪些目录写死在论文工作区的约定里。
 *
 * @module dsh-thesis/paper/py-docx
 */

import { existsSync, readdirSync } from 'node:fs'
import { readFile, rm, stat, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import * as nodePath from 'node:path'
import { fileURLToPath } from 'node:url'
import { describeFailure, spawnCommand, type SpawnOutcome } from '../../shared/spawn.ts'

/** 找到一个装了 python-docx 的解释器。 */
export interface PythonInterpreter {
  readonly command: string
  readonly version: string
  /** 从哪里找到的：配置、DSH 自带运行时、还是 PATH。 */
  readonly source: 'env' | 'bundled' | 'path'
}

export interface PyDocxDetection {
  readonly python?: PythonInterpreter
  /** 探测过的候选，写进构建说明，避免"为什么没用上 python"说不清。 */
  readonly probes: readonly string[]
}

/** 探测超时：启动一个解释器导一次库，几秒足够。 */
const PROBE_TIMEOUT_MS = 10_000
/** 单次排版超时：大论文 + 图片，两分钟够用，但不能无限等。 */
const BUILD_TIMEOUT_MS = 180_000

interface Candidate {
  readonly command: string
  readonly source: PythonInterpreter['source']
}

function packagedScriptPath(): string {
  return fileURLToPath(new URL('../../../assets/build_docx.py', import.meta.url))
}

/** 列出候选解释器：配置 → DSH 自带运行时 → PATH。 */
function candidates(env: Readonly<Record<string, string | undefined>>): Candidate[] {
  const list: Candidate[] = []
  const configured = env.DSH_THESIS_PYTHON ?? env.DSH_PYTHON
  if (configured !== undefined && configured.trim() !== '') list.push({ command: configured.trim(), source: 'env' })

  const dshHome = env.DSH_HOME ?? nodePath.join(homedir(), '.dsh')
  const runtimes = nodePath.join(dshHome, 'dsh-runtimes')
  try {
    for (const name of readdirSync(runtimes)) {
      const base = nodePath.join(runtimes, name, 'dependencies', 'python')
      for (const relative of ['python.exe', 'bin/python3', 'bin/python']) {
        const candidate = nodePath.join(base, ...relative.split('/'))
        if (existsSync(candidate)) list.push({ command: candidate, source: 'bundled' })
      }
    }
  } catch {
    // 没有 dsh-runtimes（非桌面安装）：跳过，继续找 PATH。
  }

  list.push({ command: process.platform === 'win32' ? 'python' : 'python3', source: 'path' })
  if (process.platform !== 'win32') list.push({ command: 'python', source: 'path' })
  return list
}

/**
 * 探测一个**真的能 import docx** 的解释器。
 *
 * 只探测"命令存在"是不够的：系统 Python 常常没装 python-docx，
 * 那样会在排版时才失败。这里直接导入一次，导入成功才算可用。
 */
export function detectPythonDocx(options: { env?: Readonly<Record<string, string | undefined>>, probe?: (command: string) => SpawnOutcome } = {}): PyDocxDetection {
  const env = options.env ?? (process.env as Readonly<Record<string, string | undefined>>)
  const probe = options.probe ?? ((command: string) =>
    spawnCommand(command, ['-c', 'import docx; print(docx.__version__)'], { timeoutMs: PROBE_TIMEOUT_MS, capture: true }))
  const probes: string[] = []
  for (const candidate of candidates(env)) {
    probes.push(candidate.command)
    const outcome = probe(candidate.command)
    if (!outcome.ok) continue
    const version = outcome.stdout.trim() === '' ? 'unknown' : outcome.stdout.trim()
    return { python: { command: candidate.command, version, source: candidate.source }, probes }
  }
  return { probes }
}

/** 交给 `assets/build_docx.py` 的配置（字段名与脚本里的 config.get 一一对应）。 */
export interface PyBuildConfig {
  readonly root: string
  readonly out: string
  readonly title?: string
  readonly school?: string
  readonly college?: string
  readonly major?: string
  readonly student?: string
  readonly student_id?: string
  readonly advisor?: string
  readonly date?: string
  readonly toc?: boolean
}

export interface PyBuildOutcome {
  readonly bytes: number
  readonly command: string
  readonly version: string
}

/**
 * 跑一次 python-docx 排版。
 *
 * 判定标准与宿主的子进程约定一致：**退出码为 0 且产物存在且非空**才算成功；
 * 任何一项不满足都抛错，由调用方决定是否退回内置引擎。
 */
export async function buildDocxWithPython(
  python: PythonInterpreter,
  config: PyBuildConfig,
  options: { timeoutMs?: number, scriptPath?: string } = {},
): Promise<PyBuildOutcome> {
  const script = options.scriptPath ?? packagedScriptPath()
  if (!existsSync(script)) {
    throw new Error(`缺少 python 排版脚本：${script}（安装包不完整？重新安装 dsh-thesis 即可）`)
  }
  const configPath = nodePath.join(tmpdir(), `dsh-thesis-py-${process.pid}-${Date.now()}.json`)
  const out = nodePath.resolve(config.out)
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8')
  try {
    const result = spawnCommand(python.command, [script, configPath], {
      timeoutMs: options.timeoutMs ?? BUILD_TIMEOUT_MS,
      capture: true,
    })
    if (!result.ok) {
      throw new Error(`python-docx 排版失败：${describeFailure(python.command, result)}`)
    }
    const info = await stat(out).catch(() => undefined)
    if (info === undefined) {
      throw new Error(`python 退出码为 0，但没有写出 ${out}（见 stderr：${result.stderr.trim().split('\n')[0] ?? ''}）`)
    }
    if (info.size === 0) throw new Error(`python 写出的 ${out} 是 0 字节`)
    return { bytes: info.size, command: python.command, version: python.version }
  } finally {
    await rm(configPath, { force: true }).catch(() => {})
  }
}

/** 读产物字节（与 pandoc 分支共用同一条落盘路径）。 */
export async function readDocxBytes(path: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(path))
}
