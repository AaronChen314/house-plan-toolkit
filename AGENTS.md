# 仓库内 AI 工作入口

本仓库只提供工具、技能与规范，不含任何真实项目内容。项目数据在使用者的项目目录里。

| 当前任务 | 读取 |
|---|---|
| 读图、核查、转成可维护空间数据 | [skills/cad-to-space-data/SKILL.md](skills/cad-to-space-data/SKILL.md) |
| 户型布局、拆改、管路与动线设计 | [skills/floor-plan-design/SKILL.md](skills/floor-plan-design/SKILL.md) |
| 平面转三维白模、家具与定制柜、室内体验 | [skills/plan-to-3d/SKILL.md](skills/plan-to-3d/SKILL.md) |
| 已确认设计同步三维、固定机位出图与复核 | [skills/design-to-3d-sync/SKILL.md](skills/design-to-3d-sync/SKILL.md) |
| 彩平图与室内效果图 | [skills/design-image-render/SKILL.md](skills/design-image-render/SKILL.md) |

五个技能共用 [空间工作流约定](docs/space-workflow-contract.md)。项目目录与文件格式见 [项目目录规范](docs/project-layout.md)，公开发布边界见 [发布边界](docs/public-surface.md)。

## 代码边界

- CLI 入口 `bin/space.mjs`；实现按域放在 `src/`（`cli`、`space`、`cad`、`checks`、`viewers`、`furniture`、`legacy`）。
- 数据约定在 `schemas/`；项目骨架在 `templates/project/`；合成示例在 `examples/two-level/`。
- 技能正文在 `skills/`，其中的 `references/` 由 `npm run skills:build` 从 `docs/` 同步，不要手改。
- 早期脚本在 `src/legacy/`，通过 `space run` 调用。

## 验证

```sh
npm test
space lint --project examples/two-level/project.json
space build --project examples/two-level/project.json
node src/checks/white-model.mjs examples/two-level/output/白模.html
npm run skills:check
npm run verify:public
```

改动渲染或空间关系后跑合成示例；改动技能或文档后跑 `skills:check`；发布前跑 `verify:public`（词表通过 `SPACE_DENYLIST` 或 `~/.config/house-plan/denylist.txt` 提供）。
