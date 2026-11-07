# 发布

发版由 GitHub Actions 完成（[`.github/workflows/publish.yml`](../.github/workflows/publish.yml)）。

**升版本号 + push 就发版，不用打 tag。** 推上去以后 workflow 会自己看 npm 上有没有这个版本，
没有就发布，发完**自动补 tag 与 GitHub Release**——tag 是发布的产物，不再是发布的前提。

```bash
npm run release:minor      # 2.1.0 -> 2.2.0（改 package.json 与 package-lock.json 并提交）
git push origin main       # 推完就自动发布
```

就这两条。`npm run release:patch` / `release:major` 同理。

本地不需要 `npm login`，也不需要任何 npm token。

## 它怎么判断该不该发

| 检查 | 结果 |
|---|---|
| push 到 `main` | 进入发布流程 |
| push 的 tag（`v*`） | 同样进入（兼容手动打 tag 的老做法） |
| `package.json` 的版本 npm 上**没有** | `npm pack --dry-run` → 守卫 → `npm publish` → 自动打 tag → 建 Release |
| `package.json` 的版本 npm 上**已有** | 只跑检查，跳过发布（不会红，也不会覆盖）|
| 手动触发（`workflow_dispatch`） | 只做打包预览，不发布、不打 tag |

所以：**版本号没变 = 这次 push 不发版**。日常提交随便推，只有 `release:*` 那次会发。

## 为什么版本号只认 `package.json`，不从 commit message 解析

发布包里真正写进去的是 `package.json` 的 `version`。如果让提交信息里的 `v2.2.0` 决定发什么版本，
只有三条路，都不好：

1. **照抄提交信息 → 包里版本不对**：提交写 `v2.2.0`、`package.json` 还是 `2.1.0`，
   npm 上会出现两个"2.1.0"（第二次直接被拒），或者发出去的包版本与 tag 不一致；
2. **CI 里临时改 `package.json` 再发**：npm 上是 2.2.0，仓库里还是 2.1.0，
   下次谁从仓库装就是旧版本，provenance 里的 commit 也对不上；
3. **CI 里改完再提交回 main**：机器人提交 + 可能撞保护分支 + 每次发版两个 commit。

现在的做法是：**版本号只有一处真相（`package.json`），`npm run release:*` 负责同时改两处并提交**，
提交信息与 tag 名都从它派生（`chore: release v2.2.0` → tag `v2.2.0`），三者不可能不一致。

## 一次性设置（只做一次，已完成）

npm 侧认证走 **Trusted Publishing（OIDC）**：npm 只接受「这个仓库的这个 workflow」发来的包，
凭据每次运行临时签发，不落盘、不过期、没有 2FA 输 OTP 的问题；provenance 自动附带。

<https://www.npmjs.com/package/dsh-thesis/access> → **Trusted Publishers**：

| 字段 | 值 |
|---|---|
| Organization or user | `booondenz` |
| Repository | `dsh-thesis` |
| **Workflow filename** | **`publish.yml`**（只写文件名，不带路径）|
| Environment name | 留空 |

**`publish.yml` 这个文件名不能改**（也不能把发布逻辑挪进 `ci.yml`）：npm 的配置绑的就是文件名，
改名后第一次发布会 403。改了触发条件是安全的，改文件名不是。

同一页 **Allowed actions** 里要勾 **Allow npm publish**，只勾 stage 的话每次发版还得去网页做 2FA 批准。

## workflow 干了什么

| 步骤 | 失败就停 |
|---|---|
| `npm ci` | 锁文件与 `package.json` 不同步会红（所以别手改版本号，用 `npm run release:*`）|
| 读 `package.json` 版本 | — |
| 手动 tag 与版本一致（仅 tag 触发时）| 防止「tag 写 v2.2.0、包里是 2.1.0」|
| 该版本是否已发布 | 已存在则跳过发布 |
| `npm pack --dry-run` | 日志里能直接看到这次包里有什么 |
| `npm publish` | 内部跑 `prepublishOnly` 守卫：构建 + 类型 + 单测 + 审计 + 端到端；**main 红了在这里被拦下** |
| 自动打 tag | `git tag v<version>` + push；用 `GITHUB_TOKEN` 推的 tag 不会再触发 workflow，不会套娃 |
| 建 Release | 标题 `v<version>`，正文自动生成 |

