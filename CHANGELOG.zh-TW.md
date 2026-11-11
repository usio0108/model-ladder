# 變更紀錄

[English](CHANGELOG.md)

版本遵循 semantic versioning，Claude Code 更新需提升 `.claude-plugin/plugin.json` 的版本。

## [Unreleased]

- **Claude band 背景列**不再在工作仍在執行時一直被藏起來。回覆若表示在等背景結果，現在會重新顯示所有仍在執行的工作，不只限於當輪的問題。所以先前因回覆被誤判為最終答案而藏起來的工作會重新出現，例如背景測試所屬的問題先回覆「重跑完我會回報結果」，之後又回覆「跑完會收到通知」。等待關鍵字也加入了 `回報`、`回报`、`跑完` 與 `重跑`。

## [1.2.3] - 2026-11-10

- Codex HUD 現在能辨識 Windows Terminal 以 win32-input-mode 序列（`ESC [ Vk ; Sc ; Uc ; Kd ; Cs ; Rc _`，ConPTY 會啟用此模式）送出的 Ctrl+\ 與 Ctrl+]。先前這些按鍵無法比對原始 0x1c/0x1d 位元組，因而被轉給 Codex。現在按下與放開的序列都不會轉給 Codex，每次按下只觸發一次動作，被切在兩次讀取之間的序列會重組，其他輸入一律原樣轉送。

## [1.2.2] - 2026-11-10

- Codex SessionStart hook 加上 `statusMessage`（"Loading model-ladder..."），`/hooks` 不再顯示為 Unnamed hook。Windows 上也會以 `systemMessage` 告知使用者 `node-pty` 背景安裝狀態：安裝中時附上 `npm-ci.log` 路徑，就緒時每個外掛版本只顯示一次。
- Codex runner 在每個預估邊界改為先讀用量樣本、再取時間。原本樣本若晚 1 毫秒取得會被視為來自未來而捨棄，導致偶爾跳過用量風險確認。

## [1.2.1] - 2026-11-10

- PowerShell `codex` 函式不再寫死單一外掛版本資料夾：每次執行都挑已安裝的最新完整版本（含 `.codex-plugin/plugin.json`、`scripts/codex-hud.mjs`、`hooks/band/remaining.mjs`、`node_modules/node-pty`），沒有完整版本時執行原生 `codex`。修正更新後舊版快取被刪掉一部分而讓 `codex` 壞掉的問題。
- `plugin`、`review`、`update`、`doctor`、`queue`、`archive`、`delete`、`unarchive`、`migrate-rollouts`、`migrate-nfs-db`、`features`、`exec-server`、`remote-control`、`app`、`cloud`、`sandbox` 改為直接執行原生 `codex`，不再進入 HUD。

## [1.2.0] - 2026-11-10

Codex 在面板、用量交接、skills 與安全檢查上補齊到與 Claude Code 端一致。

