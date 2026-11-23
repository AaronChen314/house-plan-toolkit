# 早期脚本兼容层

这些脚本从仓库根目录 `scripts/` 集中迁入，保留原调用参数。原路径只转发到这里，修复时只改一份实现。

| 用途 | 脚本 |
|---|---|
| 位图、截图、透视与比例 | rectify、analyze、cadshot、gridmm、dimocr |
| CAD 矢量、墙线与图纸拆分 | cadvec、cadpair、cadsplit、wallfit |
| DXF 图块整理与索引 | dxf_prepare、dxfinventory、dxfaudit |
| 尺寸链与双图对齐 | dimtext、dimticks、align2、axismap |
| 对图核查 | wallaudit、doorcheck、coverage、furnoverlay |
| HouseSpec 生成 | build |
| HouseSpec 浏览器检查 | check、qa、qa_furniture、qa_styles、clicktest、closeup、walktest、elecaudit |
| 辅助模块/批处理 | imgio、bench、qa_files |

可以调用 `node toolkit/cli/space.mjs run <名称> <原参数>`。`imgio`、`axismap` 等也供其他脚本导入，不必独立执行。详细参数读取各脚本帮助/源码，原有识别路线文档仍在仓库 `reference/`。

这些算法保留各自输入前提，不声称合并成“任意 CAD 自动理解”。例如旧 DXF 预处理可能重写颜色、套用图层分类；图纸通用索引应优先用 `cad/read.py`。对照当前图例确认后，再按需使用旧语义识别。所有预处理都应输出新文件并保留源图。

`assets/template.html` 是已有 HouseSpec 设计器的编译成品，仍包含默认示例；`build.py` 用项目 HouseSpec 注入它。设计器源码不在本仓库，所以本次只集中管理编译模板与适配入口，没有冒充已拆分其内部编辑器。

依赖具体图纸的抽取脚本、模板与检查程序作为本地项目工具保存。可用公共入口运行仓库自带的 [两层示例](../README.md#先运行独立示例)。
