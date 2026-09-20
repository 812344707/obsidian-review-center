# 1.5.0 · 多厂商接口与迁移收口

自动出题现在可直接选择 OpenAI、Anthropic、Google Gemini、DeepSeek、阿里云百炼／通义千问、Kimi、智谱、SiliconFlow、OpenRouter、Ollama 或自定义服务。插件新增 Anthropic Messages 和 Gemini generateContent 原生适配，同时保留 OpenAI Responses 与通用 OpenAI 兼容 Chat Completions。预设不锁定快速变化的模型版本，模型 ID 和密钥仍由用户按对应控制台填写。

数据目录“迁移”不再以永久保留源目录作为默认结果。插件会先复制并逐文件核对、保存新路径、从新目录重新读取，随后把未被同步改动的旧目录移入系统废纸篓或知识库 `.trash`。检测到同步竞争时，宁可保留旧目录并提示。旧版本的遗留目录可在设置页明确输入路径、二次确认后清理，当前活动目录受到硬保护。

升级包不包含设置、API 密钥、笔记或复习数据，1.4.1 的双副本设置恢复机制继续有效。最低要求 Obsidian 1.13.0。

[下载完整安装包](https://github.com/812344707/obsidian-review-center/releases/download/1.5.0/review-center-1.5.0.zip)。

验证范围见[验证记录](https://github.com/812344707/obsidian-review-center/blob/1.5.0/docs/1.5.0-validation.md)，升级步骤见[升级说明](https://github.com/812344707/obsidian-review-center/blob/1.5.0/docs/1.5.0-upgrade.md)。
