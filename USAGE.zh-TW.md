# 進階使用

[README](README.zh-TW.md#使用方式) · [English](USAGE.md) · [設計](DESIGN.zh-TW.md)

## 執行報告

報告會用 session 的語言整理任務、嘗試、修改檔案、驗證與剩餘限制。

| 結果 | 意義 |
|---|---|
| `VERIFIED` | 驗證通過，修改任務會套用已驗證的變更。 |
| `DIRECT` | 草稿尚未驗證，需由呼叫端處理後交回獨立驗證。 |
| `DIRTY` | 確認是否以既有未提交變更為基礎執行。 |
| `NEEDS_INPUT` | 補充任務、確認驗收條件、回答用量風險詢問或處理重疊。 |
| `STALE_RUN` | 檢查鎖與程序，確認後再授權清理。 |
| `CONFLICT` | 無法套用 patch，檢查保留的 patch 與 worktree。 |
| `STOPPED` / `FAILED` / `ERROR` | 依回報原因處理阻礙，再決定是否重跑。 |

Claude 用量停止回傳 `USAGE_LIMIT`；Codex 回傳 `STOPPED` 與 `errorCode: "USAGE_LIMIT"`。
執行歷史存於 `.model-ladder/history.jsonl`。

沒有既有驗證命令或 skill 時，提供明確驗收條件，或使用 `create-verification-skill` 與 `maintain-verification-skill`。
Claude 產生 `.claude/skills/verify/`；Codex 產生 `.agents/skills/verify/`，也接受 Claude 路徑。
這些技能改編自 pstack，採 MIT 授權，見 [NOTICE.zh-TW.md](NOTICE.zh-TW.md)。

## Codex runner 與 HUD

| 目的 | 指令 |
|---|---|
| 執行任務 | `node scripts/codex-run.mjs "<task>"` |
| 傳入 JSON | `node scripts/codex-run.mjs --input <file>` |
| 開啟 panel | `node scripts/watch.mjs --cwd <repo>` |
| 啟動 CLI HUD | `npm ci`，再執行 `node scripts/codex-hud.mjs --cwd <repo>`。 |
| 用 HUD 接續 session | 在 HUD 指令後加上 `-- resume`。 |

只有 `VERIFIED` 的 exit code 為 0；`DIRECT`、`DIRTY`、`NEEDS_INPUT`、`STALE_RUN` 為 2，其餘為 1。
也可從 stdin 傳入 JSON；Windows 請使用系統 temp 目錄內的 UTF-8 輸入檔。

Panel 可跨任務重用，無法顯示終端時改看 tool output 的進度。
HUD 必須先啟動 Codex，不能附加到已開啟的 session。Windows 上由 Codex 的 SessionStart hook 自動設定：在 PowerShell profile（PowerShell 7 與 Windows PowerShell）加入有標記的 `codex` 函式，之後開新的 PowerShell 視窗輸入 `codex` 就會進入 HUD。函式每次執行都會自動使用已安裝的最新完整外掛版本，`plugin`、`review`、`update` 等管理子指令直接執行原生 `codex.exe`。`exec`、`login` 等子指令、輸入或輸出被導向、缺少 `node-pty` 或 Node.js 時，直接執行原生 `codex.exe`；`node-pty` 第一次會在背景安裝，SessionStart 會顯示安裝中或已就緒。在 `~/.codex/model-ladder.json` 設定 `"hudTakeover": false` 即可移除該函式。

在 CLI HUD 按 Ctrl+]（或 Alt+H；注音等輸入法會把 Ctrl+] 變成 】，Alt+H 不受影響），若有 run 資料就會寫入交接模板，並提示以 `$handoff` 補上對話內容。HUD 預設佔用終端兩列；按 Ctrl+\ 可展開顯示所有 agent、skills 與用量守門（最多佔終端高度一半），再按一次收合。
Windows 需使用 PATH 或 `CODEX_BINARY` 指定的原生 `codex.exe`，不接受 `.cmd`、`.bat`。

## 並行執行

