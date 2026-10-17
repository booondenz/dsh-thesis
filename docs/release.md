# 发布

发版由 GitHub Actions 完成（[`.github/workflows/publish.yml`](../.github/workflows/publish.yml)）。
**打 tag 即发布**，本地不需要 `npm login`，也不需要任何 npm token。

认证走 **Trusted Publishing（OIDC 可信发布）**：npm 只接受「这个仓库的这个 workflow」发来的包，
凭据是每次运行临时签发的，不落盘、不过期、也没有 2FA 输 OTP 的问题；provenance 由 npm 自动附上。

## 一次性设置（只做一次）

1. 打开 <https://www.npmjs.com/package/dsh-thesis/access> → **Trusted Publishers** →
   **Select publisher: GitHub Actions**，填四个字段：

   | 字段 | 填什么 |
   |---|---|
   | Organization or user | `booondenz` |
   | Repository | `dsh-thesis` |
   | Workflow filename | `publish.yml`（只写文件名，不带路径）|
   | Environment name | **留空**（除非 workflow 里写了 `environment:`）|

2. 确认仓库是 **public**：私有仓库发不出 provenance。
3. 不需要 `NPM_TOKEN`，**之前建过的话建议在 Settings → Secrets 里删掉**，免得以后误用。

> 配置要先「验证」过一次才算生效：2026-10 起，长期没成功发布过的可信发布配置会自动过期。
> 所以配完就立刻发一次版。

## 备选：用 token（不推荐）

如果哪天可信发布不可用，也可以在 npm 建 **Classic → Automation** 类型的 token
（Granular token 在开了 2FA 的账号上会报 `EOTP`，除非它明确允许绕过 2FA），
存成仓库 secret `NPM_TOKEN`，然后在 workflow 的 publish 步骤加回：

```yaml
        env:
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
```

并把 `setup-node` 的 `with:` 里加回 `registry-url: https://registry.npmjs.org`。
Automation token 专为 CI 设计，不受 2FA 影响。

## 发一次版

```bash
npm version patch --no-git-tag-version   # 或 minor / major，或手动改 package.json
git add package.json package-lock.json
git commit -m "chore: release v2.0.1"
git tag v2.0.1
git push origin main --tags
```

Action 会依次做：

| 步骤 | 失败就停 |
|---|---|
| `npm ci` | 锁文件与 package.json 不同步会在这里红 |
| tag 与 `package.json` 版本一致 | 防止「tag 写 v2.0.1、包里是 2.0.0」|
| 该版本是否已存在于 npm | 已存在则**跳过发布**（不会红，也不会覆盖）|
| `npm pack --dry-run` | 发布内容一目了然（日志里能看到文件清单）|
| `npm publish` | 内部触发 `prepublishOnly` 守卫：构建 + 类型 + 单测 + 审计 + 端到端；provenance 由可信发布自动附带 |
| 建 GitHub Release | 标题用 tag，正文自动生成 |

发布成功后 npm 页面会带一个 **Provenance** 徽章，点进去能看到是哪次 commit、哪次 workflow 构建的。

## 在网页上发版（完全不碰命令行）

1. 打开 <https://github.com/booondenz/dsh-thesis/releases/new>；
2. **Choose a tag** 里输入 `v2.0.1`，点下拉第一条 **Create new tag: v2.0.1 on publish**；
3. **Target** 选 `main`，并确认它指向 bump 版本的那个 commit（否则 tag 会打在别的提交上，
   workflow 第一步的版本比对就会红）；
4. 标题写 `v2.0.1`，正文可以留空——workflow 里是 `gh release view || gh release create`，
   发现 Release 已存在会跳过；
5. **Publish release**。

创建 tag 本身就是一次 `push`，所以 `publish.yml` 会被触发。两条路等价：也可以先
`git push origin v2.0.1` 再建 Release，或者只推 tag 不建 Release（workflow 会替你建）。

## 确认发成功了

| 看哪 | 期望 |
|---|---|
| Actions → **publish** | 这次 run 是绿的；Summary 里有一行 `https://www.npmjs.com/package/dsh-thesis/v/2.0.1` |
| `npm view dsh-thesis version` | `2.0.1`（registry 立刻生效，网页可能还要一分钟）|
| `npm view dsh-thesis dist-tags` | `{ latest: '2.0.1' }` |
| <https://www.npmjs.com/package/dsh-thesis> | 版本号旁出现 **Provenance** 徽章 |
| 仓库 **Releases** | 多了一条 `v2.0.1` |

Actions 里**根本没出现 publish 这个 run**，说明 tag 没推上去（或名字不是 `v` 开头）；
出现 run 但红在第一步，通常是 tag 与 `package.json` 版本对不上。

## 发完之后：让 DSH 用上新版

profile 把版本钉在 `~/.dsh/profiles/<profile>/package.json` 里（例如 `"dsh-thesis": "1.0.1"`），
所以 npm 上发了新版**不会自动生效**。到插件管理器里移除再装一次（会取 `latest`），或者把那条依赖
改成 `"^2.0.1"` 后重装，然后**重启 DSH**——2.0 删掉了全部斜杠命令，不是热更新能覆盖的。

## 手动触发

Actions → publish → Run workflow：只做打包预览，**不会发布**。用来确认「这次发出去的包里到底有什么」。
想真发版，还是打 tag。

## 失败排查

| 现象 | 原因 |
|---|---|
| `EOTP` / `This operation requires a one-time password` | 用的是需要 OTP 的 token（2FA 账号的 Granular / Publish token）。CI 里没人能输 OTP：改用可信发布，或换 Classic → Automation token |
| `401 Unauthorized` | token 过期（Automation token 有 90/180 天寿命），或可信发布配置里 workflow 文件名写错 |
| `npm ci … not in sync` | 改了 `package.json` 的依赖/peer 却没跑 `npm install --package-lock-only` |
| `403 … cannot publish over previously published version` | 版本号没升；这条在 workflow 里已被「已存在则跳过」挡住，手动发版时要注意 |
| 守卫里 `单元/契约测试` 红 | 本地 `npm test` 先复现；守卫跑的就是它 |
| 守卫警告「未找到 DSH 安装」 | CI 里正常（没有宿主）；**发版前请在本地跑一次 `npm run test:host-load` 与 `npm run test:host`** |

## 撤回与补救

- **已发布的版本不能改**，只能 `npm deprecate dsh-thesis@2.0.1 "原因与替代版本"`。
- 72 小时内理论上可以 `npm unpublish`，但那会让依赖它的人突然装不上，**不要用**。
- 发错了就立刻发一个 patch：`2.0.2`。

## 仍然可以本地发布

```bash
npm login
npm publish --access public          # 会跑同一个 prepublishOnly 守卫，会交互式要 OTP
```

本地发布用的是你登录后的凭据（可以输 OTP），不需要 token，也不需要可信发布配置。
CI 只是把「构建 → 校验 → 发布」串起来，判据完全一样。
