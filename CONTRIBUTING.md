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
platform as a parameter (see `candidateCliPaths`, `terminalLaunch`,
`normalizePath` in `sessionList.ts`), so the Windows case can be tested on any
machine.

## Release

1. Update `version` in `package.json` and add an entry to `CHANGELOG.md`.
2. `npm run package` → `kiro-chat-<version>.vsix`.
3. Install it (`code --install-extension kiro-chat-<version>.vsix --force`)
   and run the manual checks.
4. Commit, tag `v<version>`, push.
5. Publish the same `.vsix` to both registries, so they ship identical files:
   - VS Code Marketplace (VS Code): `npx vsce publish --packagePath
     kiro-chat-<version>.vsix`. Needs a Marketplace token for the `SepiaGroup`
     publisher (`npx vsce login SepiaGroup`). Or upload the `.vsix` in the
     Marketplace portal.
   - Open VSX (Kiro IDE, VSCodium, Cursor and other VS Code builds):
     `npx ovsx publish kiro-chat-<version>.vsix -p <token>`. Needs an Open VSX
     token from an account that owns the `SepiaGroup` namespace.

   Publish from the tagged commit, after `git status` shows nothing changed:
   both registries show the README and CHANGELOG from the `.vsix`.

### One-time setup

- **VS Code Marketplace:** create the `SepiaGroup` publisher at
  <https://marketplace.visualstudio.com/manage>, then a Personal Access Token in
  Azure DevOps (organization "All accessible organizations", scope Marketplace →
  Manage).
- **Open VSX:** log in at <https://open-vsx.org> with GitHub, sign the Eclipse
  Foundation publisher agreement (profile page; it needs an Eclipse account
  linked to the same GitHub account), create an access token in Settings →
  Access Tokens, then create the namespace once:
  `npx ovsx create-namespace SepiaGroup -p <token>`.

Keep both tokens out of the repo and out of shell history (for example
`read -s OVSX_PAT` and `-p "$OVSX_PAT"`).

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for how the code is laid out
and [AGENTS.md](AGENTS.md) for the design rules and conventions (written for
AI coding agents, but they apply to everyone).
