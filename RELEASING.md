# 发布流程（维护者）

> 本文只对维护者。普通用户装机看 [README 的「安装」](README.md#安装)。

包通过 npm 分发，**首次发布和后续发布是两条不同路径**。

## 一次性：首次发布（必须手动）

npm 的 Trusted Publishing（OIDC）**不能用于首次发布**：包必须先存在于 registry，包设置页才会出现 Trusted Publisher 配置项。npm 官方文档至今没写这个场景（[npm/documentation#1926](https://github.com/npm/documentation/issues/1926) 仍未关闭，多位用户确认首次 OIDC 发布会失败、只能手动补第一次）。所以第一次老老实实手动发：

```bash
# 先看产物（应该只有 4 个文件、~40 kB）
npm publish --dry-run --registry=https://registry.npmjs.org

npm login --registry=https://registry.npmjs.org
npm publish --registry=https://registry.npmjs.org
```

- 本机默认 registry 是内网镜像，所以这几条命令都要显式带 `--registry`
- `npm login` 会把凭据写成 `~/.npmrc` 里的一条 `//registry.npmjs.org/:_authToken`（registry 维度，不影响默认源、也不影响内网包安装；本机当前只有 `//mirrors.tencent.com/npm/` 那条）
- ⚠️ **`npm login` 拿到的是 2 小时会话，不是长期 token**（2025-12-09 起经典 token 全部废弃，login 改为 2h 会话）。所以登录后尽快发；2FA 也是强制交互的，会提示输入 OTP。超时了重新 `npm login` 即可
- 新建的包会**默认开启 2FA**（npm 的 secure-by-default），这对后面的 Trusted Publishing 没影响
- 备选：用 `npm token create` 建一个带 Bypass 2FA 的 granular token（write 类有效期上限 90 天）拿去 CI 直发。但不推荐——带 token 直发的路径官方 2027 年 1 月就要移除

## 后续：配好 Trusted Publisher 后打 tag 自动发

npmjs.com → 你的包 → **Settings** → **Trusted publishing** → GitHub Actions：

| 字段 | 值 |
| --- | --- |
| Organization or user | `Lqg97` |
| Repository | `pi-statusbar` |
| Workflow filename | `publish.yml`（只填文件名、含 `.yml`） |
| Environment name | 留空 |

⚠️ **必须额外勾选允许 `npm publish`**。2026-09-03 之后新建的 trusted publisher **默认只允许 `npm stage publish`**（staged publishing：先上传、再由维护者 2FA 批准才真正上线）。不勾这个框，workflow 里的 `npm publish` 会失败或被要求改走 staging。

配好之后发布：

```bash
# 1. 改 package.json 的 version 并提交（必须是 semver，且不能重复）
# 2. 打同名 tag 推送
git tag v1.0.1
git push origin main --tags
```

workflow 会依次卡 5 道：ref 必须是 tag → tag 与 `version` 一致 → npm CLI 版本支持 OIDC → 扩展语法自检 → 产物白名单。全过之后用 OIDC 换短期凭据发布，provenance 自动生成，**仓库不需要配任何 secret**。

产物白名单在 workflow 里显式写着（`extensions/` + `README.md` + `LICENSE` + `package.json`），`package.json` 的 `files` 字段是它的第一道防线——两边改要同步。

## 可选加固

Trusted Publisher 跑通后，可以在包 **Settings → Publishing access** 选 **"Require two-factor authentication and disallow tokens"**，禁掉 token 直接发布（不影响 OIDC）。

## 已知约束

- OIDC 只支持 GitHub 托管 runner（workflow 用 `ubuntu-latest`），self-hosted 不支持
- 要求 npm CLI ≥ 11.5.1 且 Node ≥ 22.14.0；workflow 因此用 Node 24
- `package.json` 的 `repository.url` 必须与 GitHub 仓库一致，否则 OIDC 校验失败
- 带 token 的直发（Bypass 2FA + 允许 publish）官方计划 **2027 年 1 月**移除；本仓库不走这条路
- action 已固定到 commit SHA，升级由 Dependabot（`.github/dependabot.yml`）开 PR
