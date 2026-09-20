# 1.3.1 · 数据目录移动修复

修复在 Obsidian 文件树中直接移动复习数据目录后，插件重启仍按旧路径创建默认目录的问题。

现在移动复习数据目录本身，或移动包含它的上级文件夹时，插件会立即计算新位置、切换当前存储路径并保存设置。该移动事件不会再被当作普通复习素材改名处理；设置页已打开时，目录输入草稿也会跟随更新。

升级不修改已有笔记、复习记录、评分、排程或历史，也不会自动删除用户此前保留的旧目录。

[下载完整安装包](https://github.com/812344707/obsidian-review-center/releases/download/1.3.1/review-center-1.3.1.zip)。最低要求 Obsidian 1.13.0。

验证范围与已知边界见[验证记录](https://github.com/812344707/obsidian-review-center/blob/1.3.1/docs/1.3.1-validation.md)，升级步骤见[升级说明](https://github.com/812344707/obsidian-review-center/blob/1.3.1/docs/1.3.1-upgrade.md)。
