/**
 * 宿主（DSH）安装探测 + **真实**插件兼容性预检。
 *
 * 为什么需要这个模块：DSH 在装载 profile 前会跑一次「兼容性预检」
 * （`dsh-app-boot` 的 `evaluatePluginCompatibility`）：遍历插件 manifest 里形如
 * `@deepseek-ai/dsh*` 的 `peerDependencies`，要求运行期版本满足该 range，否则
 * 把插件行标成 `disabled` 并打印
 * `dsh: disabling profile plugin row "paper": Plugin dsh-thesis@1.0.0 is incompatible with dsh <版本>`。
 * 本仓库曾声明 `@deepseek-ai/dsh-tools: ^0.1.0`，在 dsh 0.2.0-rc.2 上正好命中这条规则，
 * 表现是「装了但没反应」——插件被静默停用。
 *
 * 因此这里**不自己实现 semver 规则**，而是直接 import 已安装的 `dsh-app-boot`，
 * 用宿主自己的函数判断宿主自己的规则：判据与 DSH 启动时的判据逐字同源，不会漂移。
 * 找不到 DSH 安装时返回 `undefined`，调用方降级为「跳过」而不是误报失败。
 *
 * @module dsh-thesis/scripts/host-compat
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * 在候选位置里找一份 DSH 安装（其下应有 `@deepseek-ai/dsh` 与 `@deepseek-ai/dsh-app-boot`）。
 *
 * 候选顺序与 `scripts/host-smoke.mjs` 的农场探测一致：显式环境变量 → `$DSH_HOME`
 * 的 profile 兜底目录 → npx 缓存。返回 `undefined` 表示这台机器上没有可用的 DSH。
 *
 * @returns `{ nodeModulesRoot, dshBin, appBootDir }` 或 `undefined`
 */
export function findDshInstall() {
  const candidates = []
  const explicitModules = process.env.DSH_NODE_MODULES?.trim()
  if (explicitModules !== undefined && explicitModules !== '') candidates.push(explicitModules)

  const explicitBin = process.env.DSH_BIN?.trim()
  if (explicitBin !== undefined && explicitBin !== '') {
    // <root>/@deepseek-ai/dsh/lib/bin.js → <root>
    candidates.push(join(explicitBin, '..', '..', '..', '..'))
  }

  const home = process.env.DSH_HOME?.trim()
  if (home !== undefined && home !== '') candidates.push(join(home, 'profiles', 'node_modules'))

  const localAppData = process.env.LOCALAPPDATA?.trim()
  if (localAppData !== undefined && localAppData !== '') {
    const npxRoot = join(localAppData, 'npm-cache', '_npx')
    if (existsSync(npxRoot)) {
      for (const entry of readdirSync(npxRoot)) candidates.push(join(npxRoot, entry, 'node_modules'))
    }
  }

  for (const root of candidates) {
    const appBootDir = join(root, '@deepseek-ai', 'dsh-app-boot')
    const dshBin = join(root, '@deepseek-ai', 'dsh', 'lib', 'bin.js')
    if (existsSync(join(appBootDir, 'lib', 'index.js')) && existsSync(dshBin)) {
      return { nodeModulesRoot: root, dshBin, appBootDir }
    }
  }
  return undefined
}

/**
 * 读出某份 DSH 安装的运行期版本号。
 *
 * 与宿主的 `getDshRuntimeVersion()` 同源：读的是 **`dsh-app-boot` 自己的
 * `package.json`**（不是 `dsh` 的）——预检拿它当「当前运行期版本」。
 *
 * @param appBootDir `@deepseek-ai/dsh-app-boot` 目录
 * @returns 版本字符串
 */
export function readRuntimeVersion(appBootDir) {
  const manifest = JSON.parse(readFileSync(join(appBootDir, 'package.json'), 'utf8'))
  if (typeof manifest.version !== 'string' || manifest.version === '') {
    throw new Error(`${join(appBootDir, 'package.json')} 缺少 version`)
  }
  return manifest.version
}

/**
 * 装载宿主的兼容性预检函数（真实实现，不是复刻）。
 *
 * @param install `findDshInstall()` 的结果
 * @returns `{ runtimeVersion, evaluate }`；`evaluate(manifest, exemptions)` 返回
 *          `undefined` 表示兼容，否则返回宿主自己的冲突描述对象
 */
export async function loadHostCompatibility(install) {
  const module = await import(pathToFileURL(join(install.appBootDir, 'lib', 'index.js')).href)
  if (typeof module.evaluatePluginCompatibility !== 'function') {
    throw new Error('已安装的 dsh-app-boot 没有导出 evaluatePluginCompatibility —— 宿主 API 变了')
  }
  return {
    runtimeVersion: typeof module.getDshRuntimeVersion === 'function'
      ? module.getDshRuntimeVersion()
      : readRuntimeVersion(install.appBootDir),
    evaluate: module.evaluatePluginCompatibility,
    describe: typeof module.pluginCompatibilityWarning === 'function'
      ? module.pluginCompatibilityWarning
      : issue => `Plugin ${issue.name}@${issue.version} is incompatible with dsh ${issue.runtimeVersion}: peerDependencies ${JSON.stringify(issue.peers)}`,
  }
}

/**
 * 用宿主的规则检查一份插件 manifest 是否与当前运行期兼容。
 *
 * @param manifest 已解析的插件 `package.json`
 * @returns `{ compatible, runtimeVersion, issue, message }`；找不到 DSH 时返回 `undefined`
 */
export async function checkManifestCompatibility(manifest) {
  const install = findDshInstall()
  if (install === undefined) return undefined
  const host = await loadHostCompatibility(install)
  const issue = host.evaluate(manifest, {})
  const compatible = issue === undefined || issue.exempted === true
  return {
    compatible,
    runtimeVersion: host.runtimeVersion,
    install,
    issue,
    message: compatible ? '' : host.describe(issue),
  }
}
