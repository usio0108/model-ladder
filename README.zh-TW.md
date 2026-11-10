<div align="center">

# model-ladder

**為每項任務挑選合適的模型，完成後驗證，通過才交付。**

[![Claude Code plugin](https://img.shields.io/badge/Claude%20Code-plugin-D97757?logo=claude&logoColor=white)](https://code.claude.com/docs/en/plugins)
[![Codex plugin](https://img.shields.io/badge/Codex-plugin-412991?logo=openai&logoColor=white)](README.zh-TW.md#安裝)
[![release](https://img.shields.io/github/v/release/usio0108/model-ladder?label=release&color=blue)](CHANGELOG.zh-TW.md)
[![license: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)

[English](README.md) · [安裝](#安裝) · [使用方式](#使用方式) · [設定](#設定) · [Band](#bandclaude-code) · [使用量保護](#使用量保護) · [設計](DESIGN.zh-TW.md)

</div>

---

## 功能

model-ladder 是 [Claude Code](https://code.claude.com) 與 Codex 的外掛。Router 會為每項任務挑選合適的模型，Worker 負責執行，Verifier 檢查結果。通過驗證的變更才會交付。

- **隔離的 Git worktree**：每次嘗試各自在獨立 worktree 中執行。
- **適時升級**：驗證失敗時，可能改用更強的模型或提高 effort。
- **小任務 DIRECT**：實際 session context 達到設定門檻時，由主 session 處理小任務，完成後仍須獨立驗證。
- **預估資訊**：每個 agent 列的時間欄顯示該 agent 自己的「經過/預期時長」（例如 `5s/12m`；執行中的 agent 超過預期後，預期時長會分段重新估計，已結束的列保留原值，僅 worker、test-writer、verifier 列；來自先前成功的 run，尚無歷史時採用 router 給的單次分鐘數；router、diagnose、final diagnosis 列只顯示經過時間）；開跑時若預估某個用量時間窗不足或有風險，會在 worker 開始前詢問一次；大型任務不再要求拆分確認。
- **使用量保護**：偵測到用量停止條件時結束目前 run 並強制停止同機其他已註冊 run。
- **交接文件**：用量停止或執行 `/model-ladder:handoff` 時建立 `.model-ladder/HANDOFF.md`，由主 session 根據對話改寫，並保留程式產生的驗證附錄。
- **Band / panel / HUD**：透過 Claude band 或 Codex 終端顯示查看角色、用量與保護控制；CLI HUD 能識別 session 時也會顯示 context。
- **自訂角色指示**：`worker_skills` 與 `verifier_skills` 可指定角色權限內可用的 skills 與工具，Claude Router 則僅能使用 Read、Grep、Glob。
- **Codex 逾時續跑**：含 checkpoint 的 `TIMEOUT` 結果可用 `resumeRun` 延續草稿，通過驗證後才套用。

## 安裝

需要 Git 與 Node.js 20 以上（外掛不會自動安裝 Node.js）。請在至少有一個 commit 的 Git repo 中使用；Codex 需先在 `/hooks` 信任外掛 hooks。

更新 Codex 外掛的步驟：

1. 執行 `codex plugin marketplace upgrade model-ladder`，再執行 `codex plugin add model-ladder@model-ladder` 取得並安裝新版。
2. 在 Codex CLI 開啟 `/hooks`。若 model-ladder 的 SessionStart hook 顯示已修改，請檢閱並重新信任。信任前 Codex 會略過它，無法自動設定 panel／HUD 或載入 autorun 指示。
3. 開啟新的 Codex session。hook 會自動把 PowerShell profile 中的 `codex` 函式改指向新版本。
4. Windows 上新版本第一次啟動時，node-pty 會在背景安裝，因此該次可能是一般 `codex`。之後開新的 PowerShell 視窗輸入 `codex`，即可進入新版 HUD。

請先安裝並登入 Claude Code。若要使用自動化，請確認 Workflow 工具可用。Pro 方案請在安裝外掛前到 `/config` 啟用 Workflow。

```text
# Claude Code
/plugin marketplace add usio0108/model-ladder
/plugin install model-ladder@model-ladder
```

```sh
claude plugin marketplace add usio0108/model-ladder
claude plugin install model-ladder@model-ladder

# Codex CLI 0.160.1+（之後請重新啟動 Codex；需要已登入的原生 `codex`）
codex plugin marketplace add usio0108/model-ladder
codex plugin add model-ladder@model-ladder
```

安裝後重開 Claude Code 即生效，之後的頂層任務會自動走 `/model-ladder:run`。第一次執行時若詢問是否允許 Workflow，選「不再詢問」即可。model-ladder 會自行把 `.model-ladder/` 與 `.claude/worktrees/` 排除在 git 之外（寫入 `.git/info/exclude`），不必手動改 `.gitignore`。更新：`claude plugin update model-ladder@model-ladder`（marketplace 開啟自動更新時會自動進行）。報告會提示新版本，見 [CHANGELOG.zh-TW.md](CHANGELOG.zh-TW.md)。

## 使用方式

1. **平常使用**：在 Git repo 中直接描述任務，預設會自動使用 ladder。
2. **手動啟動**：Claude Code 使用 `/model-ladder:run <任務>`，Codex 則請 agent 使用 `model-ladder` skill。
3. **描述任務**：說明目標與預期結果，需要修改測試或只審查不修改時明確提出。
4. **略過或強制使用**：說「no ladder」可略過，Claude 指令加上 `--ladder` 可強制使用。
5. **回應詢問**：確認是否處理未提交變更、補充不清楚的任務，並在拆分建議出現時選擇分段、整體執行或停止。
6. **查看結果**：通過驗證才算完成，報告會列出修改檔案、驗證結果與剩餘限制，預設不 commit 或 push。
7. **交接與續跑**：需要時可要求建立交接文件，遇到用量停止則等額度重設，再依 `.model-ladder/HANDOFF.md` 續跑。
8. **建立專案驗證流程**：model-ladder 內建源自 pstack 的 [`create-verification-skill`](skills/create-verification-skill/SKILL.md) 與 [`maintain-verification-skill`](skills/maintain-verification-skill/SKILL.md)，Codex plugin 也附有[對應版本](codex-skills/)。在 Claude Code 執行 `/model-ladder:create-verification-skill` 或 `/model-ladder:maintain-verification-skill`；在 Codex 請它使用 `create-verification-skill` 或 `maintain-verification-skill` skill。這些 skill 會為目標專案建立或維護專屬驗證 driver。本 repository 已有自己的 [`.agents/skills/verify/SKILL.md`](.agents/skills/verify/SKILL.md)，用途是驗證 model-ladder，不是替任意專案建立通用 driver。來源與授權請見[第三方 notice](NOTICE.zh-TW.md)。

報告範例、runner 指令、並行執行與執行檔案位置見[進階使用](USAGE.zh-TW.md)，panel 操作見 [Band](#bandclaude-code)。

## 設定

不需建立設定檔，使用預設值即可執行。

Claude Code 開啟 `/plugin configure model-ladder`；Codex 編輯 `~/.codex/model-ladder.json`。
Claude 若需在外掛介面以外設定，使用 `~/.claude/model-ladder.json`。

| 設定 | 預設值 | 用途 |
|---|---|---|
| `autoRun` | `true` | 預設使用 ladder。 |
| `band` | `true` | 顯示 Band 或 panel。 |
| `worker_skills`（**Worker skill instructions**） | 空白 | 指定 worker 與 test-writer 使用的 skills 或工具。worker 須逐項回報指示中的能力；適用且可用卻未使用時，該次嘗試判為失敗。 |
| `verifier_skills`（**Verifier skill instructions**） | 空白 | 指定驗證時使用的 skills 或工具。 |
| `direct_threshold` | `30` | 小任務使用 DIRECT 的 context 百分比門檻，`off` 停用。 |
| `usageGuard` | 開啟、`90%` | 達到設定的用量門檻時停止。 |

專案的 `.claude/model-ladder.json` 或 `.codex/model-ladder.json` 優先於個人設定，使用量保護建議放個人檔，除非專案需要覆寫。

角色指示每行一條，`專案名稱: 指示` 只套用主 repo 資料夾名稱完全一致的專案，沒有 `專案名稱: ` 前綴則全域適用。

```json
{
  "worker_skills": "model-ladder: 寫程式時使用 <skills> 簡化程式碼。",
  "verifier_skills": "model-ladder: 使用 <skills> 審查，不修改檔案。"
}
```

模型、重試、驗證、保護檔案與環境變數見[進階設定](USAGE.zh-TW.md#進階設定)，DIRECT、commit 與逾時續跑見 [Codex 執行流程](USAGE.zh-TW.md#codex-direct提交與續跑)。

## Band（Claude Code）

Band 顯示在 Claude Code 的 prompt 上方，需要 Claude Code 2.1.290+。

```text
▴ 🟢 model-ladder ── 2h/5h 15% · 3d/7d 44% · ctx 287k/1M (28.7%)
▸ worker use ponytail when coding
model/effort        act./est.  task
haiku-5.5/low       5s         Summarize the README install steps
[usage guard: on]  threshold [90] %  [handoff now]
```

| 顯示或控制 | 說明 |
|---|---|
| 使用量 | 各額度視窗顯示重設倒數、視窗長度與使用百分比。 |
| Context | `ctx 287k/1M (28.7%)` 顯示已用 token、視窗上限與百分比，token 未知時只顯示上限。 |
| 狀態 | 🟢 worker 或 router、🔵 verifier、🔴 重試中的 worker，任務列的 `✓` 表示已結束。 |
| 任務列 | 顯示模型、effort、耗時（worker、test-writer、verifier 列另外顯示「/」與自己的預期時長，來自歷史或 router 給的分鐘數；其他列只顯示耗時）與任務；本 session 主迴圈發出的每個進行中 Bash 背景工作或非同步 Workflow 啟動（不含 ladder 自己的 Workflow 與 subagent 發出的呼叫）各有一列 `background`（耗時與任務 `<kind>: <label>`），只在 Claude 沒有執行回合且沒有 ladder agent 執行時出現。 |
| `▴` / `▾` | 收合或展開 Band。 |
| 指示箭頭 | 只顯示生效指示且不加 `skill instructions:` 前綴，預設收成一行，以 `▸` 展開、`▾` 收合。 |
| `usage guard` | 開關使用量保護。任一用量視窗達到門檻時，Band 會自動交接一次（同 `handoff now`），該視窗降回門檻以下或重設後才會再次交接。 |
| `threshold` | 設定 1–100% 門檻，按 Enter 或停止輸入 5 秒後儲存。 |
| `handoff now` | 寫入交接模板並執行 `/model-ladder:handoff`，讓主 session 改寫，不取消目前 run。 |

保護控制寫入個人設定，專案若有覆寫仍以專案設定為準。

Codex 使用獨立 terminal panel 且不顯示 context，輸入 `g` 切換保護、`t 90` 設門檻、`h` 寫交接模板、`q` 關閉 panel，每項指令後按 Enter。

交接備案、設定行為與疑難排解見 [Band 與 panel 詳細說明](USAGE.zh-TW.md#band-與-panel-詳細說明)。

## 使用量保護

- 預設開啟，5 小時或每週用量門檻為 90%。
- 使用 Band 控制項，或 Codex panel 的 `g`、`t 90` 調整保護設定。
- 偵測到用量停止條件時回報 `USAGE_LIMIT`，並強制停止同機其他已註冊的 model-ladder run。
- 保留成果與續跑方式見 `.model-ladder/HANDOFF.md`，等額度重設後再繼續。
- 額度硬上限不受保護開關影響，未知用量則不阻擋執行。

檢查時機、交接行為與平台限制見[使用量保護細節](USAGE.zh-TW.md#使用量保護細節)。

---

設計與經驗：[DESIGN.zh-TW.md](DESIGN.zh-TW.md)。[MIT License](LICENSE)，(c) 2026 usio0108。問題請[建立 issue](https://github.com/usio0108/model-ladder/issues)。
