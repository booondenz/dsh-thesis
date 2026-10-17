# 发布

发版由 GitHub Actions 完成（[`.github/workflows/publish.yml`](../.github/workflows/publish.yml)）。
**打 tag 即发布**，本地不需要 `npm login`，也不需要记住那串手动步骤。

## 一次性设置

1. 在 npm 上建 token：Account → Access Tokens → **Generate New Token → Granular Access Token**
   （经典页面的 Automation token 也能用，但 Granular 权限更细）。填法：

   | 字段 | 选什么 |
   |---|---|
   | Token name | `dsh-thesis-ci`（认得出是 CI 用的即可）|
   | Allowed IP ranges | **留空**（GitHub Actions 的 IP 每次都变，填了就自己把自己拦住）|
   | Packages and scopes → Permissions | **Read and write (publish and stage)**——`stage only` 发不出去 |
   | 选完权限后的范围 | **Select packages → `dsh-thesis`**（只给它；要发全新包名时才临时用 All packages）|
   | Organizations | **No access**（包名不带 scope）|
   | Expiration | 90 或 180 天；token 过期后 CI 会 `401`，到期前重建 |

   底部 Summary 应该显示 **Read and write access to dsh-thesis**；如果还写着 "no access"，
   说明 Permissions 没点选，回去重选。2FA 账号若仍报 `EOTP`，退回 Classic → Automation token。

2. GitHub 仓库 → Settings → Secrets and variables → Actions → New repository secret：
   名字 `NPM_TOKEN`，值就是那个 token（**它只显示一次**；别贴进仓库、issue 或任何聊天记录）。
3. 确认仓库是 **public**：`npm publish --provenance` 需要 OIDC，私有仓库用不了。

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
| `npm publish --provenance` | 内部触发 `prepublishOnly` 守卫：构建 + 类型 + 单测 + 审计 + 端到端 |
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
| `EOTP` / `401 Unauthorized` | `NPM_TOKEN` 不是 Automation token，或已过期 |
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
npm publish --access public          # 会跑同一个 prepublishOnly 守卫
```

CI 只是把「构建 → 校验 → 发布」串起来，判据完全一样。
