# Curator Skills

[English](README.md) | [简体中文](README.zh-CN.md) | 繁體中文

> 人生苦短，把時間留給自己真正熱愛的事物。

買了太多遊戲，根本玩不完？書架上擺滿了書，卻不知道下一本該讀什麼？

Curator Skills 讓你的 AI 了解你的喜好，幫助你決定如何度過有限的休閒時間。不同於商店或推薦動態，你的專屬顧問服務的是你，而不是使用者互動率、銷量或消費量。有時候，最好的推薦是你已經擁有的遊戲或書籍、值得重溫的作品，甚至是什麼新東西都不買。

## 快速開始

[安裝](#安裝) Game Curator、Book Curator，或同時安裝兩者，接著試試以下對話。你可以直接告訴 AI 自己的喜好，不一定要匯入遊戲庫或書單。

### 🎮 Game Curator（遊戲顧問）

**玩你已經擁有的遊戲。** 你的下一款最愛可能早就在 Steam 遊戲收藏庫裡了。

> 我在 Steam 特價時買了太多遊戲。看看我的遊戲收藏庫和遊玩紀錄，這個週末我有幾個小時的空閒時間，接下來該玩什麼？

**讓每一次購買都物有所值。** 折扣再大，也只有你真的喜歡這款遊戲才算划算。

> 我的 Steam 願望清單裡，哪款遊戲最值得下一次購買？考慮我的喜好、已經擁有的遊戲、目前的折扣，以及能夠查證的歷史特價。如果繼續等更合適，也請告訴我。

**發現自己的遊戲偏好。** 聊聊真實的遊玩體驗，而不只是評分或遊玩時數。

> 我們來聊聊我最近玩過的遊戲吧。問問我喜歡什麼、什麼讓我感到挫折，以及為什麼有些遊戲玩到一半就不玩了。幫我弄清楚自己真正喜歡哪些類型的遊戲。

### 📚 Book Curator（閱讀顧問）

**讀你已經擁有的書。** 一本本讀完積壓的書，而不是讓待讀清單越變越長。

> 我的待讀清單裡，下一本應該讀什麼？最好是我已經擁有但還沒讀過的書。

**在新書與優惠活動中做選擇。** 即使是免費書籍，也需要花時間閱讀。

> 根據我過去喜歡讀的書，本月 Kindle First Reads 的選書中，哪一本最適合我？

**從閱讀經驗中了解自己。** 發現是什麼讓你願意一直讀下去。

> 我們來聊聊我最近讀過的幾本書吧。問問我是什麼讓我繼續讀下去、哪些地方不合我的口味，以及以後還想多讀些什麼。幫我了解自己的閱讀偏好。

## 安裝

兩個技能都是可以獨立安裝的 [Agent Skills](https://agentskills.io/specification)。使用 [skills CLI](https://github.com/vercel-labs/skills) 安裝所需的技能（需要 Node.js 22.20 或更新版本以及 npm）。Game Curator 的資料工具也使用 Node.js。不需要建置。

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

在 AI 用戶端開啟新的對話，試著提出上面的其中一個問題，或在 Codex 中明確呼叫 `$game-curator` 或 `$book-curator`，在 Claude Code 中呼叫 `/game-curator` 或 `/book-curator`。

## 讓第一次推薦更貼合你的喜好

從一個簡單的問題開始就可以，不需要匯入資料或登入帳號。如果你希望顧問參考更多歷史紀錄，可以試試：

> 透過我的 Steam 遊戲收藏庫、願望清單和評論，了解我的遊戲喜好。

> 幫我從 Goodreads 閱讀紀錄開始，了解我的閱讀偏好。

如需自動擷取 Steam 資料，請使用 Codex Desktop 或 Claude 桌面應用程式中的 Claude Code。Goodreads 流程會引導你下載自己的匯出檔案。你也可以直接聊聊自己喜歡的遊戲或書籍。

## 支援的平台與資料來源

兩個技能都可以在 Codex 和 Claude Code 中透過對話使用。你也可以提供自己的清單、筆記或閱讀紀錄檔案。其他相容於 Agent Skills 的用戶端也可能適用。

| 技能 | 資料來源 |
| --- | --- |
| [Game Curator](skills/game-curator/SKILL.md) | Steam 遊戲收藏庫、願望清單、評論與年度回顧（Replay）；你自己的遊玩紀錄與回饋。 |
| [Book Curator](skills/book-curator/SKILL.md) | Goodreads CSV 匯出檔案；你自己的閱讀清單、檔案與回饋。 |

**Steam：** Game Curator 使用 Codex Desktop 或 Claude 桌面應用程式中 Claude Code 的相容瀏覽器工具（內建瀏覽器或 Chrome 整合功能），以唯讀方式擷取資料。需要登入時，請自行登入。擷取結果可能不完整。其他執行環境（包括獨立的命令列工作階段）可能無法存取瀏覽器；你仍然可以使用現有資料或自己的遊玩紀錄。

**Goodreads：** 在 Goodreads 的[匯入／匯出頁面](https://www.goodreads.com/review/import)申請並下載 CSV 檔案，再將檔案提供給 AI。選用的匯入工具使用 Python 3。請參閱 [Goodreads 使用流程](skills/book-curator/references/goodreads.md)。Amazon Kindle 和 Audible 不提供自動化整合。Goodreads 的待讀書架只代表閱讀意願，並不一定表示你已經擁有這些書。

需要時，你的顧問也可以利用可存取的公開來源查詢目前價格、歷史折扣和圖書優惠活動。

## 一個與你共同成長的顧問

告訴 AI 為什麼某個推薦合適或不合適、你玩完或放棄了哪些遊戲、重讀了哪些書，或者你有多少空閒時間。你的真實感受比作品的熱門程度更有參考價值。顧問會區分你明確表達的喜好與暫時的推論，並根據你的指正持續調整。

當時機合適時，例如你有出人意料的反應、兩段體驗形成對比，或你試過某個推薦，顧問可能會在幫你解決問題之後提出一個具體的問題，有時也會就你打算嘗試的內容追問一次，最多一次。在它從你的 Steam 或 Goodreads 歷史中有所了解之後，可能會邀請你進行一次可選的、更深入的口味交流。簡單的問題仍會得到簡短的回答，你隨時可以拒絕或換個話題。

在取得你的同意後，每個技能都可以在你自己的檔案中保存易於閱讀的偏好檔案與回饋紀錄。你也可以另外選擇快取來源資料，避免日後每次對話都從頭開始或重新匯入。兩者都不是必要的。

如果 Codex 和 Claude Code 都能存取同一個經過授權的持久化資料目錄，它們就可以共用偏好檔案、回饋和快取。換一個 AI 用戶端，也不必從頭開始。專案不提供自動雲端同步。

## 隱私與資料所有權

你的個人資料屬於你。如果執行環境能夠存取你實際且由你控制的家目錄，選用的持久化檔案預設儲存在 `~/.curator/` 中。你可以檢視或編輯這些檔案、拒絕儲存、撤銷授權，或要求移除自己的資料。

- 偏好檔案和回饋的持久化儲存，以及原始資料快取，需要分別取得你的明確同意。
- 資料擷取為唯讀操作；技能不會要求提供你的密碼、Cookie 或權杖。
- 本專案不新增遙測功能，也不提供託管個人資料的後端服務。
- 本機儲存**不等於**本機處理。AI 執行環境、服務供應商及已連線的工具可能會處理你分享或授權讀取的資訊。

詳細資訊和限制請參閱[隱私原則](docs/privacy.md)。

## 開發路線圖

Curator Skills 從 Steam 和 Goodreads 起步，但你的興趣並不侷限於單一平台。

### Game Curator

- [x] Steam
- [ ] Epic Games Store
- [ ] GOG

### Book Curator

- [x] Goodreads
- [ ] Amazon Kindle
- [ ] Audible

### 所有顧問

- [ ] 探索 [NeoDB](https://neodb.net/) 對多種媒體類型的支援。
- [ ] 支援更多 AI 執行環境。
- [ ] 提高資料擷取的可靠性，減少人工介入。
- [ ] 透過持續學習改善推薦，包括提出更有幫助的後續問題。

未來能否支援這些功能，取決於平台能力、存取權限與可行性。我們期待了解你正在使用哪些平台，以及希望顧問幫你做什麼——歡迎[開立 Issue](https://github.com/CatChen/curator-skills/issues)。

## 貢獻與授權條款

歡迎貢獻程式碼、文件及真實使用回饋。請參閱[貢獻指南](CONTRIBUTING.md)、[架構說明](docs/architecture.md)與[產品理念](docs/philosophy.md)。

[MIT 授權條款](LICENSE)。
