/**
 * 一键发版：改版本号 + 提交。`git push` 之后由 publish.yml 自动发布，**不需要打 tag**。
 *
 * 用法：
 *
 * ```
 * npm run release:patch          # 2.0.2 -> 2.0.3
 * npm run release:minor          # 2.0.2 -> 2.1.0
 * npm run release:major          # 2.0.2 -> 3.0.0
 * node scripts/release.ts 2.1.0  # 直接指定版本
 * node scripts/release.ts minor --dry-run
 * ```
 *
 * 为什么要有这个脚本，而不是让人手改 package.json：
 *
 * 1. **版本号有两份**：`package.json` 与 `package-lock.json`（顶层 `version` 和
 *    `packages[""].version`）。只改一份，CI 的 `npm ci` 会报锁文件不同步——这是
 *    发布流程里最常见的一次性失败。
 * 2. **提交信息要与 tag 名一致**：tag 由 workflow 用 `v$(version)` 生成，版本号一改，
 *    提交信息里的 vX.Y.Z 必须跟着变，手写容易漏。
 * 3. **提交只含这两个文件**：用 `git commit -- <paths>` 提交，不会把工作区里
 *    别的已暂存改动卷进来。
 *
 * @module dsh-thesis/scripts/release
 */

import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pkgPath = join(repoRoot, 'package.json')
const lockPath = join(repoRoot, 'package-lock.json')

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const noCommit = args.includes('--no-commit') || dryRun
const mode = args.find(arg => !arg.startsWith('--'))

function die(message) {
  console.error(`[release] ${message}`)
  process.exit(1)
}

function parseSemver(text) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(text.trim())
  if (match === null) return undefined
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), pre: match[4] }
}

function compare(a, b) {
  for (const key of ['major', 'minor', 'patch']) {
    if (a[key] !== b[key]) return a[key] - b[key]
  }
  if (a.pre === b.pre) return 0
  if (a.pre === undefined) return 1
  if (b.pre === undefined) return -1
  return a.pre < b.pre ? -1 : 1
}

const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
const current = parseSemver(pkg.version)
if (current === undefined) die(`package.json 里的版本号不是 semver：${pkg.version}`)

let next
if (mode === undefined) {
  die('用法：npm run release:patch|minor|major，或 node scripts/release.ts 2.1.0')
} else if (mode === 'patch') {
  next = { major: current.major, minor: current.minor, patch: current.patch + 1 }
} else if (mode === 'minor') {
  next = { major: current.major, minor: current.minor + 1, patch: 0 }
} else if (mode === 'major') {
  next = { major: current.major + 1, minor: 0, patch: 0 }
} else {
  next = parseSemver(mode)
  if (next === undefined) die(`无法识别的版本号或档位：${mode}（可用 patch / minor / major / X.Y.Z）`)
  if (compare(next, current) <= 0) die(`新版本 ${mode} 必须大于当前版本 ${pkg.version}`)
}

const nextText = `${next.major}.${next.minor}.${next.patch}${next.pre === undefined ? '' : `-${next.pre}`}`
console.log(`[release] ${pkg.version} -> ${nextText}${dryRun ? '（--dry-run，不写文件）' : ''}`)

if (!dryRun) {
  // 1. package.json
  pkg.version = nextText
  writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`)

  // 2. package-lock.json 里的两处版本号：顶层 version 与 packages[""].version。
  //    少改一处，`npm ci` 就会因为锁文件与 package.json 不同步而失败。
  const lock = JSON.parse(readFileSync(lockPath, 'utf8'))
  lock.version = nextText
  if (lock.packages?.[''] !== undefined) lock.packages[''].version = nextText
  writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`)
}

if (!noCommit) {
  const message = `chore: release v${nextText}`
  // 只提交这两个文件：工作区里别的已暂存改动不会被卷进这次发布提交。
  const add = spawnSync('git', ['add', '--', 'package.json', 'package-lock.json'], { cwd: repoRoot, stdio: 'inherit' })
  if (add.status !== 0) die('git add 失败')
  const commit = spawnSync('git', ['commit', '-m', message, '--', 'package.json', 'package-lock.json'], {
    cwd: repoRoot,
    stdio: 'inherit',
  })
  if (commit.status !== 0) die('git commit 失败（没有改动可提交？）')
  console.log(`[release] 已提交：${message}`)
} else {
  console.log('[release] 已跳过提交（--no-commit / --dry-run）')
}

const branch = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' })
const name = branch.stdout?.trim()
if (name !== undefined && name !== 'main') {
  console.log(`[release] 注意：当前分支是 ${name}，publish.yml 只在推 main 或推 v* tag 时发布`)
}
console.log(`[release] 下一步：git push origin ${name ?? 'main'}`)
console.log('[release] 推上去后 publish.yml 会自动发布（npm 上已有该版本就只跑检查），并自动补 tag 与 Release')