- **Codex CLI HUD**：顯示外掛版本、目前用量與重置倒數、保護狀態、context（`ctx 52k/258k (20.2%)`），以及執行中 agent 的經過／預估時間，格式與 Claude band 相同（顯示 `12m`，不再是 `720s`）。按 Ctrl+\ 展開成所有 agent、skills 與用量保護（最多佔終端高度一半），再按一次收合回兩列。終端較窄時依序先省略 context、版本、按鍵提示，兩個用量百分比一定完整顯示。
- **Codex 用量交接**：信任 SessionStart hook 後，CLI HUD 會在每個已知用量視窗排入一次固定的交接指示；其他介面在 SessionStart 時收到提醒。Codex 新增 `handoff` skill，用量停止時會提示 session 撰寫 AI 交接；達到硬上限時仍保留程式產生的範本。
- **Codex worker skills 強制檢查**：worker 須逐項回報設定的能力，適用且可用卻未使用時，該次嘗試在驗證前即判失敗。此回報由模型自行聲明。
- **Codex router 安全檢查**：看起來是修改的任務被判成唯讀時，會在任何 worker 執行前以 `NEEDS_INPUT` 停下確認，不再誤報「沒改東西就成功」，也不會自行改成可寫入。任務中有明確的不修改指示（例如「別動任何檔案」、「不修改」、"do not modify"）時，即使含有修改字眼也維持唯讀。
- Codex 與 Claude 面板標題顯示各自封裝外掛的版本（`model-ladder (v1.2.0)`），窄版會先省略版本以保留用量；Claude band 改為依整列標題實際寬度判斷。
- Codex DIRECT 與 CLI HUD 只從 session ID 和 cwd 相符的 rollout 讀取 token 數。Codex agent 超過預估時間時，若 exec 事件流提供指令，會顯示最近的指令。
- 缺少 `node-pty` 時，HUD 改啟動一般 `codex`，且不再把 HUD 自己的環境變數傳下去。
- Codex 建立 worktree 遇到暫時性錯誤時會重試一次，再回報錯誤。
- **Worktree 清理**：所有移除 worktree 的地方（finish、run 修剪、Codex attempt）統一走同一個 helper：用 `--force --force` 移除被鎖住的 worktree、執行 prune，並刪除殘留的 `worktree-wf_*` 分支；先前 run 留下的分支也會一併清掉。因 Windows 檔案佔用而移除失敗時會短暫重試，仍失敗就留給下次 run 的修剪處理，不阻擋目前的 run。
- **Claude band 背景列**只顯示「所屬問題還沒結束」的任務。最終回答且不是在等某任務時，該問題的任務會隱藏（仍持續追蹤，結束通知照常移除並記錄 duration）；新問題不會隱藏舊問題的任務。限制：`turn.complete` 只給回覆文字，因此回覆為空、或提到等待、背景、通知（中英文關鍵字）就視為在等。
- README 補上 Codex 外掛的更新步驟：更新 marketplace、重新加入外掛、在 `/hooks` 重新信任已修改的 SessionStart hook、開新 session，`node-pty` 安裝完成後開新的 PowerShell 視窗。
- 已知限制：Codex 尚未追蹤背景工作，watcher 的交接仍須手動觸發。

## [1.1.5] - 2026-11-06

- Claude Code 的 usage guard 現在會自動交接：5 小時或 7 天用量視窗達到門檻時，Band 寫入交接模板並執行 `/model-ladder:handoff`，讓主 session 寫出 AI 版。每個視窗只觸發一次（重新載入或開新 session 也不重複），視窗降回門檻以下或重設後才會再觸發。沒有 ladder run 時也會交接，因為 handoff skill 依據對話內容撰寫。
- `handoff now` 現在真的會請主 session 寫 AI 版交接。原本使用 `$.prompt.submit`，但 Claude Code 會拒絕以 `/` 開頭的文字，因此只會顯示退回提示；現改用 `$.command.run`。
- Worker skill 指示改為強制檢查：設定 `worker_skills` 時，worker 須逐項回報指示中提到的能力（是否適用、是否可用、是否使用、說明）；適用且可用卻未使用時，該次嘗試在驗證前即判失敗（`worker skipped required skills: ...`）。不可用或不適用的能力不算失敗。finish 報告每次嘗試多一行 `Skills`。
- DIRECT 路徑下，主 session 現在會自行遵循 `worker_skills`，並把 `verifier_skills` 交給 verifier，與 Codex runner 一致。

## [1.1.4] - 2026-11-03

- Claude Code band 不再為 ladder 自己的 Workflow 啟動（`workflow: ladder`）顯示 `background` 列，使用者已經知道 model-ladder 正在選擇模型；其他非同步 Workflow 啟動仍會顯示。
- 在 subagent 裡發出的背景 Bash 或 Workflow（例如 verifier 在背景跑測試指令）不再新增背景列。它的 task-notification 只會送給該 subagent，主 session 收不到，所以以前任務結束後該列會一直留著。
- Claude Code 拒絕 worker 的隔離 worktree（"git could not be run to resolve it"，屬暫時性失敗）時，worker 或 test-writer 會用同一個 model 與 effort 重試一次，不再以 `stop_environment` 停掉整個 run。
- 清理時改用 `git worktree remove --force --force`，Claude Code 鎖住的 worktree 與其 `worktree-wf_*` 分支不再殘留。

## [1.1.3] - 2026-11-02

