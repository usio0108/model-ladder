# 變更紀錄

[English](CHANGELOG.md)

版本遵循 semantic versioning，Claude Code 更新需提升 `.claude-plugin/plugin.json` 的版本。

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
