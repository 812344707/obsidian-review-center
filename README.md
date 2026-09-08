# 渐进式复习 · Progressive Review

在 Obsidian 原文中阅读和整理笔记，用问答或挖空复习知识点，通过 FSRS 安排下一次复习。整篇笔记和知识点使用独立的参数与进度。

**当前版本：1.0.0 正式版。** [下载完整安装包](https://github.com/812344707/obsidian-review-center/releases/download/1.0.0/review-center-1.0.0.zip) · [发布页面](https://github.com/812344707/obsidian-review-center/releases/tag/1.0.0)。最低要求 Obsidian 1.13.0；插件内部 ID 保持 `review-center`，升级沿用现有设置和复习数据。

## 开始使用

1. 安装插件，在笔记属性或正文添加 `#review`。
2. 打开侧栏脑形图标，点击“整理数据”。
3. 选择“笔记”或“卡片”，选择标签，点击“开始”。

笔记复习直接打开原文，便于阅读、修改和移动文件；知识点复习先回忆，再揭示答案并评分。可在“设置 → 渐进式复习 → 复习标签”中分别修改两类标签。

完整示例见 [第一次使用](docs/getting-started.md)，详细格式和参数见 [使用手册](docs/user-guide.md)。

## 核心功能

- **自定义标签分组**：一个标签就是一组，自动包含子标签。已有组合范围保留在“原有分组”，不会擅自更改纳入范围。
- **按天回顾笔记**：无需指定日期，评分后最早次日再出现；进入复习时自动启用原生 Auto-reveal active file，让文件列表跟随当前笔记。
- **正文制卡**：支持 `Q:` / `A:`、`START/END`、`{{c1::挖空}}` 和 `[!review]` 提示块。原文底栏可快速插入模板或把选文设为挖空。
- **稳定的复习进度**：整理时写入来源和卡片标识，笔记移动、改名和重复整理保留原有排程。评分前核对来源与最新进度，支持撤销。
- **清晰的日常入口**：主页依次为整理数据、开始、统计、设置；常用参数放在标签齿轮的“选项”，高级参数默认折叠。
- **本地统计和备份**：今日数量、到期安排、趋势与热力图；JSON 备份恢复、评分 CSV 导出及数据目录迁移。电脑可离线优化 FSRS 参数，手机使用保存后的结果。

| 默认参数 | 整篇笔记 | 知识点卡片 |
| --- | --- | --- |
| 每日新内容 | 1 篇 | 10 张 |
| 每日到期复习 | 10 篇 | 100 张 |
| 目标记忆率 | 85%（高级设置） | 90% |
| 学习步骤 | 按天，无分钟步骤 | `1m 10m` |
| 重学步骤 | 按天，最早次日 | `10m` |
| 最长间隔 | 90 天 | 36500 天 |

这些是新建组的默认值，已有自定义参数保留。笔记按本地日期判断到期，知识点保留短期学习步骤。

## 安装与升级

解压安装包，将其中的 `review-center/` 放入知识库的 `.obsidian/plugins/`，在社区插件设置中启用“渐进式复习”。当前尚未提交 Obsidian 社区目录。

升级前关闭插件并备份知识库，把包内 6 个文件复制到原插件目录内，覆盖同名文件，**保留已有 `data.json` 和复习数据目录，不要替换整个插件文件夹**。安装包附带许可资料和依赖源码，不含个人设置或复习内容。下载文件名为 `review-center-1.0.0.zip`。

1.0.0 增加异常数据校验、本机状态隔离和设置 API 兼容。为避免同名知识库混用临时状态，旧版正在进行的临时队列、主页位置和会话撤销记录不自动迁入；再次点击“开始”会依据保留的排程继续。详情见 [1.0.0 升级说明](docs/1.0.0-upgrade.md)。

## 数据和网络

排程、评分历史、备份及批量操作记录保存在知识库内的 `复习中心数据/`，路径可调整。配置保存在插件 `data.json`。正文解析缓存与当前会话仅保存在本机，清缓存不会删除复习进度。

插件不需要账号，不主动调用远程服务，不上传笔记或遥测数据，不读写知识库外的用户文件。原文中的远程图片、链接及知识库同步由 Obsidian 或用户已有工具处理；它们可能访问网络。参数优化模块已嵌入安装包，运行时无需下载。

跨设备需同步复习数据目录；使用 Obsidian Sync 时启用其他文件类型，若同步配置还需同步插件设置。开始前等待同步完成。真实手机软键盘与跨设备并发同步仍需验收，已测环境及限制见 [1.0.0 验证记录](docs/1.0.0-validation.md) 和 [发行准备清单](docs/release-readiness-1.0.0.md)。

本版不含单卡独立标签、跨笔记移动卡片的进度迁移、自动制卡或后台手机通知。

## 开发、反馈与版本记录

开发环境、检查和打包命令见 [贡献指南](CONTRIBUTING.md)。本地优化模块无需 Rust 即可构建插件；重编模块见 [优化模块说明](optimizer/README.md)。

反馈请使用 [GitHub Issues](https://github.com/812344707/obsidian-review-center/issues)，提供设备、Obsidian／插件版本、复现步骤和不含隐私的最小示例。

历次变化见 [更新记录](CHANGELOG.md)。1.0.0 的 [发布说明](docs/release-notes-1.0.0.md) 与 [发行记录](docs/release-readiness-1.0.0.md) 区分本地验证、实际设备验收和公开发行状态。

## 复用与许可

开发前先调研已有方案。本项目采用 MIT 许可，详见 [LICENSE](LICENSE)；依赖的完整许可、声明与必要源码见 [第三方声明](THIRD_PARTY_NOTICES.txt)。

- [Obsidian Sample Plugin](https://github.com/obsidianmd/obsidian-sample-plugin)：官方骨架，0BSD。
- [ts-fsrs](https://github.com/open-spaced-repetition/ts-fsrs)：FSRS-6 排程，MIT。
- [fsrs-rs](https://github.com/open-spaced-repetition/fsrs-rs)：参数优化、评估与模拟，固定使用 `fsrs 6.6.2`，BSD-3-Clause。
- [Obsidian Spaced Repetition](https://github.com/st3v3nmw/obsidian-spaced-repetition)：参考标签分组、队列与视图设计，MIT。
- [Obsidian_to_Anki](https://github.com/ObsidianToAnki/Obsidian_to_Anki)：参考正文格式、稳定 ID 与内容更新方式，MIT。
