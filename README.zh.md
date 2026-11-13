# dsh-tameru

适用于 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的 [Tameru](https://github.com/0xWhiteMage/tameru-compaction-system)：在工具输出占满上下文之前将其缩短，保留每一条错误，并支持固定、保留与恢复。本地、确定性，不额外调用模型。

> **状态：早期开发（0.1.0，未发布）。** 完整说明与已验证范围见[英文 README](README.md)。**尚未证明能降低成本**：在模拟会话中，默认设置下成本持平，放宽置信度门槛后约高 3%，同时多保留约 0.7/5 个所需事实（见 [docs/REPLAY-VS-STOCK.md](docs/REPLAY-VS-STOCK.md)）。

## 功能

- **缩短**：当上下文超过 Harness 自身压缩触发点的 75% 时，用引擎的查询式摘录替换较大的旧工具结果；错误、最新几条、模型尚未读到的结果不会被改动。原文保留在对话日志中。
- **读回原文**：每条被缩短的结果都带有引用编号；模型可用 `tameru_read_original` 读回，你可用 `/tameru view N` 查看。
- **保留与恢复**：`/tameru keep N`、`/tameru restore N`、`/tameru unkeep N`。
- **固定**：`/tameru pin 文字` 将你写的话逐字放进系统提示，任何压缩都不会替换它（最多 5 条、每条 300 字符；形似凭据的内容会被拒绝）。
- **Artifact Trail**：Harness 压缩之后补充一条简短记录：涉及的文件、运行的命令、不同的错误。
- **Tameru 标签页**：右侧栏中的上下文量表、已缩短结果列表与查看器、固定内容与设置，支持中英文与明暗主题。

## 约束

仅在 DeepSeek Harness **0.2.2-rc.1** 上测试；需要 Python（使用 Harness 自带的）。它不替换、不禁用、不包装 Harness 或其他插件的任何部分；`enabled: false` 时什么都不做。

许可证：Apache-2.0。
