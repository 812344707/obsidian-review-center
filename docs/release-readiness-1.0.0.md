# 首个正式版准备记录

日期：2026-09-08。目标版本：1.0.0。状态：**本地候选已准备完成，等待实际使用验收与公开发行。** 当前公开版本仍为 0.4.6 测试版。

## 范围对齐

| 已确定需求 | 首版行为 | 验证入口 |
| --- | --- | --- |
| 笔记复习用于阅读和整理文件 | 原文评分、原生目录定位、文件移动后保留身份 | 隔离 Obsidian 流程 |
| 笔记以天安排，不指定日期 | 默认每日新 1 篇、回顾 10 篇、85%、最长 90 天 | 日期、队列和参数测试 |
| 知识点与笔记参数不同 | 问答／挖空卡片，独立每日额度与分钟步骤 | 两种模式评分与重载 |
| 分组简单，借鉴 Spaced Repetition | 自定义根标签、子标签展开、旧组合范围保留 | 标签、旧配置和主页选择测试 |
| 设置紧凑 | 横向分类、常用／高级分区、草稿与显式保存 | 桌面、窄屏与原生设置搜索 |
| 升级不丢进度 | 稳定 ID、备份先校验、异常数据停止写入 | 旧版升级、备份和损坏数据测试 |

## 本轮补齐

修复首次整理时写入编号造成索引暂时失效、知识点漏识别的问题；补齐数据读取和恢复边界、本机状态隔离、卸载回调清理、设置 API 兼容、入门手册、发布说明、问题反馈模板、CI 和安装包逐文件／哈希校验。

## 发布前验收

- [x] 候选代码完整检查通过：238 项测试、TypeScript、生产构建，官方 ESLint 0 错误。
- [x] 新安装与 0.4.6 升级在隔离的 Obsidian 1.13.7 中验收，含评分、撤销、移动、备份恢复、设置搜索与保存。
- [x] 候选安装包 6 文件／7 条校验通过；重复打包哈希相同；干净目录锁文件安装与构建一致。
- [ ] 用户常用知识库的日常体验确认。macOS 隔离应用已测；Windows／Linux 应用界面未测。
- [ ] 目标手机真机、软键盘、退出续接及实际同步验收。
- [ ] 核对候选后，执行公开发行。

本轮没有创建公开 1.0.0 标签、Release 或提交社区目录；也没有安装到正式知识库。目标手机平台尚未确认，真机与真实同步结果保持待验收。详细证据、截图和安装包哈希见 [验证记录](1.0.0-validation.md)。

## 发行流程

本地通过 `npm ci`、`npm run check`、`npm run check:optimizer` 和 `npm run package` 后，在干净目录重建并比较程序哈希。公开发行时，提交、`1.0.0` 标签和 Release 必须一致，并提供 `main.js`、`manifest.json`、`styles.css`、安装 ZIP 与校验清单。上传后从公开地址重新下载核对，不能只依据推送成功。

进入 Obsidian 社区目录还需要通过其审核。当前官方流程是在社区目录关联 Obsidian／GitHub 账号后提交仓库，不再沿用旧教程的登记 PR。目录审核会分别检查清单、附件、源码和构建；GitHub 正式 Release 与社区上架是两步。

## 调研依据

- [Obsidian：提交插件](https://docs.obsidian.md/plugins/releasing/submit-plugin)——仓库文件、版本与独立附件，以及当前目录提交入口。
- [Obsidian：插件提交要求](https://docs.obsidian.md/community-directory/submission-requirements-for-plugins)——最低版本、简介与桌面 API 边界。
- [Obsidian：开发者政策](https://docs.obsidian.md/community-directory/developer-policies)——公开说明、离线使用、依赖和许可资料。
- [Obsidian：审核与构建 FAQ](https://docs.obsidian.md/community-directory/faq)——官方本地 ESLint 和生产构建核验。
- [Obsidian 官方 ESLint](https://github.com/obsidianmd/eslint-plugin)——复用官方规则进行检查。
- [Spaced Repetition 的 CI](https://github.com/st3v3nmw/obsidian-spaced-repetition/blob/main/.github/workflows/test.yml)——参考锁文件安装、代码检查、测试分开执行的做法。

历史阶段的调研与已发布版本证据保留在 [更新记录](../CHANGELOG.md) 和对应版本文档中。
