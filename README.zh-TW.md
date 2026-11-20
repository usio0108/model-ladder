<div align="center">

# 🪜 model-ladder

**為每項任務挑選合適的模型，完成後驗證，通過才交付。**

[![Claude Code plugin](https://img.shields.io/badge/Claude%20Code-plugin-D97757?logo=claude&logoColor=white)](https://code.claude.com/docs/en/plugins)
[![Codex plugin](https://img.shields.io/badge/Codex-plugin-412991?logo=openai&logoColor=white)](README.zh-TW.md#安裝)
[![release](https://img.shields.io/github/v/release/usio0108/model-ladder?label=release&color=blue)](CHANGELOG.zh-TW.md)
[![license: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)

[English](README.md) · [安裝](#安裝) · [驗證 skill](#專案驗證-skill-產生器) · [進階使用](USAGE.zh-TW.md) · [設計](DESIGN.zh-TW.md)

</div>

---

model-ladder 是 [Claude Code](https://code.claude.com) 與 Codex 的外掛，每項任務先用最便宜且可能成功的模型執行、驗證，失敗才升級。

## 運作方式

1. Router 挑選最便宜且可能成功的模型與 effort。
2. Worker 在隔離的 Git worktree 中執行任務。
3. Verifier 獨立檢查結果，受保護的測試不可被修改。
4. 驗證失敗才升級到更強的模型或更高 effort；通過驗證的變更才交付，預設不 commit 或 push。

## 安裝

請在至少有一個 commit 的 Git repo 中使用，並先安裝並登入 Claude Code 或 Codex。

```text
# Claude Code
/plugin marketplace add usio0108/model-ladder
/plugin install model-ladder@model-ladder
```

```sh
# Codex CLI 0.160.1+（之後請重新啟動 Codex；需要已登入的原生 `codex`）
codex plugin marketplace add usio0108/model-ladder
codex plugin add model-ladder@model-ladder
```

安裝後重開 Claude Code。Codex 更新、hook 信任與需求見[安裝補充](USAGE.zh-TW.md#安裝補充)、[需求與相容性](USAGE.zh-TW.md#需求與相容性)。

## 使用方式

在 Git repo 中直接描述任務，預設會自動走 ladder；也可用 `/model-ladder:run <任務>` 手動啟動（Codex：請它使用 `model-ladder` skill）。說「no ladder」可略過。步驟、報告與交接見[使用步驟](USAGE.zh-TW.md#使用步驟)。

## 專案驗證 skill 產生器

> 改編自 [pstack](https://github.com/michael-denyer/pstack-claude)（上游 `cursor/plugins/pstack`）；來源與授權見 [NOTICE.zh-TW.md](NOTICE.zh-TW.md)。

model-ladder 另附可產生並維護專案專屬驗證 driver 的 skill，driver 會像使用者一樣操作你的 app：

- `/model-ladder:create-verification-skill` 為尚無腳本化驗證方式的專案建立驗證 skill。
- `/model-ladder:maintain-verification-skill` 定期檢查並維護它，最多提出一個只含已證實修正的 PR。

Codex 版在 [`codex-skills/`](codex-skills/)：請 Codex 使用 `create-verification-skill` 或 `maintain-verification-skill` skill。Claude Code 版的原始碼在 [`skills/`](skills/)。

## 它會動到什麼、什麼會離開你的電腦，以及如何關閉

它會在 `.git/info/exclude` 加兩行、把執行狀態放在 `.model-ladder/`，在 Windows 搭配 Codex 時會在 PowerShell profile 加入一段有標記的區塊。唯一的網路呼叫是可選的每日更新檢查，不會傳送 repo 資料（設定 `MODEL_LADDER_NO_UPDATE_CHECK=1` 可關閉）；任務內容與程式碼會像一般使用 Claude Code 或 Codex 一樣送到模型，router 與 verifier 會多耗額度。細節與關閉方式見[它會動到什麼](USAGE.zh-TW.md#它會動到什麼與資料外送)。

**解除安裝**：在每個用過的 repo 執行 `/model-ladder:uninstall`，再執行 `claude plugin uninstall model-ladder@model-ladder` 與 `codex plugin remove model-ladder@model-ladder`。手動備案見[解除安裝](USAGE.zh-TW.md#解除安裝)。

## 更多

- **Beta**：行為與檔案結構可能調整，見[已知限制](USAGE.zh-TW.md#beta-狀態與已知限制)。
- **設定**：不需設定檔即可執行。編輯 `~/.claude/model-ladder.json` 或 `~/.codex/model-ladder.json`；`worker_skills` 在 `/plugin configure model-ladder` 中顯示為 **Worker skill instructions**。見[進階設定](USAGE.zh-TW.md#進階設定)。
- **Band**：Claude Code band 與 Codex panel 顯示角色、用量與保護控制（[Band](USAGE.zh-TW.md#band-顯示與控制)）。
- **使用量保護**：預設開啟、門檻 90%；偵測到用量停止時回報 `USAGE_LIMIT`、寫入 `.model-ladder/HANDOFF.md`（也可用 `/model-ladder:handoff`），並強制停止同機其他已註冊 run（[使用量保護](USAGE.zh-TW.md#使用量保護細節)）。
- **功能**：[完整清單](USAGE.zh-TW.md#功能)。

---

設計與經驗：[DESIGN.zh-TW.md](DESIGN.zh-TW.md)。[MIT License](LICENSE)，(c) 2026 usio0108。問題請[建立 issue](https://github.com/usio0108/model-ladder/issues)。
