# 两层示例（合成数据）

用于回归：负标高、异地原点、挑空、局部顶面、不同板厚、两个室内入口。不含任何真实项目资料。

```sh
space lint --project examples/two-level/project.json
space build --project examples/two-level/project.json --viewer drawing
space build --project examples/two-level/project.json
node src/checks/white-model.mjs examples/two-level/output/白模.html
```