| 情況 | 行為或處理方式 |
|---|---|
| 檔案範圍不重疊 | 可跨 Claude 與 Codex 同時執行。 |
| 範圍重疊 | 回傳 `NEEDS_INPUT` 與 `reason: "OVERLAP"`，等另一 run 結束後重試。 |
| 空範圍、純萬用字元或 repo 外路徑 | 視為整個 repo。 |
| 範圍檢查後仍發生衝突 | 保留 patch 與 worktree 供檢查。 |
| 其他 run 留下未提交變更 | 確認 `DIRTY` 後，以其 snapshot 為基礎。 |
| 程序已結束、不可讀或舊版鎖 | 檢查後授權 `--clear-stale` 或 `clearStale: true`。 |
| Claude session 當掉 | 確認已不再執行，再以 `--clear-stale=<runId>` 或 `clearStale: "<runId>"` 清理。 |

不可清除仍有存活程序的鎖；Claude 鎖沒有長駐程序 ID，直到 finish 或確認清理前都視為作用中。
結果一次只由一個 run 套用，guard 會保護所有作用中範圍。
共用的 `live.json`、panel 與 `HANDOFF.md` 顯示最後寫入者，Codex 自動額度交接則使用各 run 的 live 狀態。

## 執行檔案

| 位置 | 內容 |
|---|---|
| `.model-ladder/runs/` | Run 鎖、Claude 暫存狀態、setup patch 與衝突 patch。 |
| `.model-ladder/` | 共用歷史、live、usage、context 與 `HANDOFF.md`。 |
| `<system temp>/model-ladder/<repo hash>/codex-<uuid>/` | Codex worktree、記錄、輸出、snapshot、checkpoint 與 `result.json`。 |

使用 runner 回傳的路徑，不要猜測。
清理會刪除已完成產物，但保留作用中 run、衝突、patch、checkpoint、未完成執行，以及 `keepFailed` 指定的失敗嘗試。

## Codex DIRECT、提交與續跑

| 操作 | 必要步驟 |
|---|---|
| DIRECT | 提供實際 `contextTokens`、`contextWindow`，且 router 須判定為小任務。 |
| 完成 DIRECT | 只修改回傳的 `worktreePath`，再以原始輸入加 `directRun`、`directSummary` 交回。 |
| 強制一般 ladder | 使用 `forceLadder: true`，停用 DIRECT。 |
| 執行大型任務 | 若預估用量可能不足，回答用量風險詢問（`acceptUsageRisk: true` 為繼續）。 |
| Commit | 明確開啟 `commit: true`，只提交已驗證且不含無關 staged 變更的檔案。 |
| 逾時續跑 | 以原始輸入加回傳的 `resumeRun` 重試，skill 最多自動續跑兩次。 |

DIRECT 不代表完成，必須遵守回傳的保護規則，獨立驗證後才套用。
呼叫端 sandbox 無法修改草稿時，改走一般 ladder，不繞過權限。
續跑會核對原始 checkout、設定、任務與驗收條件，再於新的 worktree 延續草稿。
不可自動續跑取消、額度停止或尚未解決的環境錯誤。
含既有或並行修改的檔案會跳過 commit，跳過或提交失敗時仍保留已驗證的變更並回報 `outcome.note`。
任何 run 都不會 push。

## 進階設定

設定依序採用預設值、個人檔、專案檔，`usageGuard` 逐欄合併。
個人檔為 `~/.claude/model-ladder.json` 或 `~/.codex/model-ladder.json`，專案檔分別放在 `.claude/`、`.codex/`。

| 設定 | 預設值 | 用途 |
|---|---|---|
| `router` | Claude：`sonnet/low`；Codex：`terra/low` | 路由任務與診斷失敗。 |
| `verifier` | Claude：`haiku/low`；Codex：`luna/low` | 獨立檢查結果。 |
| `tiers` | Haiku、Sonnet、Opus；Codex 使用 `luna`、`terra`、`sol` | 依序選模型與 effort，`maxEffortJump` 限制 effort 升幅。Codex 的家族名（`luna`、`terra`、`sol`）執行時會自動解析為 `$CODEX_HOME/models_cache.json` 中的最新版本（讀不到時退回 `gpt-6-luna`、`gpt-6.1-terra`、`gpt-6.1-sol`）；寫完整名稱（如 `gpt-5.6-terra`）則照原樣使用。 |
| `maxAttempts` | `4` | 最多嘗試次數。 |
| `verify` | 自動尋找 | 既有驗證命令或專案驗證 skill。 |
| `protected` | `[]` | Worker 不得修改的額外路徑。 |
| `commit` | `false` | 明確開啟後提交已驗證變更。 |
| `keepFailed` | `false` | 保留失敗 worktree。 |
| `network` | `false` | 僅 Codex。設為 `true` 時，worker 與 verifier 的 sandbox 可連網（`sandbox_workspace_write.network_access`），報告型任務改用 `workspace-write`（`read-only` 下網路無效），但仍禁止並偵測檔案變更，提示也會要求以 Python 而非 curl 取資料。 |
| `timeoutMs` | `600000` | Codex 每個角色或驗證命令的閒置逾時。 |
| `usageGuard` | 開啟、`90%` | 使用量保護，建議存於個人檔。 |
| `worker_skills` / `verifier_skills` | 空白 | 自然語言角色指示。適用的指名能力為必用：worker 必須實際呼叫，不能只是照著做。 |
| `direct_threshold` | `30` | 小任務 DIRECT 的 context 百分比，或 `"off"`。 |
| `autoRun` / `band` | `true` | 預設路由與顯示開關。 |

