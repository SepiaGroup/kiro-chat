# Contributing

## Setup

```sh
npm ci
```

Node 22 or later. All dev dependencies are pinned to exact versions.

## Develop

- **F5** (Run Extension) builds with source maps (`npm run build:dev`) and
  opens an Extension Development Host with this extension loaded.
- `npm run watch` rebuilds on change; reload the development host to pick it up.
- Logs: **Output → Kiro Chat** in the development host.

## Check

```sh
npm run compile   # type-check
npm run lint      # eslint, must report nothing
npm test          # unit tests (node --test), incl. a fake engine for AcpClient
```

CI runs these and `npm run package` on every push and pull request, and runs
the compile, lint and tests on Windows too. Before a release, also run the
manual checklist in [TEST.md](TEST.md) on a Mac without AVX, and its Windows
section on a Windows 11 machine.

Keep code that depends on the platform in a pure function that takes the
platform as a parameter (see `candidateCliPaths`, `shellCommandLine`,
`normalizePath` in `sessionList.ts`), so the Windows case can be tested on any
machine.

## Release

1. Update `version` in `package.json` and add an entry to `CHANGELOG.md`.
2. `npm run package` → `kiro-chat-<version>.vsix`.
3. Install it (`code --install-extension kiro-chat-<version>.vsix --force`)
   and run the manual checks.
4. Commit, tag `v<version>`, push.
5. Publish: `npx vsce publish` (needs a Marketplace token for the
   `SepiaGroup` publisher), or upload the `.vsix` in the Marketplace portal.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for how the code is laid out
and [AGENTS.md](AGENTS.md) for the design rules and conventions (written for
AI coding agents, but they apply to everyone).
