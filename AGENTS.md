# 仓库内 AI 工作入口

本仓库只提供工具、技能与规范，不含任何真实项目内容。项目数据在使用者的项目目录里。

| 当前任务 | 读取 |
|---|---|
| 读图、核查、转成可维护空间数据 | [skills/cad-to-space-data/SKILL.md](skills/cad-to-space-data/SKILL.md) |
| 户型布局、拆改、管路与动线设计 | [skills/floor-plan-design/SKILL.md](skills/floor-plan-design/SKILL.md) |
| 平面转三维白模、家具与定制柜、室内体验 | [skills/plan-to-3d/SKILL.md](skills/plan-to-3d/SKILL.md) |
| 已确认设计同步三维、固定机位出图与复核 | [skills/design-to-3d-sync/SKILL.md](skills/design-to-3d-sync/SKILL.md) |
| 彩平图与室内效果图 | [skills/design-image-render/SKILL.md](skills/design-image-render/SKILL.md) |
| 改契约、存储或写入路径 | [docs/storage.md](docs/storage.md) |

五个技能共用 [空间工作流约定](docs/space-workflow-contract.md)。项目目录与文件格式见 [项目目录规范](docs/project-layout.md)，公开发布边界见 [发布边界](docs/public-surface.md)。

## 架构与计划

开工顺序：先读 [开发与调试](docs/contributing.md)（环境、分层落点、加能力/命令、验证循环、十条红线），发版与测试流程见 [发版](docs/release.md)；再按任务查：分层与数据关系见 [docs/architecture.md](docs/architecture.md)，接口与命令见 [docs/storage.md](docs/storage.md)，进度与未完成项见 [docs/roadmap.md](docs/roadmap.md)。改代码前先确认改动属于哪一层：契约、领域、存储、能力、运行时、视图还是宿主。

所有项目写入都经 `src/store/`（`writeArtifact` / `writeData` / `ingest`），能力不直接 `fs.writeFileSync`；`src/domain/` 只放纯函数。这两条由 `tests/store.test.mjs` 的静态扫描卡住。

## 代码边界

- CLI 入口 `bin/space.mjs`：只做分发；命令在 `src/cli/commands/`，注册表在 `src/cli/registry.mjs`。
- 分层目录：`src/contracts/`（L0）、`src/domain/`（L1，纯函数）、`src/store/` 与 `src/indexer/`（L2）、`src/capabilities/`（L3）、`src/cli/` `src/server/` `src/studio/`（L4 宿主）、`src/viewers/`（视图）。
- 能力按域分文件（`source` / `model` / `data` / `design` / `program` / `documents` / `render` / `bundle`），在 `src/capabilities/index.mjs` 加一行展开；只有契约的能力登记在 `PLANNED_CAPABILITIES`。
- 数据约定在 `schemas/` 与各契约模块；项目骨架在 `templates/project/`；合成示例在 `examples/two-level/`。
- 技能正文在 `skills/`，其中的 `references/` 由 `npm run skills:build` 从 `docs/` 同步，不要手改。
- 早期脚本在 `src/legacy/`，通过 `space run` 调用。

## 验证

```sh
npm run verify                      # 快速门禁：测试 + 契约 + 目录 + 技能 + 发布边界
npm run verify:browser              # 浏览器冒烟（需要 Chrome）
npm test
space lint --project examples/two-level/project.json
space build --project examples/two-level/project.json
node src/checks/white-model.mjs examples/two-level/output/白模.html
node src/checks/studio.mjs <project.json>   # 工作台视口取数冒烟（需已建索引）
space store verify --project examples/two-level/project.json
space capabilities --check
npm run bench:index                 # 索引验收数字（五万图元）
space graph sync --project <project.json>      # 从 data/ 刷新推导图投影
space program check --project <project.json>   # 拆改/净空/动线检查
space annotation list --project <project.json> --dataset <id>   # 确认清单与待确认项
space doc render --project <project.json> --scheme a --seq 1    # 出施工图（拆改图）
space doc check --project <project.json>                        # 交付清单复核，标待复核
space render colorplan --project <project.json> --scheme a --seq 1
space bundle export --project <project.json> --scheme a --seq 1 --name 交付
space deliver snapshot --project <project.json> --scheme a --seq 1 --name 交付
space cap list                     # 能力清单：已实现 + 计划中
space cap show <id>                # 契约与参数；计划项显示阻塞原因
space plugin list                  # 能力插件（默认关闭，SPACE_PLUGINS=1 开启）
space index global sync --project <project.json>   # 同步到跨项目只读摘要
space index global list            # 检索项目摘要（不需要 --project）
node src/checks/bundle.mjs <project.json> <包名>   # 交付包离线打开冒烟
npm run skills:check
npm run verify:public
```

改动渲染或空间关系后跑合成示例；改动技能或文档后跑 `skills:check`；发布前跑 `verify:public`（词表通过 `SPACE_DENYLIST` 或 `~/.config/house-plan/denylist.txt` 提供）。
