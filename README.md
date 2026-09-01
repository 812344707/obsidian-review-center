# 复习中心

一个面向手机使用的 Obsidian 复习插件。它只做两件事：按 FSRS 复习整篇笔记，以及复习您手动写在笔记末尾“复习章节”里的问答和挖空卡片。

> 当前为 `0.1.0` 公开测试版。建议先在测试库或已备份的 Vault 中体验。

## 当前功能

- 独立的“笔记复习”和“卡片复习”入口，各自显示到期数和新内容数。
- 使用 `ts-fsrs` 的 FSRS-6 排程，提供重来、困难、良好、简单四档评分和预计下次间隔。
- 笔记复习直接打开 Obsidian 原生笔记，底部显示移动端评分条；软键盘出现时自动收起。
- 卡片页可查看整篇原文，也可直接定位到卡片块编辑，返回后仍停在同一张卡。
- 支持暂停、恢复、移除、重置、撤销最近一次评分和额外复习。
- 每来源笔记一份轻量快照，每会话一份追加式历史，适合通过 Obsidian Sync 在电脑与手机间同步。
- 完整 JSON 备份/恢复和复习历史 CSV 导出。

## 使用方法

1. 在设置 → 复习中心中填写要纳入复习的文件夹。插件不会默认扫描整个 Vault。
2. 在需要制卡的笔记末尾手动建立 `## 复习`。标题文字和层级可在设置中修改。
3. 在复习章节内手写问答或挖空。插件只会在这个章节里识别卡片。

多行问答：

```markdown
## 复习

### 核心概念

问:: FSRS 的作用是什么？
答::
根据每次评分估计记忆状态，并安排下一次复习。

- 答案可以有多段
- 可以使用列表、链接、图片和其他 Markdown

### 挖空

FSRS 使用 {{c1::稳定性}}、{{c2::难度}} 和 {{c3::可提取性}} 描述记忆。
```

问答答案会延续到下一张 `问::` 或下一个子标题。因此，问答后要写独立挖空时，请像示例一样另起子标题。

挖空遵循 Anki 语义：同一编号一起隐藏，不同编号生成不同卡片，也支持 `{{c1::答案::提示}}`。

插件会在复习章节内补充形如 `^rv-...` 的稳定块 ID，并在笔记属性区维护一个 `review_id`。正文其他部分不会被解析或改写。

## 同步

排程数据默认写入 Vault 根目录的 `复习中心数据/`：

```text
复习中心数据/
  records/   # 每来源笔记一份当前快照
  history/   # 每设备、每会话独立的操作历史
  exports/   # JSON 备份和 CSV
```

在 Obsidian Sync 设置中开启“同步其他文件类型”。当前复习到哪一张只保存在本机；评分、排程和历史会同步。

## 开发与安装

```bash
npm install
npm test
npm run build
```

手动安装时，从 [Releases](https://github.com/812344707/obsidian-review-center/releases) 下载 `main.js`、`manifest.json` 和 `styles.css`，复制到 Vault 的 `.obsidian/plugins/review-center/`，然后在 Obsidian 设置中启用。

遇到问题或有功能建议，可以在 [GitHub Issues](https://github.com/812344707/obsidian-review-center/issues) 中反馈。请尽量附上 Obsidian 版本、设备类型和复现步骤，不要上传包含隐私的笔记内容。

## 复用的开源项目

- [Obsidian Sample Plugin](https://github.com/obsidianmd/obsidian-sample-plugin)：官方 TypeScript/esbuild 插件骨架，0BSD。
- [ts-fsrs](https://github.com/open-spaced-repetition/ts-fsrs)：FSRS-6 TypeScript 排程库，MIT。
- [Obsidian Spaced Repetition](https://github.com/st3v3nmw/obsidian-spaced-repetition)：参考其成熟的笔记/卡片队列与 ItemView 设计，MIT；本插件没有采用其“把排程写回原文”的存储方式。

## 首版边界

不包含片段复习、正文选区制卡、自动创建复习章节、AI 制卡、视频处理、后台手机通知或 FSRS 参数训练。
