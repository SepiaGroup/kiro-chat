# Changelog

## 0.1.0 (unreleased)

First release.

- `/remote` in the terminal chat starts or stops remote access and shows the pairing card.
- Slash commands work in chat tabs: `/usage`, `/context`, `/tools`, `/model`, `/compact`, `/help` and the rest of the terminal chat's commands run there, with their output in a card. Before, they went to the agent as text.
- Fixed: the chat didn't follow a tool card as it grew, and a command's output box showed the start of the output instead of the end.
- Remote access shows terminal chats too: watch them, prompt, stop, and answer approvals and questions from the phone.
- Fixed: a prompt from the phone to a chat in another window said "Not sent" when the reply took more than a few seconds.
- Rename a chat tab or the panel chat with `/title <name>` or **Rename Chat…** (Command Palette or the tab's right-click menu). The name is kept after a reload and shown on a remote device.
- A chat's history in memory is limited to about 32 MB: images in the oldest messages go first.
- Remote access with several windows: no two windows can hold the hub at once (lock files are written whole and a stale lock is removed safely), process ids reused after a restart no longer keep an old window listed, and calls between windows close when they time out.
- Fixed: reply text written after a tool call was added to the reply above the tool cards, so the end of a long answer seemed missing.
- Chat with the Kiro CLI v3 engine in editor tabs, the panel, or a text-mode
  terminal chat, on Macs without AVX/AVX2.
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
- Optional (`kiroCliChat.shareEditorContext`, off by default): tell the agent
  which files are open and which is active.
- Model, mode, effort and Autopilot switching; context breakdown and
  compaction; Resume; images; slash commands.
