# Curator Skills

[English](README.md) | 简体中文 | [繁體中文](README.zh-TW.md)

> 人生苦短，把时间留给自己真正热爱的事物。

买的游戏太多，根本玩不过来？书架上摆满了书，却不知道下一本该读什么？

Curator Skills 让你的 AI 了解你的喜好，帮助你决定如何度过有限的闲暇时间。不同于商店或推荐信息流，你的专属顾问服务的是你，而不是用户活跃度、销量或消费量。有时候，最好的推荐是你已经拥有的游戏或书籍、值得重温的作品，甚至是什么新东西都不买。

## 快速开始

[安装](#安装) Game Curator、Book Curator，或同时安装两者，然后试试以下对话。你可以直接告诉 AI 自己的喜好，不一定要导入游戏库或书单。

### 🎮 Game Curator（游戏顾问）

**玩你已经拥有的游戏。** 你的下一款心头好可能早就在 Steam 游戏库里了。

> 我在 Steam 打折时买了太多游戏。看看我的游戏库和游玩记录，这个周末我有几个小时空闲，接下来该玩什么？

**让每一次购买都物有所值。** 折扣再大，也只有你真的喜欢这款游戏才算划算。

> 我的 Steam 愿望单里，哪款游戏最值得下一次购买？考虑我的喜好、已经拥有的游戏、当前折扣，以及能够核实的历史促销价格。如果继续等更合适，也请告诉我。

**发现自己的游戏偏好。** 聊聊真实的游玩体验，而不只是评分或游玩时长。

> 我们来聊聊我最近玩过的游戏吧。问问我喜欢什么、什么让我感到沮丧，以及为什么有些游戏玩到一半就不玩了。帮我弄清楚自己真正喜欢哪些类型的游戏。

### 📚 Book Curator（阅读顾问）

**读你已经拥有的书。** 一本本读完积压的书，而不是让待读清单越变越长。

> 我的待读清单里，下一本应该读什么？最好是我已经拥有但还没读过的书。

**在新书和促销活动中做选择。** 即使是免费书籍，也需要花时间阅读。

> 根据我过去喜欢读的书，本月 Kindle First Reads 的选书中，哪一本最适合我？

**从阅读经历中了解自己。** 发现是什么让你愿意一直读下去。

> 我们来聊聊我最近读过的几本书吧。问问我是什么让我继续读下去、哪些地方不合我的口味，以及以后还想多读些什么。帮我了解自己的阅读偏好。

## 安装

两个技能都是可以独立安装的 [Agent Skills](https://agentskills.io/specification)。使用 [skills CLI](https://github.com/vercel-labs/skills) 安装所需的技能（需要 Node.js 22.20 或更新版本以及 npm）。Game Curator 的数据工具也使用 Node.js。无需构建。

**Codex**

```sh
npx skills add CatChen/curator-skills --skill game-curator --global --agent codex
npx skills add CatChen/curator-skills --skill book-curator --global --agent codex
```

**Claude Code**

```sh
npx skills add CatChen/curator-skills --skill game-curator --global --agent claude-code
npx skills add CatChen/curator-skills --skill book-curator --global --agent claude-code
```

在 AI 客户端中启动一个新会话，试着提出上面的问题之一，或者在 Codex 中显式调用 `$game-curator` 或 `$book-curator`，在 Claude Code 中调用 `/game-curator` 或 `/book-curator`。

## 让第一次推荐更贴合你的喜好

从一个简单的问题开始就可以，不需要导入数据或登录账号。如果你希望顾问利用更多历史记录，可以试试：

> 通过我的 Steam 游戏库、愿望单和评测，了解我的游戏喜好。

> 帮我从 Goodreads 阅读记录开始，了解我的阅读偏好。

如需自动采集 Steam 数据，请使用 Codex Desktop 或 Claude 桌面应用中的 Claude Code。Goodreads 流程会指导你下载自己的导出文件。你也可以直接聊聊自己喜欢的游戏或书籍。

## 支持的平台和数据来源

两个技能都可以在 Codex 和 Claude Code 中通过对话使用。你也可以提供自己的清单、笔记或阅读记录文件。其他兼容 Agent Skills 的客户端也可能适用。

| 技能 | 数据来源 |
| --- | --- |
| [Game Curator](skills/game-curator/SKILL.md) | Steam 游戏库、愿望单、评测和年度回顾（Replay）；你自己的游玩记录和反馈。 |
| [Book Curator](skills/book-curator/SKILL.md) | Goodreads CSV 导出文件；你自己的阅读清单、文件和反馈。 |

**Steam：** Game Curator 使用 Codex Desktop 或 Claude 桌面应用中 Claude Code 的兼容浏览器工具（内置浏览器或 Chrome 集成），以只读方式采集数据。需要登录时，请自行登录。采集结果可能不完整。其他运行环境（包括独立的命令行会话）可能无法访问浏览器；你仍然可以使用现有数据或自己的游玩记录。

**Goodreads：** 在 Goodreads 的[导入／导出页面](https://www.goodreads.com/review/import)申请并下载 CSV 文件，然后将文件提供给 AI。可选的导入工具使用 Python 3。参见 [Goodreads 使用流程](skills/book-curator/references/goodreads.md)。Amazon Kindle 和 Audible 不提供自动化集成。Goodreads 的待读书架只代表阅读意向，并不一定意味着你已经拥有这些书。

需要时，你的顾问也可以利用可访问的公开来源查询当前价格、历史折扣和图书促销活动。

## 一个与你共同成长的顾问

告诉 AI 为什么某个推荐合适或不合适、你玩完或放弃了哪些游戏、重读了哪些书，或者你有多少空闲时间。你的真实感受比作品的流行程度更有参考价值。顾问会区分你明确表达的喜好和暂时的推断，并根据你的纠正不断调整。

当时机合适时，例如你有出人意料的反应、两段体验形成对比，或你试过某个推荐，顾问可能会在帮你解决问题之后提出一个具体的问题，有时也会就你打算尝试的内容追问一次，最多一次。在它从你的 Steam 或 Goodreads 历史中有所了解之后，可能会邀请你进行一次可选的、更深入的口味交流。简单的问题仍会得到简短的回答，你随时可以拒绝或换个话题。

在获得你的许可后，每个技能都可以在你自己的文件中保存易于阅读的偏好档案和反馈记录。你也可以单独选择缓存来源数据，避免未来每次对话都从头开始或重新导入。两者都不是必需的。

如果 Codex 和 Claude Code 都能访问同一个经过授权的持久化目录，它们就可以共享偏好档案、反馈和缓存。换一个 AI 客户端，也不必从头开始。项目不提供自动云同步。

## 隐私和数据所有权

你的个人数据属于你。如果运行环境能够访问你真实且由你控制的用户主目录，可选的持久化文件默认保存在 `~/.curator/` 中。你可以查看或编辑这些文件、拒绝存储、撤销许可，或要求删除自己的数据。

- 偏好档案和反馈的持久化存储，与原始数据缓存，需要分别获得你的明确同意。
- 数据采集为只读操作；技能不会索要你的密码、Cookie 或令牌。
- 本项目不添加遥测功能，也不提供托管个人数据的后端服务。
- 本地存储**不等于**本地处理。AI 运行环境、服务提供商和已连接的工具可能会处理你分享或授权读取的信息。

详情和限制请参阅[隐私原则](docs/privacy.md)。

## 路线图

Curator Skills 从 Steam 和 Goodreads 起步，但你的兴趣并不局限于单一平台。

### Game Curator

- [x] Steam
- [ ] Epic Games Store
- [ ] GOG

### Book Curator

- [x] Goodreads
- [ ] Amazon Kindle
- [ ] Audible

### 所有顾问

- [ ] 探索 [NeoDB](https://neodb.net/) 对多种媒介类型的支持。
- [ ] 支持更多 AI 运行环境。
- [ ] 提高数据采集的可靠性，减少人工干预。
- [ ] 通过持续学习改进推荐，包括提出更有帮助的追问。

未来能否支持这些功能，取决于平台能力、访问权限和可行性。我们期待了解你在使用哪些平台，以及希望顾问帮你做什么——欢迎[提交 Issue](https://github.com/CatChen/curator-skills/issues)。

## 贡献与许可证

欢迎贡献代码、文档及真实使用反馈。参见[贡献指南](CONTRIBUTING.md)、[架构说明](docs/architecture.md)和[产品理念](docs/philosophy.md)。

[MIT 许可证](LICENSE)。