- 超時估計改用歷史資料：agent 列超過預期時長後，預期值改為至少 2 筆更長的過往紀錄的中位數（agentExpectations 現在也回傳原始樣本），否則顯示階梯式估計並在前面加 `~`（例如 `12m/~14m`），Claude Code band 與 Codex 面板皆適用；Claude Code band 中超時的 agent 列會以目前的工具活動（例如 `Bash: Run unit tests`）取代任務文字，讀不到時退回任務文字。
- Windows 上的 Codex：SessionStart hook 會在 PowerShell profile 加入有標記的 `codex` 函式，在新的 PowerShell 視窗輸入 `codex` 就會開啟 model-ladder HUD；子指令、輸入輸出被導向、缺少 `node-pty` 或 Node.js 時執行原生 `codex.exe`，`node-pty` 會在背景安裝，設定 `"hudTakeover": false` 即可移除該函式。`node-pty` 無法載入時 HUD 也會改用一般 Codex。
- band 用量列的百分比不再使用粗體，並改用固定顏色（50% 到用量保護門檻為黃色，達到或超過門檻為紅色），因為部分介面不會套用主題色。
- 背景列也涵蓋主 session 在背景啟動的 subagent（Agent 工具的 run_in_background）：Claude 閒置時顯示 `agent: <描述>` 列，該 agent 結束後移除。
- 背景任務被 TaskStop 停止時（不會送出 task-notification），其背景列也會移除，不再殘留在 band 上。
- 背景 shell 列在同一指令（以第一行為準）曾經跑完後會顯示預期時長：取最近十次的中位數，跨 session 保留，超時時與 agent 列一樣重新估計；第一次執行只顯示經過時間。
- Claude Code band 與 Codex 面板的時間欄標題由 `time` 改為 `act./est.`（實際經過 / 預估）。
- Claude Code 的 verifier 與 diagnose 列現在也會顯示預期時長：它們的 prompt 沒有 TASK 行，且每個 ladder 步驟各是一次 workflow run，因此 band 對不到任務時改用唯一進行中的 ladder 鎖（同時有兩個以上的 run 時仍只顯示經過時間）。

## [1.1.2] - 2026-11-02

- Worker 新增編輯規則（僅用 Edit/Write 或 apply_patch、`uv run` 並清理、回報前檢查 `git status`）；band 檔案變更時 router 會建議 verify 包含 `claude plugin test .`。
- Claude Code verifier 現在回傳 `workerFiles`（`git status` 中 worker 自己的未暫存與未追蹤路徑），有 verify 指令時須指令成功且每項 ACCEPTANCE 都達成才通過；通過但 `workerFiles` 為空的判定會改為失敗（`worker changed nothing`），讓 ladder 升級。
- Claude Code band 與 Codex 面板中，執行中的 agent 列的經過時間達到預期時長後，會顯示重新估計的預期時長（預期值加上整數個步長，步長為 1 分鐘與預期值一半中較大者，直到超過經過時間，例如預期 7m 顯示 12m/14m）；已結束的列保留原本的預期時長。
- Claude Code band 以背景列取代依鎖產生的 `no model` 列：本 session 每個進行中的 Bash 背景工作或非同步 Workflow 啟動各顯示一列 `background`（經過時間與 `<kind>: <label>`），只在 Claude 沒有執行回合且沒有 ladder agent 執行時顯示，收到該工作的通知後移除。`direct` 階段與 `phase.mjs <runId> direct` 步驟一併移除。
- 只有 worker、test-writer、verifier 的列顯示預期時長；router、diagnose、final diagnosis 的列只顯示經過時間。
- router 另外回傳 `workerMinutes` 與 `verifyMinutes`（單次 worker 嘗試與單次驗證的正整數實際分鐘數）。plan 會把它們寫入 run 鎖的各 agent 表，作為歷史沒有樣本的階段的預期值，讓 worker 與 verifier 列從第一次 run 起就有預期時長。歷史樣本（階段加模型/effort，其次依階段）仍然優先。
- Codex router 也會回傳 `workerMinutes` 與 `verifyMinutes`（正整數，schema 會檢查）；路由後只在歷史沒有 worker 或 verify 樣本時補進 Codex 面板的各 agent 預期表，讓第一次 Codex run 的 worker 與 verifier 列就顯示「已跑 / 預估」。
- band 用量列的百分比改為粗體並依程度上色：低於 50% 維持一般顏色，50% 到用量保護門檻為警告色，達到或超過門檻為錯誤色；其餘文字維持淡色。指示列的摺疊箭頭後面多留一格空白。

## [1.1.1] - 2026-11-02

