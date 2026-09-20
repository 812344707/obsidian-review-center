# 1.4.1 · 更新保留设置

修复更新或重装插件后设置指针可能回到默认值、需要重新选择复习数据目录的问题。

插件设置现在同时保存到原有 `data.json` 和知识库 `.review-center/settings.json`。两份副本使用同一修订号和更新时间；启动时如果发现插件目录中的主设置被重建、丢失、损坏或回滚，会从知识库镜像恢复较新的有效设置，并重新统一两份副本。数据目录、复习标签、复习参数、显示、习题页和自动出题配置均走同一保存入口。

设置镜像不保存 API 密钥值，只保存 SecretStorage 的密钥名称；密钥值仍由 Obsidian SecretStorage 管理。安装包仍不包含 `data.json`、设置镜像、笔记或复习数据。

[下载完整安装包](https://github.com/812344707/obsidian-review-center/releases/download/1.4.1/review-center-1.4.1.zip)。最低要求 Obsidian 1.13.0。

验证范围见[验证记录](https://github.com/812344707/obsidian-review-center/blob/1.4.1/docs/1.4.1-validation.md)，升级步骤见[升级说明](https://github.com/812344707/obsidian-review-center/blob/1.4.1/docs/1.4.1-upgrade.md)。
