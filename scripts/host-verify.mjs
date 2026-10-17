/**
 * 真实宿主**装载**验证（docs/design.md §6.2）。
 *
 * 与 `scripts/host-smoke.mjs` 的分工：
 * - `host-smoke` 用真实 cordis 直接 `ctx.plugin()`，验证工具 schema / 服务 / 卸载；
 * - 本脚本走**真实 dsh 引擎的装载路径**，验证两件只有引擎才能回答的事：
 *
 * ① **兼容性预检**：DSH 在装载前对每个插件行跑 `dsh-app-boot` 的
 *    `evaluatePluginCompatibility`，遍历 manifest 里 `@deepseek-ai/dsh*` 的
 *    `peerDependencies`，不满足就把行标成 `disabled` 并打印
 *    `dsh: disabling profile plugin row "paper": … is incompatible with dsh …`。
 *    命中这条规则的表现是「装了但没反应」。检查分两处：本仓库的 manifest，
 *    以及**宿主要读的那一份已安装 manifest**（按 Node 解析路径找，与引擎的
 *    `manifestOf()` 同一套做法）——两者都过才算真的能装。
 * ② **引擎组合**：用 `--dump-config` 让引擎真正解析补丁层、校验 `Config` schema
 *    （schemastery 的 Standard Schema 校验由引擎执行），并打印合成后的插件树。
 *
 * **为什么 DSH_HOME 指向工作区内**：新版引擎的启动路径会先 `prepareProfile()`
 * 写一次 `$DSH_HOME/profiles/<name>/cordis.yml`（内容恒为空根配置 `[]`，每次启动
 * 都重写）。指向真实 `~/.dsh` 会在受限沙箱下被拒（EPERM），也会让「只读验证」
 * 变成写用户目录。改成工作区内的临时 home 后，本脚本既不需要任何额外权限，
 * 又仍然跑的是**同一个引擎、同一套默认 bundle**，只是不与用户的 profile 状态耦合。
 *
 * 用法：node scripts/host-verify.mjs
 * 退出码非 0 即失败。
 *
 * @module dsh-thesis/scripts/host-verify
 */

import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, openSync, closeSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { findDshInstall, loadHostCompatibility } from './lib/host-compat.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const tmpRoot = join(repoRoot, '.host-verify')
const patchPath = join(tmpRoot, 'paper.patch.yml')
/** 本次验证专用的 DSH_HOME（工作区内，用完即删）。 */
const sandboxHome = join(tmpRoot, 'dsh-home')

const checks = []
function check(label, ok, detail = '') {
  checks.push({ label, ok: Boolean(ok), skipped: false, detail })
  console.log(`${ok ? '  ok  ' : ' FAIL '}${label}${detail ? `  [${detail}]` : ''}`)
}
/** 环境不允许（而不是本插件有问题）时记跳过：跳过不进失败计数，但必须在报告里可见。 */
function skip(label, detail = '') {
  checks.push({ label, ok: true, skipped: true, detail })
  console.log(` skip ${label}${detail ? `  [${detail}]` : ''}`)
}

const install = findDshInstall()
if (install === undefined) {
  console.log('[host-verify] 未找到 DSH 安装（可用 DSH_BIN / DSH_NODE_MODULES / DSH_HOME 指定）')
} else {
  console.log(`[host-verify] dsh 入口：${install.dshBin}`)
}