- Claude Code band 與 Codex 面板中每個 agent 列（router、worker、test-writer、verifier）的時間欄，改為顯示「該 agent 自己的經過時間 / 自己的預期時長」，不再以整個 run 的預估總時長為分母。預期時長取自先前可比較成功 run 的階段計時中位數：有兩筆樣本時依「階段加模型/effort」，之前只依階段；沒有樣本時只顯示經過時間。
- 執行中的列即時讀取預期時長，spawn 時 run 還沒有預估也不會缺漏。`no model` 列維持顯示 run 經過時間與 run 預估總時長。

## [1.1.0] - 2026-10-30

- 耗時預估：耗時範圍、階段計時與各用量時間窗的餘額評估記錄於 live、result、history JSON，並以可比較的成功紀錄校準；移除拆分詢問。
- Claude Code band 與 Codex 面板的時間欄顯示「經過/預估」（例如 `5s/12m`），沒有預估時只顯示經過時間。
- 開跑預估顯示某個用量時間窗不足或有風險時，Claude Code 與 Codex 會在 worker 開始前詢問一次（`acceptUsageRisk: true` 為繼續）；用量保護照常生效。
- 主 session 在 agent 之間持有 run 時（preflight、詢問、finish），Claude Code band 顯示 `no model` 列，不再顯示 `idle`。
- band 將 `.model-ladder` 狀態寫到 repo 根目錄，不再寫到 shell 目前所在的子資料夾。
- Codex 用量保護在角色執行期間可讀到即時用量；即使 stderr 有 sandbox 警告，Codex 用量上限錯誤也會寫出 `HANDOFF.md`。
- 像 `use ponytail:ponytail` 這類含冒號的行維持全域；只有 `專案名稱: ` 前綴才會限定角色指示。

## [1.0.3] - 2026-10-30

- 支援 `專案名稱: 指示` 限定角色指示，無前綴的行維持全域適用。
- Band 只顯示適用指示，移除 `skill instructions:` 標籤，並提供可收合的單行預覽。
- Claude Code、Codex 與 linked worktree 使用相同專案比對規則。

## [1.0.2] - 2026-10-30

- 精簡外掛設定註解，並在 Band 選項補上 context window 說明。
- 在第一個設定標籤顯示安裝版本。
- 同步精簡雙語 README、進階使用、設計說明與版本紀錄。
- 更新 Band 範例，將詳細操作與設定參考移至進階文件。
- 移除不可靠的效能比較與過期測試成果宣稱，保留第三方授權原文。

## [1.0.1] - 2026-10-30

- Codex DIRECT 使用呼叫端實測 context 與隔離草稿，通過獨立驗證後才套用。
- Codex 選用 commit 保留無關 staged 變更，跳過含既有或並行修改的檔案。
- Codex SessionStart 遵循個人與專案的 autorun、panel 設定，兩端 test-writer 規則一致。
- 額度交接使用各 run 的 live 狀態，偵測到用量停止時終止其他已註冊 runner 程序樹並寫 `HANDOFF.md`。
- Codex 在 agent 與驗證命令執行中每 2 秒檢查用量。
- 可辨識的純上限訊息視為 `USAGE_LIMIT`。
- Windows 程序樹停止失敗時保留註冊並回報錯誤，不產生錯誤的已停止交接。
- 同步兩端技能與雙語文件，涵蓋 DIRECT、commit、拆分與平台限制。

## [1.0.0] - 2026-10-29

第一個公開版本，包含先前開發歷史。

- 為 Claude Code 與 Codex 任務選模型、隔離嘗試、獨立驗證，失敗時升級。
- Claude 小任務達 `direct_threshold` 時可用 DIRECT，仍須獨立驗證。
- 超過 `split_minutes` 時可選依序分段、整體執行或停止。
- 範圍不重疊的 run 可並行，結果依序套用。
- 用量停止時保留工作並寫 `.model-ladder/HANDOFF.md`，也可用 `/model-ladder:handoff` 手動產生。
- `worker_skills`、`verifier_skills` 選用角色可用能力，缺少時回報。
- 設定依序採用預設值、個人檔（`~/.claude/model-ladder.json` 或 `~/.codex/model-ladder.json`）與專案覆寫。
- Claude Band 顯示角色、用量與 context，Codex HUD 在同一終端顯示狀態。
- Codex 產物放系統 temp，Git 自動排除 `.model-ladder/`、`.claude/worktrees/`。
- 本機驗證只跑相關測試，完整套件由 CI 執行。
- 缺少 Node.js 20+ 時，hooks 顯示安裝需求。
