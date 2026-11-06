/**
 * 测试用内存文件系统：实现插件所需的最小 FileSystem 表面。
 * 行为约定：readText 文件缺失即抛错；listDir 目录缺失即抛错；
 * writeText 自动创建父目录。
 */

import * as nodePath from 'node:path'
import type { FileSystem, FsDirEntry, FsTarget } from '@deepseek-ai/dsh-fs'

export class FakeFs implements FileSystem {
  private readonly files = new Map<string, string>()

  constructor() {}

  private key(p: string): string {
    // 用 resolve 而非 normalize：真实文件服务（与 findThesisRoot）拿到的是
    // 已解析的绝对路径；Windows 上 normalize('/tmp/x') 不补盘符而 resolve 会补，
    // 两者不一致会让「init 写入 → 向上探测读取」在 Windows 上假失败。
    return nodePath.resolve(p)
  }

  get size(): number {
    return this.files.size
  }

  peek(p: string): string | undefined {
    return this.files.get(this.key(p))
  }

  async resolve(path: string, _opts?: { cwd?: string; signal?: AbortSignal }): Promise<FsTarget> {
    return { displayPath: path }
  }

  async readText(target: FsTarget, _signal?: AbortSignal): Promise<string> {
    const content = this.files.get(this.key(target.displayPath))
    if (content === undefined) {
      const err = new Error(`ENOENT: ${target.displayPath}`) as Error & { code?: string }
      err.code = 'ENOENT'
      throw err
    }
    return content
  }

  async writeText(target: FsTarget, content: string): Promise<{ version?: unknown }> {
    this.files.set(this.key(target.displayPath), content)
    return { version: 1 }
  }

  async listDir(target: FsTarget, _signal?: AbortSignal): Promise<FsDirEntry[]> {
    const dir = this.key(target.displayPath)
    const entries: FsDirEntry[] = []
    const seen = new Set<string>()
    let found = false
    for (const key of this.files.keys()) {
      if (key === dir) continue
      if (!key.startsWith(dir + nodePath.sep)) continue
      found = true
      const rest = key.slice(dir.length + 1)
      const name = rest.split(nodePath.sep)[0]!
      if (!seen.has(name)) {
        seen.add(name)
        entries.push({ name, isDirectory: false })
      }
    }
    if (!found && !this.files.has(dir)) {
      const err = new Error(`ENOENT: ${dir}`) as Error & { code?: string }
      err.code = 'ENOENT'
      throw err
    }
    return entries
  }

  async stat(target: FsTarget, _signal?: AbortSignal) {
    const path = this.key(target.displayPath)
    const content = this.files.get(path)
    if (content !== undefined) {
      return { isDirectory: false, size: content.length, version: 1 }
    }
    // 目录：存在以 `${path}\` 开头的键，就当作目录。
    if ([...this.files.keys()].some(key => key.startsWith(path + nodePath.sep))) {
      return { isDirectory: true, size: 0, version: 1 }
    }
    const err = new Error(`ENOENT: ${target.displayPath}`) as Error & { code?: string }
    err.code = 'ENOENT'
    throw err
  }
}
