# HouseSpec 设计器入口

使用 `space.mjs build --project … --viewer designer`；配置中的 `spec` 指向 HouseSpec JSON。

唯一模板在 `../../legacy/assets/template.html`，生成实现是 `../../legacy/scripts/build.py`。编译设计器的源码不在本仓库，本目录仅标明边界，不再复制第二份大模板。

HouseSpec 与 `space-model/v1` 的构件表达不同：前者沿用编辑器已有墙线、房间、洞口与家具 API，后者存储核查后的实体多边形及竖向关系。没有自动双向转换；需要具体项目提供经过核查的适配，不能为了打开设计器丢掉挑空、来源或局部净高。