Claude 模型別名會使用可用版本，Codex 的模型 ID 與 effort 請依帳戶調整。
Claude 外掛選單提供 DIRECT 門檻 20–80（每 10 一級），另可選 `off`。
未指定 `verify` 時，Codex 優先使用專案驗證 skill，再尋找既有 npm、pytest、Cargo、Go、Maven 或 Make 檢查。

### Codex sandbox：uv 與 Node 專案

Codex 的 worker 與 verifier 在沒有網路、只能寫入該次嘗試 worktree 的 sandbox 中執行。新建的 worktree 沒有 `.venv`，也沒有 `node_modules`。runner 不會放寬 sandbox，也不會改動你的全域環境變數。

| 專案 | runner 的做法 |
|---|---|
| 任何專案，Codex 的 worker、verify 指令與 verifier | `TEMP`、`TMP`、`TMPDIR` 指向 `<worktree>/.ml-tmp`，因為 Codex sandbox 無法寫入系統暫存目錄（`tempfile.gettempdir()` 失敗、pytest `tmp_path` 壞掉）。該資料夾有自己的 `.gitignore`（內容 `*`），不會進入 patch。runner 自己的環境不變。 |
| uv 專案（有 `uv.lock`），主 checkout 已有 `.venv` | worker、verify 指令與 verifier 會拿到：`UV_PROJECT_ENVIRONMENT` 指向主 checkout 的 `.venv`（或你自己設定的 `UV_PROJECT_ENVIRONMENT`）、`UV_NO_SYNC=1`、`UV_OFFLINE=1`、`UV_PYTHON_DOWNLOADS=never`、`PYTHONDONTWRITEBYTECODE=1`，以及 `UV_CACHE_DIR=<worktree>/.uv-cache`。Codex 角色透過 `shell_environment_policy.set` 取得這些值。`uv run pytest` 因此能離線使用主 `.venv`，不同步也不寫入它，worktree 裡不會產生 `.venv`。快取目錄有自己的 `.gitignore`，不會進入 patch，並隨 worktree 一起刪除。 |
| uv 專案，verify 指令或驗證 skill 用到 `uv`，但主 checkout 沒有 `.venv` | run 在任何角色開始前停止，回報 `STOPPED`、`errorCode: "UV_SYNC_REQUIRED"` 與「Run uv sync in the main checkout first」（需要先在主 checkout 跑 uv sync），不會重試。請在主 checkout 執行 `uv sync` 後重跑任務。 |
| 有相依套件的 Node 專案，verify 使用 npm、npx、pnpm、yarn 或 bun，worktree 沒有 `node_modules` 且指令失敗 | run 以 `STOPPED` 停止並回報「Frontend checks not run」（前端檢查未執行），絕不當作通過，也不會改用更強的模型重試。runner 不建立 `node_modules` junction，所以清除 worktree 時不會順著連結刪到主 checkout。請自行執行檢查，或把 `verify` 設成不需安裝的檢查。 |

worker 與 verifier 的 prompt 都會說明這些限制。diagnose 因環境問題停止時，報告會附上同樣可照做的提示：先在主 checkout 執行 `uv sync`，或在 `.codex/model-ladder.json` 把 `verify` 設成不需安裝或網路的指令。Claude runtime 不受影響。