## 手动打 tag（仍然可以，但不再是发版的必要条件）

```bash
git tag v2.2.0
git push origin v2.2.0
```

行为与以前完全一致：先校验 tag 与 `package.json` 一致，再发布。适合"版本号早就提交了、只是补发"的场景。

## 备选：用 token（不推荐）

可信发布不可用时，在 npm 建 **Classic → Automation** token（Granular token 在开了 2FA 的账号上会报 `EOTP`），
存成仓库 secret `NPM_TOKEN`，然后在 publish 步骤加回：

```yaml
        env:
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
```

并把 `setup-node` 的 `with:` 里加回 `registry-url: https://registry.npmjs.org`。
Automation token 专为 CI 设计，不受 2FA 影响。

## 确认发成功了

| 看哪 | 期望 |
|---|---|
| Actions → **publish** | 绿；Summary 里有 `https://www.npmjs.com/package/dsh-thesis/v/2.2.0` |
| `npm view dsh-thesis version` | `2.2.0`（registry 立刻生效，网页可能慢一分钟）|
| `npm view dsh-thesis dist-tags` | `{ latest: '2.2.0' }` |
| 仓库 **Tags / Releases** | 自动多了 `v2.2.0` |
| <https://www.npmjs.com/package/dsh-thesis> | 版本号旁有 **Provenance** 徽章 |

## 发完之后：让 DSH 用上新版

profile 把版本钉在 `~/.dsh/profiles/<profile>/package.json` 里，npm 发了新版**不会自动生效**：

```bash
dsh plugin --profile web add dsh-thesis@2.2.0
dsh plugin --profile desktop add dsh-thesis@2.2.0
```

然后**重启 DSH**（2.0 删掉了全部斜杠命令，不是热更新能覆盖的）。

## 失败排查

| 现象 | 原因 |
|---|---|
| Actions 里**根本没有** publish run | push 的不是 `main`，也不是 `v*` tag |
| publish 绿但 Summary 写"已存在，未发布" | 版本号没升（`npm run release:*` 没跑）|
| `EOTP` / 要求一次性密码 | 用的是需要 OTP 的 token → 改用可信发布或 Automation token |
| 被拒、提示只能 `npm stage publish` | 可信发布里没勾 **Allow npm publish** |
| `403 … OIDC permission denied for this action` | 同上：认证过了，但没给「直接发布」权限 |
| `401 Unauthorized` | token 过期，或可信发布配置里 workflow 文件名写错 |
| `npm ci … not in sync` | 手改了 `package.json` 版本没同步锁文件 → 改用 `npm run release:*` |
| `403 … cannot publish over previously published version` | 版本号没升；workflow 里"已存在则跳过"会挡住，手动发版时要注意 |
| 守卫里单测红 / 端到端红 | 与 `npm run verify` 同一套；本地先复现 |
| 守卫警告「未找到 DSH 安装」 | CI 里正常（没有宿主）；**发版前请在本地跑一次 `npm run test:host-load` 与 `npm run test:host`** |
| 自动打 tag 失败但 npm 已发布 | tag 只是标记，事后手动 `git tag v2.2.0 && git push origin v2.2.0` 补上即可 |

## 撤回与补救

- **已发布的版本不能改**，只能 `npm deprecate dsh-thesis@2.2.0 "原因与替代版本"`。
- 72 小时内理论上可以 `npm unpublish`，但那会让依赖它的人突然装不上，**不要用**。
- 发错了就立刻发一个 patch：`npm run release:patch` + `git push`。

## 本地发布（应急）

```bash
npm login
npm publish --access public          # 会跑同一个 prepublishOnly 守卫，会交互式要 OTP
```

本地发布用你登录后的凭据，不需要 token，也不需要可信发布配置。CI 只是把「构建 → 校验 → 发布」串起来，判据完全一样。
