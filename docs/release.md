# 发版与测试流程

一个版本 = 一个 tag = 测试拿到的东西。开发机跟工作区走，测试机只装 tag。

## 版本号怎么走

沿用 [README](../README.md#版本) 的规则：

| 变更 | 版本 |
|---|---|
| 修复，不动 CLI 参数与数据契约 | patch（`0.7.1`） |
| 新增能力 / 新命令 / 兼容新增字段 | minor（`0.8.0`） |
| 改字段语义、改 CLI 参数、删能力 | major 或提供迁移 |
| 契约或数据 schema 不兼容 | 大版本，附 `space lock` 迁移说明 |

契约不兼容时同步更新 `space.lock.json` 的兼容窗口，并在 CHANGELOG 写清迁移步骤。

## 发版前必须全绿

```sh
npm run verify          # 232 项测试 + 契约 + 目录 + 技能包 + 发布边界
npm run verify:browser  # 白模 + 工作台冒烟（需要 Chrome）
npm run bench:index     # 索引验收数字，未达标退出码 1
git status              # 工作区必须干净
```

任何一项红都不打 tag。CI（`.github/workflows/verify.yml`）会在 macOS 与 Windows 上跑同一个 `npm run verify`。

## 发版步骤

1. **改版本号**：`package.json` 的 `version`。
2. **重建技能包**：`npm run skills:build`。`.bundle.json` 记录版本与文档哈希，`skills:check` 会比对；版本号不同步会直接失败。
3. **刷新示例锁**：`space lock --project examples/two-level/project.json`。
4. **写 CHANGELOG**：把「未发布」改成 `## x.y.z — YYYY-MM-DD`，逐条写清新增 / 变更 / 修复 / 验收，未完成的项留在「未完成清单」。
5. **提交**：`git commit -m "x.y.z：<一句话主题>"`。
6. **打 tag 并推送**：

   ```sh
   git tag -a v0.7.1 -m "0.7.1"
   git push origin main --follow-tags
   ```

7. **推送 tag**：CI 会自动完成发版（`.github/workflows/release.yml`）：

   - 校验 tag 与 `package.json` 版本一致（`v0.7.1` ↔ `0.7.1`）；
   - 跑 `npm run verify`；
   - `npm pack` 并用干净前缀试装，跑 `space version` / `capabilities --check` / `skills check`；
   - 建 Release，附 `house-plan-toolkit-x.y.z.tgz`；带 `-` 的 tag 自动标为 prerelease。

   任一步失败就停在 Release 之前，不会留下半成品。

8. **确认 Release 产物**：打开 Release 页，确认 tarball 在，然后按下面的方式装。

## 预发布（给测试快速验一个修复）

```sh
# package.json 改成 0.7.1-rc.1
npm run skills:build
git commit -am "0.7.1-rc.1：<修了什么>"
git tag -a v0.7.1-rc.1 -m "0.7.1-rc.1"
git push origin main --follow-tags
```

rc 也要改 `package.json` 版本并重建技能包：发版 workflow 会校验 tag 与 `package.json` 一致，`skills:check` 也会比对 `.bundle.json` 的版本。

规则：

- `-rc.N` 只用来验证，不进 CHANGELOG 的正式条目；正式发版时把验证过的修复合并进 `x.y.z`（版本改回 `0.7.1`，tag `v0.7.1`）。
- 同一个 bug 连续修两次就用 `-rc.2`，不要移动已推送的 tag。
- 测试反馈请用「测试反馈」issue 模板，必须填 tag 与 `.agents/skills/.skills-version`。

## 测试机安装

每个 tag 装到独立前缀，可以和旧版本并存。**优先用 Release 附件**（不 clone 仓库、不走 npm registry）：

```sh
npm install -g --prefix ~/hp/v0.7.1 \
  https://github.com/AaronChen314/house-plan-toolkit/releases/download/v0.7.1/house-plan-toolkit-0.7.1.tgz
```

没有 Release 附件时（例如还没跑 CI）才退回从仓库装：

```sh
npm install -g --prefix ~/hp/v0.7.1 github:AaronChen314/house-plan-toolkit#v0.7.1
~/hp/v0.7.1/bin/space version
~/hp/v0.7.1/bin/space setup --project ~/test-house   # Python 依赖装进项目，不污染工具包
~/hp/v0.7.1/bin/space skills check
~/hp/v0.7.1/bin/space skills sync --project ~/test-house
cat ~/test-house/.agents/skills/.skills-version       # 报 bug 时附上这一行
```

Windows 用 `~/hp/v0.7.1/Scripts/space`（前缀下是 `Scripts/` 而非 `bin/`）。

## 分支与 PR

- trunk-based：`main` 永远可发布；改动走 `feat/<简述>`、`fix/<简述>` 分支，PR + 1 人 review。
- 契约改动（`src/contracts/`、`schemas/`）必须由契约负责人 review，并在 issue 里写明契约影响。
- PR 必须过 CI；不合入未过 CI 的分支。
- 一个 PR 一个关注点；顺手重构请另开 PR。

## 回滚

- 已推送的 tag 不移动、不删除：打新的 patch 版本修。
- 数据不兼容时不要回退 CLI，改用 `space store rebuild` / `space index rebuild` 重建派生物，权威文件保持不变。
