# Commands and settings

[Guide index](README.md) · [Getting started](getting-started.md) · [Chat tabs](chat-tabs.md) · [Terminal chat](terminal-chat.md) · [Slash commands](slash-commands.md) · [Remote access](remote-access.md) · [Reference](reference.md) · [Troubleshooting](troubleshooting.md)

## Commands

| Command | What it does |
| --- | --- |
| Kiro Chat: Open Chat (`Cmd+Alt+K`) | Shows the most recent chat tab (or the panel, per `openIn`). |
| Kiro Chat: New Chat Tab | Opens another chat tab with a new conversation. |
| Kiro Chat: Open Chat in Editor Tab / in Side Bar | Opens the chat in that place. |
| Kiro Chat: New Terminal Chat (text mode) | Opens a terminal chat. |
| Kiro Chat: New Session | Asks, then starts a fresh conversation in the current chat. |
| Kiro Chat: Resume Previous Session | Opens the current chat's Resume panel. |
| Kiro Chat: Restart Engine | Asks, then restarts the current chat's engine. |
| Kiro Chat: Rename Chat… | Renames the current chat, or the tab right-clicked (empty: back to its own name). |
| Kiro Chat: Log In | Runs `kiro-cli login` in a terminal. |
| Kiro Chat: Attach Image or File | File picker; images attach, other files insert their path. |
| Kiro Chat: Start / Stop Remote Access | Starts or stops the remote access server. |
| Kiro Chat: Show Remote Access Link | The pairing card: a new one-use link as a QR code, to copy or open. |
| Kiro Chat: Remove Remote Device… | Unpairs one device, or all of them. |

"Current chat" is the chat tab or side bar view you used last.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `kiroChat.openIn` | `editor` | Where Open Chat goes: `editor` (tab) or `panel` (the side bar view). |
| `kiroChat.kiroCliPath` | _(empty)_ | Path to `kiro-cli`. Empty = PATH, then `~/.local/bin/kiro-cli` (on Windows `%LOCALAPPDATA%\Kiro-Cli\kiro-cli.exe`). Must be the program, not a `.cmd` script. User settings only (a workspace can't set it). |
| `kiroChat.defaultModel` | `auto` | Model for new sessions (see `kiro-cli chat --list-models`). |
| `kiroChat.autopilot` | `false` | Off = Supervised (approve each change). On = tools run without asking. |
| `kiroChat.enterToSend` | `true` | Enter sends, Shift+Enter adds a line. Off reverses them. |
| `kiroChat.defaultEngine` | `auto` | `auto` checks that the engine runs on this machine (once, then remembered) or `v3`. |
| `kiroChat.shareEditorContext` | `false` | Tell the agent which files are open in the editor and which is active (paths only, files inside the chat's folder only). Sent with a prompt when it changed; the chat says so. Ignored in an untrusted workspace. |
| `kiroChat.remote.autoStart` | `false` | Start remote access when VS Code starts. Machine setting. |
| `kiroChat.remote.permissions` | `view`, `prompt`, `approve` | What a paired device may do: `view` chats, `prompt` (send, steer, stop, answer questions), `approve` (allow or deny once). Machine setting. |
| `kiroChat.remote.httpsPort` | `8443` | The HTTPS port Tailscale uses (443, 8443 or 10000). 8443 leaves 443 to anything you already serve. Machine setting. |
| `kiroChat.remote.port` | `0` | Local port for remote access (listens on 127.0.0.1 only). 0 reuses the port of last time when it is free, otherwise picks a free one, so an open page reconnects after a restart. Machine setting. |
| `kiroChat.interactionMode` | `persistent` | `persistent` (ACP) is required for everything above. `one-shot` is a basic fallback with no approvals. |
