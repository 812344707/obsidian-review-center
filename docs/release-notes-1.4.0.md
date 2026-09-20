# 1.4.0 · 自动出题模式

新增可选的自动出题闭环：连接 OpenAI Responses 或兼容 Chat Completions 的结构化输出 API，自定义模型、提示词、题库文件夹、标签、每批题量、掌握率阈值和题量上限。

生成题目继续使用插件现有的 `[!review]+`、`问::` / `答::`、`Extra:` 和稳定卡片编号。题库必须先通过现有解析器；请求期间若原文、题库、复习记录或相关设置发生变化，返回结果会被丢弃，不覆盖用户的新修改。

续题由题库真实评分历史控制：无题时生成首批，存在未作答或待确认内容时等待，全部答完但掌握率不足时追加，达到阈值或题量上限时停止。手动入口始终可用；“评分后自动评估”默认关闭。

API 密钥值由 Obsidian SecretStorage 保存，普通插件设置只记录密钥名称。只有用户主动配置并触发时，当前原文、已有题目和相关评分表现才会发送给用户指定的服务；数据政策由所选服务商负责。

[下载完整安装包](https://github.com/812344707/obsidian-review-center/releases/download/1.4.0/review-center-1.4.0.zip)。最低要求 Obsidian 1.13.0；升级保留现有 `data.json`、复习数据、稳定标识、评分和排程。

验证范围与已知边界见[验证记录](https://github.com/812344707/obsidian-review-center/blob/1.4.0/docs/1.4.0-validation.md)，升级步骤见[升级说明](https://github.com/812344707/obsidian-review-center/blob/1.4.0/docs/1.4.0-upgrade.md)。