| 環境變數 | 用途 |
|---|---|
| `CLAUDE_CONFIG_DIR` / `CODEX_HOME` | 改變個人設定目錄。 |
| `MODEL_LADDER_USER_CONFIG` | 直接指定個人設定檔。 |
| `MODEL_LADDER_AUTORUN=0` | 關閉預設路由。 |
| `MODEL_LADDER_BAND=0` | 隱藏 Codex panel，不影響 autorun。 |
| `CODEX_BINARY` | 指定原生 Codex 執行檔。 |
| `MODEL_LADDER_NO_UPDATE_CHECK=1` | 停用版本檢查。 |

Claude 外掛角色指示作為預設，專案同名鍵可覆蓋，空字串也算覆蓋。
每行一條規則，`model-ladder: use plugin:skill` 只在主 repo 資料夾名稱完全等於 `model-ladder` 時生效，沒有 `專案名稱: ` 前綴的行（包括內文含冒號的行，例如 `use ponytail:ponytail`）全域適用。
第一個冒號分隔專案名稱，符合的內容保留後續冒號，空值與未解析的 `${...}` 不加入說明。
缺少能力時會在執行前及最終報告提醒，例如：`ponytail` 在這個專案無法使用。
角色指示可指定 skills、plugins、slash commands 或 MCP server，但不能擴大權限、允許 verifier 修改或遞迴呼叫 ladder。

## Band 與 panel 詳細說明

