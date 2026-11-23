# 项目内 AI 工作入口

本项目提供三个领域流程和两个交付入口，均为普通 Markdown，不依赖特定 AI、账号或插件。根据当前任务读取对应文件及其链接的共享约定；无需每次加载全部流程。

| 当前任务 | 读取 |
|---|---|
| CAD 图纸读取、核查、转成可维护空间数据 | [.agents/skills/cad-to-space-data/SKILL.md](.agents/skills/cad-to-space-data/SKILL.md) |
| 依据户型进行布局、拆改、管路与动线设计 | [.agents/skills/floor-plan-design/SKILL.md](.agents/skills/floor-plan-design/SKILL.md) |
| 已有平面设计转三维白模、配置家具、展示定制柜及室内体验 | [.agents/skills/plan-to-3d/SKILL.md](.agents/skills/plan-to-3d/SKILL.md) |
| 已确认设计更新后同步三维、固定机位出图和差异复核 | [.agents/skills/design-to-3d-sync/SKILL.md](.agents/skills/design-to-3d-sync/SKILL.md) |
| 基础模型图 + 风格意向图生成彩平图或室内效果图 | [.agents/skills/design-image-render/SKILL.md](.agents/skills/design-image-render/SKILL.md) |

连贯任务可顺序使用；已有设计图可直接走“CAD 数据 → 三维”，不重新设计。只改家具或柜高时复用已核查数据，检查受影响的关系，不重做整份 CAD。设计版本更新已有三维时先走同步入口，读取 `design-manifest.json` 再决定是否构建。

当前用户指令优先于历史交接。先识别有效资料、被废弃的方案与用户修改；不要把其他项目或旧方案的布局、标高、源句柄套入当前任务。

根目录 [SKILL.md](SKILL.md) 保留原有设计器生成流程和工具说明。使用已有模板或脚本时按需阅读；其中默认补家具、布水电等做法不自动扩大本次任务范围。

不自动发现 skill 的 AI，可直接读取本文件并沿链接使用。复制这套流程到其他项目时，应一并携带五份 skill 和 [共享数据约定](reference/space-workflow-contract.md)；仓库工具链接属于可选实现参考。

## 公共工具与项目边界

公共实现集中在 [toolkit/](toolkit/README.md)，统一入口为 `node toolkit/cli/space.mjs`。先按任务读取 [数据格式](toolkit/schemas/README.md)；新项目使用独立 `project.json`，不要复制某个项目生成器里的源句柄、颜色判断或标高。

- CAD 原图索引、空间实体、HouseSpec 是不同接口；不做隐式有损转换。
 - 设计版本更新三维时使用 `design-sync/v1` manifest，先运行 `sync check`，再运行 `check` 和 `build`。
 - 彩平或效果图出图时，先区分基础图、风格图和数据标注；标准彩平优先用确定性渲染，风格化结果再走 `design-image-render`。
- 公共源码只改 `toolkit/`；早期脚本在 `toolkit/legacy/`。
- 图纸特有的抽取/修复继续放在对应 `projects/<id>/`。早期识别脚本的适用范围见 [兼容说明](toolkit/legacy/README.md)。
- 修改渲染或空间关系后验证独立两层示例；涉及真实项目时再运行该项目的检查。`model: null` 表示资料待导入，不能用其他项目填充。
