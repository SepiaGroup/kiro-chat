# Changelog

## 0.1.0 (unreleased)

First release.

- A Kiro Chat button at the top right of the editor opens the chat, and an icon in the Activity Bar (left edge) opens it in the side bar. The chat view that lived in the bottom panel moved there; drag it back if you prefer. **Open Chat in Panel** is now **Open Chat in Side Bar**.
- Windows 11 support, best effort: kiro-cli is found with `where` and in `%LOCALAPPDATA%\Kiro-Cli`, the login terminal works in PowerShell, cmd and Git Bash, the Resume list matches folders whatever the drive letter case and slashes, `~\` is the home folder, and the Tailscale CLI is found in Program Files. The tests run on Windows in CI. Nobody has used the chat on a real Windows machine yet. User-facing text says "this computer" instead of "this Mac".
- `/remote` in the terminal chat starts or stops remote access and shows the pairing card.
- Security: a paired device is now trusted like you at the keyboard, in chat tabs and terminal chats (before: Allow once and Deny only). Anything that changes approvals or Autopilot needs the `approve` permission, also when typed as a command. Take `approve` out of `kiroChat.remote.permissions` to stop a device answering approvals; there is no "once only" level.
- Remote devices can do what you can at the keyboard in a chat tab: all the approval choices (rules included), Autopilot and the other settings, Restart, Resume, new tabs and the `/` commands, with their output on the phone. What acts on the Mac itself (login, `/remote`, `/copy`, `/settings`, `/theme`, `/transcript`, `/chat save`, `/agent create|edit`, `/context add`, `/knowledge add|update`) is refused, and `/set` is limited to the Settings panel's options. In terminal chats on the phone, commands and settings stay as they were.
- Slash commands work in chat tabs: `/usage`, `/context`, `/tools`, `/model`, `/compact`, `/help` and the rest of the terminal chat's commands run there, with their output in a card. Before, they went to the agent as text.
- Fixed: the chat didn't follow a tool card as it grew, and a command's output box showed the start of the output instead of the end.
- Remote access shows terminal chats too: watch them, prompt, stop, and answer approvals and questions from the phone.
- Fixed: a prompt from the phone to a chat in another window said "Not sent" when the reply took more than a few seconds.
- Rename a chat tab or the panel chat with `/title <name>` or **Rename Chat…** (Command Palette or the tab's right-click menu). The name is kept after a reload and shown on a remote device.
- A chat's history in memory is limited to about 32 MB: images in the oldest messages go first.
- Remote access with several windows: no two windows can hold the hub at once (lock files are written whole and a stale lock is removed safely), process ids reused after a restart no longer keep an old window listed, and calls between windows close when they time out.
- Fixed: reply text written after a tool call was added to the reply above the tool cards, so the end of a long answer seemed missing.
- Chat with the Kiro v3 engine in editor tabs, the panel, or a text-mode
  terminal chat. Works on Macs without AVX/AVX2.
- The extension is called Kiro Chat (was "Kiro CLI Chat"): its id is `sepiagroup.kiro-chat` and its settings and commands start with `kiroChat.` (was `kiroCliChat.`). Paired devices have to pair again.
- Approvals like kiro-cli: Allow, Create allow rule… (exact, command pattern,
  folder, entire tool), Deny, Deny with reason…, Create deny rule….
- The agent's questions (Spec mode) as a card or numbered choices, with your
  own answer or Skip. `@file:path` in a prompt attaches the file. A prompt the
  engine never answers is cancelled after 10 minutes.
- Remote access (preview): watch and use a chat tab from your phone or another
  browser over Tailscale (HTTPS, your tailnet only), paired once with a link
  or a QR code on a card in VS Code. Several VS Code windows share one address
  and one chat list, with a dropdown on the page that names the chat and switches it. Approvals can be allowed or
  denied once from the other screen; no rules, Autopilot or restart.
  The page fits a phone: it follows the device's light or dark setting, has
  large touch targets, system fonts, handles the keyboard and the notch, and can be added to
  the home screen. Switch it on in ⚙ Settings. The Settings and Resume panels now have a
  border and shadow so they stand out from the chat.
- A Stop button (and Esc) ends a reply in the chat tabs, as Esc does in the
  terminal chat. Send stays on during a reply and steers it.
- A failed prompt shows a short message with a hint (log in again, network,
  session). The engine's rate-limit warning shows as a red line and the reply
  carries on.
- Typing while the agent works sends your message to it (it reads it at its
  next step); in the terminal Esc takes back a message it hasn't read yet.
- Optional (`kiroChat.shareEditorContext`, off by default): tell the agent
  which files are open and which is active.
- Model, mode, effort and Autopilot switching; context breakdown and
  compaction; Resume; images; slash commands.