const manifest = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'))
/** 本插件声明的、会被宿主预检的 peer（`@deepseek-ai/dsh` 或 `@deepseek-ai/dsh-*`）。 */
function dshPeers(of) {
  return Object.entries(of.peerDependencies ?? {})
    .filter(([name]) => name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-'))
}
const peerSummary = () => dshPeers(manifest).map(([name, range]) => `${name}@${range}`).join(' ') || '（无）'

/**
 * 找宿主会读的那份 manifest：按 Node 的解析路径逐级找 `<dir>/<name>/package.json`。
 *
 * 与 `dsh-app-boot` 的 `manifestOf()` 对裸包名的做法一致（它也用
 * `createRequire(parentURL).resolve.paths()` 再直接拼 package.json，
 * 因此不受本包 `exports` 只有 `"."` 的限制）。
 */
function resolveInstalledManifest(name, profileDir) {
  const require = createRequire(pathToFileURL(join(profileDir, 'noop.js')).href)
  for (const dir of require.resolve.paths(name) ?? []) {
    const file = join(dir, name, 'package.json')
    if (existsSync(file)) return file
  }
  return undefined
}

// ---------------------------------------------------------------------------
// 1. 兼容性预检：这一项决定插件会不会被引擎停用
// ---------------------------------------------------------------------------
if (install === undefined) {
  skip('宿主兼容性预检', '本机没有 DSH 安装')
} else {
  const host = await loadHostCompatibility(install)
  const issue = host.evaluate(manifest, {})
  const compatible = issue === undefined || issue.exempted === true
  check(`本仓库 manifest 通过预检（dsh ${host.runtimeVersion} × ${manifest.name}@${manifest.version}）`, compatible,
    compatible
      ? peerSummary()
      : `${JSON.stringify(issue.peers)} —— 插件会被引擎 disabled；把 peerDependencies 改成能被 ${issue.runtimeVersion} 满足的 range`)

  // 已安装副本：宿主的 preflight 读的是它，而不是本仓库。
  const userHome = process.env.DSH_HOME?.trim() || join(process.env.USERPROFILE ?? '', '.dsh')
  const profileDir = join(userHome, 'profiles', 'web')
  const installedManifestPath = resolveInstalledManifest(manifest.name, profileDir)
  if (installedManifestPath === undefined) {
    skip('已安装副本通过预检', `${profileDir} 下没有 ${manifest.name}（本仓库未装进该 profile）`)
  } else {
    const installed = JSON.parse(readFileSync(installedManifestPath, 'utf8'))
    const installedIssue = host.evaluate(installed, {})
    const installedOk = installedIssue === undefined || installedIssue.exempted === true
    check('已安装副本通过预检（宿主 preflight 读的就是这一份）', installedOk,
      installedOk
        ? `${installedManifestPath}（${installed.name}@${installed.version}，${dshPeers(installed).map(([n, r]) => `${n}@${r}`).join(' ')}）`
        : `${installedManifestPath} 仍是旧 range ${JSON.stringify(installedIssue.peers)} —— 重新安装或重新 link 后再启动 dsh`)
  }
}

if (!existsSync(join(repoRoot, 'lib', 'index.js'))) {
  throw new Error('缺少 lib/index.js —— 先运行 npm run build')
}

rmSync(tmpRoot, { recursive: true, force: true })
mkdirSync(tmpRoot, { recursive: true })

// 生成临时补丁层：把模板里的 REPO_PATH 换成本仓库绝对路径。
// 用 file:// URL 形态，保证引擎按"模块说明符"而不是"包名"解析。
const template = readFileSync(join(repoRoot, 'scripts', 'host-verify.patch.yml.tpl'), 'utf8')
const moduleSpecifier = new URL(`file://${repoRoot.replace(/\\/g, '/')}/lib/index.js`).href
writeFileSync(patchPath, template.replace('REPO_PATH', moduleSpecifier), 'utf8')
console.log(`[host-verify] 临时补丁层：${patchPath}`)
console.log(`[host-verify] 模块说明符：${moduleSpecifier}`)

/**
 * 跑一次 dsh 并把输出**重定向到文件**再读回。
 *
 * 不能简单地用 `stdio: 'pipe'`：受限环境下管道 stdio 会被拒（EPERM），
 * 这正是本仓库 `src/shared/spawn.ts` 记录的那条环境约束。这里用文件描述符
 * 重定向（既不需要管道，也拿得到完整输出）。
 */
function runDsh(args) {
  const outPath = join(tmpRoot, 'dsh-out.txt')
  const errPath = join(tmpRoot, 'dsh-err.txt')
  const outFd = openSync(outPath, 'w')
  const errFd = openSync(errPath, 'w')
  let result
  try {
    result = spawnSync(process.execPath, [install.dshBin, ...args], {
      stdio: ['ignore', outFd, errFd],
      env: { ...process.env, DSH_HOME: sandboxHome },
    })
  } finally {
    closeSync(outFd)
    closeSync(errFd)
  }
  const read = (path) => {
    try {
      return readFileSync(path, 'utf8')
    } catch {
      return ''
    }
  }
  return {
    ok: result.status === 0,
    status: result.status,
    error: result.error === undefined ? undefined : String(result.error),
    stdout: read(outPath),
    stderr: read(errPath),
  }
}

try {
  // ---- 2. 合成后的配置树里出现本插件行 ----
  const dump = install === undefined
    ? { ok: false, status: null, stdout: '', stderr: '', error: 'no dsh' }
    : runDsh(['--profile', 'web', '--patch', patchPath, '--dump-config'])
  check('dsh --dump-config 成功（引擎接受我们的补丁层）', dump.ok,
    `${dump.stderr.split('\n')[0] ?? ''} ${dump.error ?? ''}`.trim())
  const tree = `${dump.stdout}\n${dump.stderr}`
  check('合成树包含真实的 paper 插件行（id + name 两行）',
    /^-\s*id:\s*paper\s*$/m.test(tree) && new RegExp(`^\\s*name:\\s*${moduleSpecifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'm').test(tree),
    (tree.match(/^-\s*id:\s*paper\s*$/m) ?? ['(无 id: paper 行)'])[0])
  check('插件未被引擎标记为加载失败', !/failed|invalid/i.test(tree),
    tree.split('\n').filter(l => /failed|invalid/i.test(l))[0] ?? '')
  check('未写用户 profile（DSH_HOME 指向工作区内临时目录）',
    !dump.ok || sandboxHome.includes('.host-verify'),
    `DSH_HOME=${sandboxHome}`)

  // ---- 3. 引擎真的解析到了我们的入口文件（而不是静默跳过） ----
  const indexJs = readFileSync(join(repoRoot, 'lib', 'index.js'), 'utf8')
  check('lib/index.js 是 ESM 且导出 apply/name', /export\s+function\s+apply/.test(indexJs) && /export\s+const\s+name/.test(indexJs))
  check('lib/index.js 不含未编译的 .ts 导入（宿主无 TS 加载器）', !/from\s+['"][^'"]+\.ts['"]/.test(indexJs),
    (indexJs.match(/from\s+['"][^'"]+\.ts['"]/) ?? [])[0] ?? '')

  // ---- 4. Config schema 能被 schemastery 真实校验（引擎装载时执行的同一件事） ----
  const paper = await import(pathToFileURL(join(repoRoot, 'lib', 'index.js')).href)
  const validated = paper.Config({ similarity: { shingle: 6 } })
  check('Config 校验通过并补默认值', validated.similarity.shingle === 6 && validated.similarity.threshold === 0.3,
    `shingle=${validated.similarity.shingle} threshold=${validated.similarity.threshold}`)
  check('Config 含闸门字段（writingGate）', validated.writingGate === true)
  check('Config 不含被取代的旧字段（promptGate / learn）',
    validated.promptGate === undefined && validated.learn === undefined)
  check('默认值来源一致（PAPER_DEFAULTS）',
    paper.PAPER_DEFAULTS.stylecheck.reportRel === validated.stylecheck.reportRel)

  // ---- 5. 插件行声明的 patch 文件本身合法（真实安装路径会用到它） ----
  const ownPatch = readFileSync(join(repoRoot, 'cordis.patch.yml'), 'utf8')
  check('仓库 cordis.patch.yml 是顶层数组且插入 paper 行',
    /^-\s*insert:/m.test(ownPatch) && /name:\s*dsh-thesis/.test(ownPatch))
} finally {
  rmSync(tmpRoot, { recursive: true, force: true })
}

const failed = checks.filter(item => !item.ok)
const skipped = checks.filter(item => item.skipped)
const scored = checks.length - skipped.length
console.log(`\n[host-verify] ${scored - failed.length}/${scored} 通过${skipped.length > 0 ? `（${skipped.length} 项跳过）` : ''}`)
if (failed.length > 0) {
  console.log('\n未通过项：')
  for (const item of failed) console.log(`- ${item.label}${item.detail ? `（${item.detail}）` : ''}`)
}
if (skipped.length > 0) {
  console.log('\n跳过项（环境限制，不是插件问题）：')
  for (const item of skipped) console.log(`- ${item.label}${item.detail ? `（${item.detail}）` : ''}`)
}
process.exitCode = failed.length === 0 ? 0 : 1
