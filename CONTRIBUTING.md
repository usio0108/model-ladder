# Contributing

Thanks for helping. Issues and pull requests in English or Traditional Chinese are both welcome.

For first-run problems see [USAGE.md#troubleshooting](USAGE.md#troubleshooting) before filing an issue. Report vulnerabilities privately ([SECURITY.md](SECURITY.md)).

## Development setup

- Node.js 20 or later (CI tests 20 and 22 on Linux, macOS and Windows).
- `npm ci` installs `node-pty`, which only the Codex HUD needs.
- No build step.

## Tests

Run only the test files related to your change:

```sh
node --test tests/unit/<related>.test.mjs
```

GitHub CI runs the full suite (`npm test`, which is `node --test tests/unit/*.test.mjs`) on every push to `main` and every pull request. CI does not run Claude Code or Codex.

## Documentation

Docs come in English and Traditional Chinese pairs (`README.md` / `README.zh-TW.md`, `USAGE`, `DESIGN`, `NOTICE`, `CHANGELOG`). Change both in the same pull request.

## Versions and the changelog

`.github/scripts/check-version.mjs` runs in CI and fails when:

- `.claude-plugin/plugin.json` and `.codex-plugin/plugin.json` differ in `name` or `version`; or
- any file under `.claude-plugin`, `.codex-plugin`, `.agents/plugins`, `codex-skills`, `skills`, `agents`, `hooks`, `scripts` or `workflows` changed since the last `v*` release tag while `version` is not ahead of that tag.

So when you change plugin code, bump `version` in both plugin.json files (Claude Code only offers an update when that field changes) and add a CHANGELOG entry. Changes only to docs, tests, `.github` or `package.json` need no bump. Releases are tagged `vX.Y.Z`.

## For agents

[AGENTS.md](AGENTS.md) holds rules for coding agents working in this repo (for example where temporary files go). It is not a contributor guide; this file is.
