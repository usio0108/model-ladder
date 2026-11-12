<div align="center">

# 🪜 model-ladder

**為每項任務挑選合適的模型，完成後驗證，通過才交付。**

[![Claude Code plugin](https://img.shields.io/badge/Claude%20Code-plugin-D97757?logo=claude&logoColor=white)](https://code.claude.com/docs/en/plugins)
[![Codex plugin](https://img.shields.io/badge/Codex-plugin-412991?logo=openai&logoColor=white)](README.zh-TW.md#安裝)
[![release](https://img.shields.io/github/v/release/usio0108/model-ladder?label=release&color=blue)](CHANGELOG.zh-TW.md)
[![license: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)

[English](README.md) · [安裝](#安裝) · [使用方式](#使用方式) · [設定](#設定) · [Band](#bandclaude-code) · [使用量保護](#使用量保護) · [設計](DESIGN.zh-TW.md)

</div>

---

## 簡介

model-ladder 是 [Claude Code](https://code.claude.com) 與 Codex 的外掛。Router 會為每項任務挑選合適的模型，Worker 負責執行，Verifier 檢查結果。通過驗證的變更才會交付。

## 功能

- **隔離的 Git worktree**：每次嘗試各自在獨立 worktree 中執行。
- **適時升級**：驗證失敗時，可能改用更強的模型或提高 effort。
- **小任務 DIRECT**：實際 session context 達到設定門檻時，由主 session 處理小任務，完成後仍須獨立驗證。
- **預估資訊**：每個 agent 列的時間欄顯示該 agent 自己的「經過/預期時長」（例如 `5s/12m`；執行中的 agent 超過預期後，預期時長會分段重新估計，已結束的列保留原值，僅 worker、test-writer、verifier 列；來自先前成功的 run，尚無歷史時採用 router 給的單次分鐘數；router、diagnose、final diagnosis 列只顯示經過時間）；開跑時若預估某個用量時間窗不足或有風險，會在 worker 開始前詢問一次。
- **並行執行**：檔案範圍不重疊的 run 可同時進行，並有重疊檢查與序列化套用結果。
- **自動路由與分層設定**：session hook 預設啟用 ladder，並支援個人設定與專案覆寫。
- **受保護的測試**：除非任務明確要求修改測試，worker 不得修改測試。
- **使用量保護**：偵測到用量停止條件時結束目前 run 並強制停止同機其他已註冊 run，Codex 執行期間每 2 秒檢查一次。
- **交接文件**：用量停止或執行 `/model-ladder:handoff` 時建立 `.model-ladder/HANDOFF.md`，由主 session 根據對話改寫，並保留程式產生的驗證附錄。
- **Band / panel / HUD**：透過 Claude band 或 Codex 終端顯示查看角色、用量與保護控制；CLI HUD 能識別 session 時也會顯示 context。
- **自訂角色指示**：`worker_skills` 與 `verifier_skills` 可指定角色權限內可用的 skills 與工具，Claude Router 則僅能使用 Read、Grep、Glob。
- **Codex 逾時續跑**：含 checkpoint 的 `TIMEOUT` 結果可用 `resumeRun` 延續草稿，通過驗證後才套用。
- **選用的 Codex commit**：`commit: true` 會提交已驗證的檔案，保留無關的 staged 變更，並跳過含既有或並行修改的檔案。

## 安裝

請先確認[需求](#需求與相容性)，並在至少有一個 commit 的 Git repo 中使用。

更新 Codex 外掛的步驟：

1. 執行 `codex plugin marketplace upgrade model-ladder`，再執行 `codex plugin add model-ladder@model-ladder` 取得並安裝新版。
2. 在 Codex CLI 開啟 `/hooks`。若 model-ladder 的 SessionStart hook 顯示已修改，請檢閱並重新信任。信任前 Codex 會略過它，無法自動設定 panel／HUD 或載入 autorun 指示。
3. 開啟新的 Codex session。hook 會自動把 PowerShell profile 中的 `codex` 函式改指向新版本。
4. Windows 上新版本第一次啟動時，node-pty 會在背景安裝，因此該次可能是一般 `codex`。之後開新的 PowerShell 視窗輸入 `codex`，即可進入新版 HUD。

請先安裝並登入 Claude Code。

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

安裝後重開 Claude Code 即生效，之後的頂層任務會自動走 `/model-ladder:run`。第一次執行時若詢問是否允許 Workflow，選「不再詢問」即可。更新：`claude plugin update model-ladder@model-ladder`（marketplace 開啟自動更新時會自動進行）。報告會提示新版本，見 [CHANGELOG.zh-TW.md](CHANGELOG.zh-TW.md)。

## 需求與相容性

| 項目 | 最低需求 | 測試狀態 |
|---|---|---|
| Claude Code | 需支援外掛與 Workflow 工具；band 需要 2.1.290+ | 以 Claude Code 開發；CI 沒有版本矩陣。Pro 方案請先到 `/config` 啟用 Workflow |
| Codex CLI | 0.160.1+，需要已登入的原生 `codex`；先在 `/hooks` 信任外掛 hooks | 以 Codex 開發；CI 沒有版本矩陣 |
| Node.js | 20（外掛不會自動安裝） | CI 單元測試涵蓋 20 與 22 |
| Git | 近期版本即可；repo 至少要有一個 commit | CI 有使用，未固定最低版本 |
| Windows | Codex HUD 需要原生 `codex.exe` | CI 單元測試涵蓋 `windows-latest`；主要開發平台 |
| Linux | | CI 單元測試涵蓋 `ubuntu-latest` |
| macOS | | 未測（不在 CI 矩陣內） |

出處：[`.github/workflows/test.yml`](.github/workflows/test.yml)（ubuntu-latest 與 windows-latest，Node 20 與 22）及上述版本說明。CI 只跑單元測試，不會執行 Claude Code 或 Codex。

## 它會動到什麼、什麼會離開你的電腦，以及如何關閉

| 項目 | 說明 | 如何關閉 |
|---|---|---|
| 每日更新檢查 | 每天最多一次，向 `raw.githubusercontent.com` 取得 `.claude-plugin/plugin.json`（逾時 3 秒，失敗時靜默），結果快取在系統暫存目錄的 `model-ladder-update-check.json`，有新版時報告會提示。不會傳送 repo 資料。 | 設定 `MODEL_LADDER_NO_UPDATE_CHECK=1` |
| `.git/info/exclude` | 把 `.model-ladder/` 與 `.claude/worktrees/` 附加進去（支援 worktree），不必改 `.gitignore`，也不會改動你已追蹤的檔案。 | 刪除這兩行 |
| PowerShell profile（僅 Windows、Codex） | Codex SessionStart hook 會在 PowerShell 7 與 Windows PowerShell 的 profile 加入一段有標記的 `function codex`，讓 `codex` 在 HUD 中執行；HUD 無法執行時會退回原生 `codex.exe`。 | 在 `~/.codex/model-ladder.json` 設定 `"hudTakeover": false`（`band: false` 同樣有效），下次 Codex session 啟動時會移除該區塊；手動移除請見[解除安裝](#解除安裝) |
| `.model-ladder/` | 內含 `runs/`（run 鎖）、`history.jsonl`、`live.json`、`usage.json`、`context.json` 與 `HANDOFF.md`。Codex 每次 run 的 worktree、log 與 checkpoint 放在系統暫存目錄的 `model-ladder/<repo hash>/`。 | 刪除這些目錄（見[解除安裝](#解除安裝)） |
| 模型呼叫與額度 | 一項任務可能有 router、worker、verifier，失敗後還會升級重跑 worker 與 verifier，因此比直接做更耗 Claude 或 Codex 額度。任務內容與程式碼會像一般使用 Claude Code 或 Codex 一樣送到模型。 | 單次任務說「no ladder」，或關閉 `autoRun` |
| 使用量保護 | 達到設定門檻（預設 90%）時，用量停止會結束目前 run，並強制停止同機其他已註冊的 model-ladder run。 | 在 band 或 panel 關閉 `usageGuard`；硬性額度上限仍會停止 run |
| `autoRun` | 預設開啟：頂層任務自動走 ladder。 | 將 `autoRun` 設為 `false`（Claude：`/plugin configure model-ladder`；Codex：`~/.codex/model-ladder.json`），或設定 `MODEL_LADDER_AUTORUN=0` |

## 解除安裝

1. 移除外掛：

   ```sh
   claude plugin uninstall model-ladder@model-ladder
   codex plugin remove model-ladder@model-ladder
   ```

   也可另外執行 `claude plugin marketplace remove model-ladder` 與 `codex plugin marketplace remove model-ladder`。
2. 移除 PowerShell profile 區塊（Windows、Codex）：先設定 `"hudTakeover": false` 並開啟一次 Codex session，讓 hook 自動移除；或手動編輯 `Documents\PowerShell\profile.ps1` 與 `Documents\WindowsPowerShell\profile.ps1`，刪除從 `# >>> model-ladder codex HUD >>>` 到 `# <<< model-ladder codex HUD <<<` 的整段，其餘內容不要動。
3. 在每個用過的 repo 中刪除 `.model-ladder/` 與 `.claude/worktrees/`，也可一併刪除 `.git/info/exclude` 中對應的兩行。
4. 清理殘留的 Git worktree：`git worktree list`，對 model-ladder 的 attempt 執行 `git worktree remove --force <路徑>`，最後執行 `git worktree prune`。
5. 刪除系統暫存目錄下的 `model-ladder/<repo hash>/`（以及 `model-ladder-update-check.json`）。

## Beta 狀態與已知限制

model-ladder 目前為 **Beta**：行為、設定與檔案結構可能隨版本調整（見 [CHANGELOG.zh-TW.md](CHANGELOG.zh-TW.md)）。已知限制：

- Windows 上停止 run 時以 `taskkill` 終止整個程序樹；若 Windows 拒絕，run 會回報失敗並保留登記，不會宣稱已停止（[USAGE.zh-TW.md](USAGE.zh-TW.md#使用量保護細節)）。被強制終止的 run 可能沒有 checkpoint 或 `result.json`，需重新執行原任務（[USAGE.zh-TW.md](USAGE.zh-TW.md#使用量保護細節)）。
- 獨立的 Codex 終端 panel 不顯示 context 用量（[Band](#bandclaude-code)）。
- Pro 方案須先在 `/config` 啟用 Workflow 再安裝外掛，否則無法使用自動化。
- Windows 需要原生 `codex.exe`（透過 PATH 或 `CODEX_BINARY`），不支援 `.cmd` 或 `.bat` shim（[USAGE.zh-TW.md](USAGE.zh-TW.md#codex-runner-與-hud)、`scripts/codex-hud.mjs`）。
- Codex HUD 必須由它啟動 Codex，無法接入執行中的 session，且自動設定 PowerShell 僅限 Windows（[USAGE.zh-TW.md](USAGE.zh-TW.md#codex-runner-與-hud)）。
- Claude 用量讀數僅 Pro/Max 方案提供；用量未知時保護不會阻擋執行（[USAGE.zh-TW.md](USAGE.zh-TW.md#使用量保護細節)）。
- macOS 未測（見上表）。
- Codex 的 worker 與 verifier 沒有網路，它們的 worktree 也沒有 `.venv` 或 `node_modules`。uv 專案會以唯讀方式借用主 checkout 的 `.venv`，所以需要先在主 checkout 跑 `uv sync`；需要 `node_modules` 的 Node 專案檢查會回報為未執行（[USAGE.zh-TW.md](USAGE.zh-TW.md#codex-sandboxuv-與-node-專案)）。

## 使用方式

1. **平常使用**：在 Git repo 中直接描述任務，預設會自動使用 ladder。
2. **手動啟動**：Claude Code 使用 `/model-ladder:run <任務>`，Codex 則請 agent 使用 `model-ladder` skill。
3. **描述任務**：說明目標與預期結果，需要修改測試或只審查不修改時明確提出。
4. **略過或強制使用**：說「no ladder」可略過，Claude 指令加上 `--ladder` 可強制使用。
5. **回應詢問**：確認是否處理未提交變更、補充不清楚的任務，並在用量預估警告時間窗可能不足時選擇繼續或停止。
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

交接備案與設定行為見 [Band 與 panel 詳細說明](USAGE.zh-TW.md#band-與-panel-詳細說明)，疑難排解見[疑難排解](USAGE.zh-TW.md#疑難排解)。

## 使用量保護

- 預設開啟，5 小時或每週用量門檻為 90%。
- 使用 Band 控制項，或 Codex panel 的 `g`、`t 90` 調整保護設定。
- 偵測到用量停止條件時回報 `USAGE_LIMIT`，並強制停止同機其他已註冊的 model-ladder run。
- 保留成果與續跑方式見 `.model-ladder/HANDOFF.md`，等額度重設後再繼續。
- 額度硬上限不受保護開關影響，未知用量則不阻擋執行。

檢查時機、交接行為與平台限制見[使用量保護細節](USAGE.zh-TW.md#使用量保護細節)。

---

設計與經驗：[DESIGN.zh-TW.md](DESIGN.zh-TW.md)。[MIT License](LICENSE)，(c) 2026 usio0108。問題請[建立 issue](https://github.com/usio0108/model-ladder/issues)。
