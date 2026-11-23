# 公开发布边界

公开仓库只允许出现：CLI 实现、技能、规范文档、项目模板、合成示例、测试，以及登记过许可与来源的通用资产。任何具体项目的图纸、数据、生成物、客户名称都不在其中。

## 白名单，默认拒绝

`publish-manifest.json` 是唯一依据。未登记的顶层目录、文件类型、二进制一律拒绝发布。

```json
{
  "schema": "publish-surface/v1",
  "layouts": {
    "target": {
      "allowDirectories": ["bin", "src", "schemas", "skills", "docs", "templates", "examples", "tests"],
      "allowFiles": ["package.json", "README.md", "LICENSE", "CHANGELOG.md"],
      "denyExtensions": [".dwg", ".dxf", ".pdf", ".zip"],
      "assetManifests": ["src/furniture/assets/catalog.json"]
    }
  },
  "binaries": {
    "registered": {
      "src/furniture/assets/sofa-main.glb": {"license": "CC0", "source": "https://…", "sha256": "…"}
    }
  }
}
```

- `layouts.current` / `layouts.target`：迁移期用 `current` 审计旧布局，发布用 `target`。
- `binaries.registered`：每个二进制必须写明许可、来源和哈希；哈希不符即拒绝。
- `assetManifests`：资产清单里的条目必须有 `license`、`source`、`file`，id 为 ASCII kebab-case。

## 检查码

| 码 | 含义 |
|---|---|
| P000 | 白名单文件缺失或无法解析 |
| P001 | 路径不在白名单 |
| P002 | 禁止发布的文件类型（图纸、压缩包、办公文档等） |
| P003 | 文本含本机绝对路径 |
| P004 | 命中私有敏感词表（文本或文件名） |
| P005 | 历史提交中出现过项目/生成物路径 |
| P006 | 二进制未登记、登记缺许可/来源、哈希不符 |
| P007 | 资产清单条目缺字段、文件不存在或 id 不规范 |

```sh
node toolkit/checks/public-surface.mjs --layout target --denylist ~/.config/house-plan/denylist.txt
```

## 敏感词表不进仓库

词表本身包含项目名与客户名，放进公开仓库等于泄漏。词表只保存在本机或私有仓库的 CI secret：

- 路径：`~/.config/house-plan/denylist.txt`，或环境变量 `SPACE_DENYLIST`
- 格式：每行一个子串（不区分大小写），`re:` 开头按正则，`#` 注释
- 不给词表时只做结构性检查（路径、类型、绝对路径、二进制、资产、历史）

## 发布流程

1. `public-surface --layout target` 通过（本地，带私有词表）
2. `npm pack` 后在临时目录安装并跑通示例
3. 才允许 `npm version` 与打 tag
4. CI 用同一脚本再跑一次（不带词表，结构性检查兜底）

## 历史

公开仓库必须从**全新历史**开始。项目路径一旦进入历史，删除工作树文件并不能消除泄漏；历史上出现过的项目内容只能通过转私有或废弃该仓库解决。

`P005` 用 `git log <ref> --diff-filter=A --name-only` 检查历史中的新增路径，删除过的文件同样会被发现。默认检查 `HEAD`；`--history-ref origin/main` 可审计已推送的历史。

不要用 `--all` 做发布审计：本地存档、备份分支和未推送的引用都会让它误报，也不代表实际公开内容。