基本欄位與控制項見 [README](README.zh-TW.md#bandclaude-code)。

| 細節 | 行為 |
|---|---|
| Context | Claude 顯示 `ctx 287k/1M (28.7%)`，token 未知時只顯示上限，上限未知則不顯示。 |
| Codex context | runner 只讀取符合目前 session ID 與 cwd 的 rollout token 數；HUD 使用受信任的 SessionStart hook 提供的 ID。無法對應時省略，不可杜撰數值。 |
| 保護控制 | 只儲存修改的個人設定欄位，專案覆寫仍有效。 |
| 門檻 | 按 Enter 或停止輸入 5 秒後儲存，不會改變保護開關。 |
| 角色指示 | 只顯示符合專案與全域的規則且不加前綴，Band 預設預覽一行，點箭頭可展開或收合。 |
| Claude 交接 | `handoff now` 先寫模板，再於 session 閒置時執行 `/model-ladder:handoff`。usage guard 開啟時，用量視窗達到門檻也會自動執行一次。 |
| 交接備案 | 提交失敗時 toast 顯示指令，模板仍可使用。 |
| Codex 控制 | 輸入 `g`、`t 90`、`h` 或 `q` 後按 Enter。 |
| CLI 控制 | `watch.mjs` 接受 `--guard on|off`、`--threshold 1-100`、`--handoff`；加上 `--set` 只儲存、不開 watch。在 Codex 也可以直接說，例如「把 model-ladder 的 threshold 改成 80」。 |

Claude Code band 另外為本 session 每個進行中的背景工作（主 session 自己發出、帶 `run_in_background` 的 Bash 呼叫，或 ladder 以外的非同步 Workflow 啟動；subagent 發出的不算）各顯示一列 `background`：只顯示經過時間，任務欄為 `<kind>: <label>`（`shell` 或 `workflow`）。只在 Claude 沒有執行回合且沒有 ladder agent 執行時顯示，收到該工作的 task-notification 後移除。
手動交接不會取消 run。
Codex 沒有 autorun 或 panel 時，確認外掛已啟用、重新啟動 session，並在 `/hooks` 檢閱與信任 hooks。
Hook 信任適用於目前的定義與內容：更新後請在 Codex CLI 開啟 `/hooks`，若 model-ladder 的 SessionStart hook 顯示已修改，請檢閱並重新信任，再開啟新 session。Codex 會略過未信任或已修改的 hook；手動執行腳本不會建立信任。詳見 [OpenAI hook 文件](https://learn.chatgpt.com/docs/hooks)。
明確呼叫 ladder skill 也會初始化 panel，不會安裝 editor UI extension。

## 使用量保護細節

| 條件 | 行為 |
|---|---|
| Claude 用量門檻 | 在 run 前及失敗嘗試後檢查。 |
| Codex 用量門檻 | 在角色切換時及執行中每 2 秒檢查。 |
| 作用中 run 用量停止 | 停止該 run 與同機其他已註冊 runner 的程序樹。 |
| 未知用量 | 不阻擋執行。 |
| 額度硬上限 | 關閉 guard 仍停止，包括可辨識的純上限訊息。 |
| 認證、sandbox 或模型存取錯誤 | 視為環境錯誤停止，不產生額度交接。 |
| Windows 拒絕停止程序樹 | 回報錯誤、保留註冊，不宣稱已停止。 |

不可繞過 sandbox、清除存活鎖，或以單一 PID 取代程序樹停止。
可停止已註冊 runner，不代表能取消任意 Claude 宿主 session 或 hosted agent。
Claude 用量來自 Band 或 `scripts/usage-statusline.mjs`，只有 Pro/Max 方案回報用量。

`USAGE_LIMIT` 會保留可用草稿並寫入 `.model-ladder/HANDOFF.md`。
主 session 在原樣保留的驗證附錄前補上目標、決定、已完成工作、下一步與續跑方式，附錄仍為權威紀錄。
session 無法呼叫模型時保留模板。
強制終止的 run 可能沒有 checkpoint 或 `result.json`，此時檢查草稿並在額度重設後重啟原始任務，不可杜撰 `resumeRun`。

## 預估與校準

耗時範圍以結構化資料存於 live/result/history JSON，面板時間欄顯示「經過/預估」。
worker、test-writer、verifier 列顯示該 agent 自己的經過時間與自己的預期時長（router、diagnose、final diagnosis 列只顯示經過時間）：取自可比較成功 run（VERIFIED、已完成、未被截斷、90 天內、相同 runtime）的 `forecast.phases` 階段時長中位數，至少有兩筆樣本時依「階段加模型/effort」，之前只依階段；某階段沒有樣本時，改用 router 給的 `workerMinutes` 與 `verifyMinutes`（單次 worker 嘗試與單次驗證的正整數實際分鐘數，隨 plan 帶入，路由後寫入 run 鎖的 `phaseExpected`；Codex 則寫入 `live.expected`）；歷史樣本仍然優先。兩者都沒有時只顯示經過時間。
Claude Code 即時讀取 run 鎖中的 `phaseExpected`（每個 workflow 邊界寫入），Codex 面板讀取 `live.json` 的 `expected`；已結束的列保留結束時的值。執行中的列經過時間達到或超過預期時長後，顯示的預期時長會分段重新估計：預期值加上最小的整數個步長（步長為 1 分鐘與預期值一半中較大者），使結果大於經過時間（預期 7m 的列在經過 12m 時顯示 14m，經過 14m 時顯示 17.5m，所以分母只在步長邊界變動）。已結束的列保留原本的預期時長，超時仍會顯示為 `✓ 12m/7m`。

預估範圍包含路由、實作、自我檢查、測試、獨立驗證與重試風險。無可比較成功歷史時，範圍僅為路由模型判斷；有資料後使用實際誤差比例的最小值、中位數與最大值，不宣稱信賴區間或準確率。歷史保留原始預估、階段更新、模型、effort、token、實際計時與誤差。中斷、DIRECT、錯誤與取消屬於截尾紀錄；失敗紀錄也不作為成功校準證據。僅使用最近 90 天、相同執行環境、起始模型與 effort、路由器、驗證器、驗證命令、重試上限、路由預估分鐘數與任務模式的紀錄。續跑使用獨立的比較紀錄並保留前一次原始預估；缺少可比較的續跑資料時，範圍保持未知。

每個可用訂閱時間窗分別比較預估消耗、剩餘額度與啟用中的 usageGuard 門檻。分鐘或 token 不換算成訂閱百分比。證據必須是新鮮的前後觀測、相同來源、帳號識別與重置時間、未下降的百分比，並且可歸因、排除帳號同時活動。目前來源無法證明沒有其他帳號活動，因此一般回傳 unknown 與原因。過期、缺少時間戳、跨重置、失敗或未完成的資料不作為可靠證據；既有 guard 保持有效。階段邊界以整個 run 的消耗範圍保守比較目前餘額，不假設線性消耗速率。

Claude 由主控端在每次 Workflow 呼叫前後執行 Node 記錄命令。Workflow 不讀時鐘、不匯入模組；結構化 journal 每次接續一個代理，重播先前結果不再呼叫模型。階段計時包含該次呼叫內的主控端成本；preflight 到 finish 的總時間包含等待。錯誤時未結束的邊界保留為截尾觀測。

## 疑難排解

| 症狀 | 原因 | 解法 |
|---|---|---|
| Pro 方案的 Claude Code 沒有 Workflow 工具，或無法使用自動化。 | ladder 以 Workflow 執行，Pro 方案須先啟用（[README](README.zh-TW.md#需求與相容性)）。 | 安裝外掛前先在 `/config` 啟用 Workflow。第一次執行若詢問是否允許 Workflow，選「不再詢問」。 |
| preflight 回傳 `ERROR`：「model-ladder needs a git repository with at least one commit」。 | 資料夾不是 Git repo，或尚無任何 commit 導致 `HEAD` 無法解析（`scripts/preflight.mjs`）。 | 執行 `git init` 並建立第一個 commit，或改在既有 repo 中使用；否則請直接做該任務。 |
| Windows 上 worker 錯誤出現 `Refusing to use <path> as an isolation worktree`。 | Claude Code 可能拒絕所有隔離 worktree，例如把 `c:\` 與 `C:/` 視為不同路徑（CHANGELOG 1.2.5）。 | 更新到 1.2.6 或以上。worktree 被拒後不再結束該次呼叫：worker 會在同一次呼叫內於 `.claude/worktrees/` 以 `git worktree add --detach` 建立自己的 worktree，只在其中工作。錯誤訊息保留 600 字元，可看到兩個路徑。仍失敗時檢查 `git worktree list` 與 `git worktree prune`。 |
| Codex 的 autorun、panel 或 HUD 沒出現，或 `/hooks` 顯示 hook 已修改。 | Codex 會略過未信任或已修改的 SessionStart hook；信任綁定目前的定義與內容，因此每次更新外掛後都需重新信任。手動執行腳本不會建立信任。 | 在 Codex CLI 開啟 `/hooks`，檢閱並重新信任 model-ladder 的 SessionStart hook，再開新 session（[Band 與 panel 詳細說明](#band-與-panel-詳細說明)）。 |
| Windows 上 HUD 無法啟動，出現「Codex HUD requires a native executable」。 | 以 npm 安裝的 `codex` 是 `.cmd` 或 `.bat` shim，HUD 不支援（`scripts/codex-hud.mjs`）。 | 讓原生 `codex.exe` 出現在 PATH，或以 `CODEX_BINARY` 指定它（[Codex runner 與 HUD](#codex-runner-與-hud)）。 |
| HUD 顯示「node-pty could not be loaded」並改啟動一般 `codex`。 | `node-pty` 第一次會在背景安裝（`npm ci --omit=dev`），可能還在安裝或安裝失敗。沒有它就沒有 HUD，但 `codex` 仍可執行。 | 等待 SessionStart 顯示就緒，或在外掛目錄執行 `npm ci`。安裝記錄是 `<system temp>/model-ladder/<repo hash>/` 下的 `npm-ci.log`。之後開新的 PowerShell 視窗。 |
| 舊版 Node.js 上腳本執行失敗。 | 外掛需要 Node.js 20，且不會代為安裝；CI 測試 20 與 22（[README](README.zh-TW.md#需求與相容性)）。 | 安裝 Node.js 20 或以上。 |
| Claude Code 的 band 沒有出現。 | band 需要 Claude Code 2.1.290 或以上。 | 更新 Claude Code。 |
| 報告為 `DIRTY`。 | 其他 run 或你自己在 checkout 中留下未提交變更。 | 確認是否以這些變更為基礎執行（[並行執行](#並行執行)）。 |
| 報告為 `STALE_RUN`。 | 鎖已失效、無法讀取或為舊格式，或屬於已當機的 Claude session。 | 檢查列出的鎖與程序，再授權 `--clear-stale` 或 `clearStale: true`；當機的 Claude session 則用 `--clear-stale=<runId>`。切勿清除仍有存活程序的鎖（[並行執行](#並行執行)）。 |
| 使用注音等輸入法時，Ctrl+] 在 Codex HUD 中沒有反應。 | 輸入法會把 Ctrl+] 變成字元 `】`，HUD 看不到按鍵（CHANGELOG 1.2.5）。 | 改按 Alt+H；它不會轉發給 Codex（[Codex runner 與 HUD](#codex-runner-與-hud)）。 |
| 找不到 run 的檔案或記錄。 | 鎖與 patch 在 `.model-ladder/runs/`；Codex worktree、記錄與 `result.json` 在系統暫存目錄。 | 見[執行檔案](#執行檔案)，並使用 runner 回傳的路徑。 |
