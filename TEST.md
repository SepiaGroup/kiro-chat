# Test Plan

Automated and manual checks for Kiro Chat. Run the automated checks on
every change. Run the manual checks before a release, on the target machine
(no AVX), with `kiro-cli` installed and logged in. The Windows section at the
end is for a Windows 11 machine.

## Automated

```sh
npm run compile   # type-check
npm run lint      # eslint, must report nothing
npm test          # builds dist-test/ and runs node --test
```

All three must exit 0. The tests cover the event mapper, approval rules,
JSON line parser, markdown (HTML and ANSI), line diff, line editor,
slash-command parsing and menu, image-path detection, the chat-tab manager
(with a fake `vscode`), `AcpClient` against a fake engine process
(handshake, timeouts, cancelled turns, unknown requests, the engine dying),
the terminal approval and question prompts, tool log, menu and local
commands, `@file:` expansion, and whole terminal-chat turns against a fake
kiro-cli.
CI (`.github/workflows/ci.yml`) runs them plus `npm run package` on every
push and pull request.

## Install

```sh
npm run package   # builds and writes kiro-cli-chat-<version>.vsix
code --install-extension kiro-cli-chat-0.1.0.vsix --force
```

Then run **Developer: Reload Window**.

## Manual checks

### Opening chats
- [ ] `Cmd+Alt+K` and the **Kiro Chat** status-bar item open a chat tab. `Cmd+Shift+K` still deletes the line in an editor.
- [ ] With `openIn` = `panel`, they open the side bar chat instead.
- [ ] The Kiro Chat ghost button shows at the top right of an editor (also with the chat tab itself active), is visible in light and dark themes, and has the tooltip "Kiro Chat: Open Chat". Clicking it opens or shows the chat as `Cmd+Alt+K` does.
- [ ] The Kiro Chat icon in the Activity Bar (left edge) is a ghost that follows the theme colour (light and dark themes, selected and not selected). One click opens the side bar with the chat, whatever `openIn` is. The chat fits the narrow width (toolbar, Resume, Settings, approval cards). Dragging the view to the bottom panel keeps it working, and it stays there after a reload.
- [ ] Pressing `Cmd+Alt+K` again brings the same tab forward; it doesn't open another.
- [ ] ＋ (right of Restart) and **New Chat Tab** open "Kiro Chat 2", "Kiro Chat 3", …
- [ ] A prompt in one tab gets its reply only in that tab. The panel chat is separate too.
- [ ] Closing a tab stops its engine (`pgrep -fl "kiro-cli.*acp"` count drops).

### Reload
- [ ] With two tabs and the panel chat holding different conversations, reload the window.
- [ ] Each reopens its own session with the history shown, and no reply bubble is left with a blinking cursor.
- [ ] A new tab opened after the reload continues the numbering.

### Toolbar
- [ ] The model dropdown lists the engine's models and switches the live session.
- [ ] `defaultModel` set to a model ID is selected in a new chat. A reopened chat keeps the model it had.
- [ ] The Mode dropdown (left of Resume) switches modes (Default, Plan, …).
- [ ] The context ring shows a percentage; the unused part of the ring is clearly visible.
- [ ] The ring turns yellow at 60% and red at the compaction threshold.
- [ ] The engine status ("engine v3 …") isn't shown once ready.

### Context card
- [ ] Hovering or focusing the ring shows Conversation, MCP servers, Steering & context files, Session files and Memory.
- [ ] Every value has a unit (`0K`, `0.8K`, `16K`). With no MCP servers, MCP shows `0.0% · 0K`.
- [ ] Row percentages are consistent with their tokens and the header.
- [ ] **Compact context** compacts and posts a note; it's disabled while a reply runs.

### Panels
- [ ] Resume lists sessions with title, age and message count (no session ID).
- [ ] Picking a session loads it with its history.
- [ ] Settings has a ✕. Resume has a ✕.
- [ ] Clicking outside either panel, or Esc, closes it. Opening one closes the other.

### Chatting
- [ ] Replies stream as markdown (see `docs/samples/` for test content); code blocks have Copy.
- [ ] A reply that writes, runs a tool, then writes again shows the later text below the tool card, not in the bubble above it.
- [ ] Ask for a command with long output (`find . -name '*.ts'`). The chat stays at the bottom as the card fills in, and the output box shows the end of the output. Scrolled up in the chat (or in the box) while it runs, it stays where you are. Same on the phone.
- [ ] The input starts one row high and grows with content up to 200px.
- [ ] Enter sends, Shift+Enter adds a line; with `enterToSend` off they swap.
- [ ] `/` opens the command picker with the tab's commands (as in the terminal chat, without `/paste`, `/quit`, …) plus the engine's agents and skills.
- [ ] `/usage`, `/context`, `/tools`, `/model`, `/mcp` and `/config` show their output in a card under the command, with colors; nothing goes to the agent. `/help` lists the commands and the agent's commands.
- [ ] `/model <name>` switches the model (the toolbar dropdown follows). `/compact` after a few messages compacts (status shows "Compacting…"). `/clear` empties the chat. `/resume` opens the Resume panel.
- [ ] `/knowledge clear` shows a Yes/No card; No does nothing. `/paste` and `/quit` say they're for the terminal chat. `/nope` says unknown command. ` /usage` (leading space) goes to the agent as text.
- [ ] On the phone, `/` offers only the engine's commands, and `/usage` goes to the agent as text.
- [ ] Paste a screenshot (`Cmd+V`) → it attaches. Shift-drag an image file → it attaches.
- [ ] Dragging a non-image file from the Explorer inserts its path.

### Renaming a chat
- [ ] In a chat tab, type `/` and pick **title**. `/title Build` renames the tab to "Build" and says "Title set to Build."; nothing goes to the agent. `/title` shows the name.
- [ ] Reload the window: the tab is still "Build". `/title clear` gives it its own name back ("Kiro Chat 2"), also after the reload. A new tab gets the next number.
- [ ] **Kiro Chat: Rename Chat…** with the tab active: the box shows the name selected. A new name renames it; Esc keeps it; an empty name resets it.
- [ ] On the phone, typing `/` doesn't offer `/title`. A chat renamed before its engine started (right after a reload) shows the new name in Resume.
- [ ] Right-click a chat tab that is not the current one: **Rename Chat…** renames that tab, not the current one, also with tabs in two editor groups. On another webview tab (Markdown preview) it says it renames Kiro chat tabs and does nothing.
- [ ] The same in the side bar chat: the view's title changes, and comes back after a reload.
- [ ] With remote access on, the phone's chat list shows the new name within a moment. **Resume** in another chat lists the session under the new name.
- [ ] `/title Foo` typed on the phone goes to the agent as text and does not rename.

### Approvals
- [ ] With `autopilot` off, a file write shows a card with Allow / Create allow rule… / Deny / Deny with reason… / Create deny rule….
- [ ] Create allow rule on a file read outside the workspace lists `Trust "<file>"` and `Trust entire tool (Read File)`. Entire tool → reading a second file doesn't ask.
- [ ] A shell command lists `Trust "<command>"`, `Trust "cat *"` and `Trust entire tool (Run Command)`. After "cat \*", another `cat` doesn't ask but `ls` does.
- [ ] On `find …; ls`, entire tool for command 1 means `ls` isn't asked.
- [ ] A write to `src/a/x.txt` offers "Allow a folder for this session…" prefilled with `src/a`. Change it to `src` → a write to `src/y.txt` only shows Review changes; `lib/z.txt` asks. `..`, `~`, `*` or a folder not containing the file show an error.
- [ ] Deny with reason: type "use rg instead" → the agent's reply reflects it.
- [ ] Back returns from the rule list and the text fields; Esc in a text field does too.
- [ ] `cat a; echo b` asks twice, each card naming its command ("Command 1: …", "Command 2: …").
- [ ] Allow applies the change; Deny skips it.
- [ ] With `autopilot` on, tools run without asking.

### Errors
- [ ] Log out (`kiro-cli logout`), send a prompt in each UI. The error is short ("Not authenticated" or similar) and says to log in again. Log in and retry.
- [ ] Turn the network off, send a prompt: the message says it is a network error and what to try.
- [ ] Rate limit (only when it happens): a red line with the engine's message; the reply still finishes.

### Remote access with several windows

Needs two VS Code windows on different folders, each with a chat tab, and a paired phone (see below).

- [ ] Start remote access in window A. Then start it in window B (Remote item in the status bar shows "Remote (shared)" in B). No second Tailscale prompt, and A's phone page keeps working (the earlier bug: B used to take the address from A).
- [ ] On the phone, open the chat dropdown (left of the toolbar, it names the chat you are on): the list shows "A: ...", "B: ..." chats. Open B's chat, send a prompt: it appears in window B. Switch back with the dropdown.
- [ ] In B, **Show Remote Access Link** shows a card with a QR code (it asks the other window). **Remove Remote Device…** in B lists the paired devices.
- [ ] Close window A (the one that started first). Within a few seconds the phone shows the reconnect bar, then B's chats; B's status bar says "Remote" (it is the hub now). No new pairing is needed.
- [ ] Reopen window A, start remote access: it joins as a member, and its chats show up on the phone.
- [ ] Stop remote access in the hub window while another window has it on: the other window takes over.
- [ ] A window where remote access is off shows no chats on the phone.

### Remote access (Tailscale)
- [ ] Tailscale off (menu bar item: Disconnect), then Start Remote Access: the notice says Tailscale is turned off and the link is for this Mac only; the page still works on this Mac. Turn Tailscale on and run **Start Remote Access** again: no restart needed, the link becomes `https://<mac>.ts.net:8443/#k=…`.
- [ ] Before HTTPS certificates and Serve are enabled: the notice has **Open Tailscale Setup**, which opens Tailscale's page. After enabling, Start Remote Access again works.
- [ ] The card (Start Remote Access, or **Show Remote Access Link**) shows a QR code, the link and the buttons. Copy Link copies it; New Link changes the code and the old link stops working; the card closes when a device pairs and when remote access stops. Without Tailscale the card says why, has no QR code, and offers Try Again (and Open Tailscale Setup when Tailscale gave a link).
- [ ] **Phone on Wi-Fi**: scan the QR code with the phone's camera (or send yourself the link), open it in Safari or Chrome: the chat appears, Allow from the phone works, a prompt typed on the phone shows in VS Code.
- [ ] **Phone on cellular** with the Tailscale app on: same. With Tailscale off on the phone the address does not load.
- [ ] Lock the phone for a few minutes, unlock: the page says Reconnecting, then catches up, nothing twice.
- [ ] Add to Home Screen, open from the icon: it opens full screen, still paired, light/dark follows the phone.
- [ ] Stop Remote Access, then in Terminal `tailscale serve status` shows no entry for port 8443 (other serves you have are untouched).

### Remote access (localhost)
- [ ] Open ⚙ Settings in a chat: the panel has a clear border and shadow, and the Resume panel too. At the bottom, **Remote access** is unchecked. Tick it: remote access starts and the pairing link notice appears; the checkbox stays ticked and **Show pairing link** shows. Untick it: remote access stops. Starting it from the status bar menu or the command ticks the box in every open chat. The browser page's Settings has no Remote access row.
- [ ] Run **Kiro Chat: Start Remote Access**. The status bar shows **Remote**. Choose **Open in Browser**: the page opens in your browser, the address bar loses the `#k=...` part, and the chat shows the same conversation as the VS Code tab. With two chats open, a picker lists both (and remembers the last one next time).
- [ ] Send a prompt from the browser: it appears in the VS Code chat too, and the reply streams in both. Stop works from the browser.
- [ ] Autopilot off, ask for a command that needs approval: the card shows in both screens. Allow it in the browser: the card disappears in VS Code with a line "Allowed from <your browser>". Do it the other way round too ("Allowed on the desktop" in the browser). Deny with a reason works.
- [ ] In a chat tab shown in the browser the approval card offers the same buttons as in VS Code. **Create allow rule…** works there (the next matching command is not asked again); the card goes away in VS Code, labelled "Allowed from <your browser>". In a terminal chat shown in the browser the card has Allow, Deny and Deny with reason only.
- [ ] Browser, chat tab: `/usage`, `/context` and `/tools` show their card in the browser and in the VS Code tab (the command line says "(from <your browser>)"). `/compact` after a few messages works. `/model` lists the models. The `/` menu on the phone lists the commands, without `/copy`, `/login`, `/remote`, `/settings`, `/theme` and `/transcript`; typing one of those, or `/chat save x`, `/context add ~`, `/agent create x`, says it isn't available from a remote device.
- [ ] Browser: with `approve` taken out of `kiroChat.remote.permissions`, `/autopilot on`, `/tools trust-all` and `/set autopilot on` are refused ("needs the approve permission") and the approval card has no usable buttons; put it back and they work. A question that nobody answers for 5 minutes counts as No.
- [ ] Browser: `/autopilot on` turns Autopilot on (the ⚙ checkbox in VS Code follows); the Autopilot switch in the browser's ⚙ does the same. `/clear` empties the chat on both. `/knowledge clear` shows Yes/No on both; answering on one removes the card on the other.
- [ ] Browser: **Restart** asks on the phone (Yes/No card), with no dialog on the Mac; Yes restarts. **Resume** lists sessions and loads one. ＋ opens a new chat tab in VS Code.
- [ ] Browser, terminal chat: the `/` menu offers only the agent's commands, there is no Restart, Resume or ＋ (the approval card has the rule buttons), and `/usage` goes to the agent as text.
- [ ] A question from the agent can be answered from the browser.
- [ ] Reload the browser tab mid-reply: the conversation comes back and keeps streaming, nothing twice. Reopen the same link: it says the link is no longer valid. **Show Remote Access Link** gives a new one; the already paired browser needs no link.
- [ ] **Remove Remote Device…**: the browser shows "This device was removed" and cannot reconnect. **Stop Remote Access**: the page shows it cannot reach VS Code.
- [ ] Narrow the browser window to phone width (or use the browser's device mode): the toolbar stays on one row, the page uses the browser's light or dark setting, the approval card shows only Allow, Deny and Deny with reason, Resume, Restart and ＋ are gone, and Settings shows no Autopilot, Memory, Content or Remote rows (only Effort, and the ⚙ button is gone when the engine has no effort setting). With touch emulation, Enter adds a line.
- [ ] Stop and start remote access (or reload the window with auto start on) while a browser page is open: the page shows "Reconnecting…", then shows the chat again by itself, with no new link. The address is the same as before (same port) unless that port was taken.
- [ ] Close a chat tab in VS Code: a browser showing it is told it was closed and offers the other chats.
- [ ] Untrusted workspace: Start Remote Access refuses with a message.
- [ ] Restart VS Code: remote access is off unless `kiroChat.remote.autoStart` is on; paired devices are still paired.

### Remote access (terminal chat)
- [ ] Open a terminal chat with remote access on: the browser's chat list shows "Kiro Chat (terminal)" without a reload, with what the terminal has shown so far. `/title Build` renames it there, and so does **Rename** on the terminal's tab (within a few seconds). Closing the terminal removes it from the list.
- [ ] Send a prompt from the browser: the terminal shows it with "(from <browser>)" and the reply streams in both. Text typed in the terminal before stays and is back after the reply. Stop from the browser ends the reply ("Stopped from …").
- [ ] Autopilot off, a command that needs approval: Allow in the browser and the terminal prints "✓ Allowed from <browser>" and goes on (also with the terminal's reason input open). Answer one with `y` in the terminal: the browser's card goes, with "Allowed in the terminal". **Create allow rule…** in the browser (entire tool, a pattern, a folder) is taken: the terminal prints "✓ Allowed from <browser>", and the next matching command is not asked again. A deny rule and **Deny with reason…** work too. A folder outside the workspace is refused in the browser, and the terminal still waits.
- [ ] A question answered in the browser: the terminal prints "Answered from …" and goes on. Answered in the terminal: the browser's card goes with "Answered in the terminal."
- [ ] `/quit` sent from the browser goes to the agent as text; the terminal stays open.
- [ ] While `/compact` runs in the terminal, a prompt from the browser says the terminal chat is busy. `/clear` in the terminal clears the browser's view; `/restart` too, and the browser can send again after it.
- [ ] A long reply from a chat in another window: the browser does not say "Not sent" (both kinds of chat).

### Stopping a reply (webview)
- [ ] While the agent works, a Stop button (square) shows next to Send; it is hidden when idle. Click it: the label says "Stopping", then "■ Cancelled", and Stop disappears. The next message works.
- [ ] Esc in the message box does the same. With the Settings or Resume panel open, Esc closes the panel first and does not stop the reply.
- [ ] With Autopilot off, ask for a command that needs approval; while the approval card is open, press Stop. The card disappears with the reply; send another message and it works.
- [ ] Send stays enabled during a reply (it steers). After a window reload mid-reply, Stop is shown again.

### Typing while the agent works
- [ ] Ask for something slow (for example "run `sleep 20`, then say DONE"). While it runs, type "also end with the word BANANA" and press Enter. A line says it is queued, then that the agent has read it (after the command ends), and the reply includes BANANA.
- [ ] Terminal: the text you type shows on the status line ("Enter sends: …"). Esc takes back a queued message ("message removed"); another Esc cancels the reply. `/help` mid-reply says commands can't run; dropping an image does too.
- [ ] Webview: `/…` or an attached image while busy shows a short error and keeps your text.

### Questions and files
- [ ] In Spec mode, ask for something that needs a decision (for example "ask me to pick a color from red, blue, green with your question tool"). A card shows the choices; clicking one sends it and the agent uses it.
- [ ] Typing your own answer and pressing Enter sends it. Skip tells the agent to move on.
- [ ] A question left open and then cancelled (Esc in the terminal chat) disappears from the chat. After a window reload an unanswered question card comes back.
- [ ] `what is in @file:README.md?` → the agent knows the contents; the chat and a Resumed session show `@file:README.md`, not the file's text. `@file:missing.txt` stays as typed. A line in the chat says "Attached: …" and "Not attached: … (reason)". A file over 256 KB or a binary file isn't attached.

### Editor context
- [ ] With `kiroChat.shareEditorContext` off (default), asking "which file is open?" gets no VS Code files.
- [ ] Turn it on, open two files, click into the chat tab and ask "which file is active and which are open?". A line "Sent editor context: active …, 2 open files." appears and the answer names them. Ask again unchanged: no new line. Switch file and ask: a new line.
- [ ] The same in a terminal chat. Files outside the chat's folder are never listed.

### Commands (Command Palette)
- [ ] **Restart Engine** and the Restart button ask first; Cancel does nothing.
- [ ] **New Session** asks first, then clears the chat with a new session.
- [ ] **Resume Previous Session** opens the Resume panel (also on a just-opened tab).
- [ ] **Log In** opens a terminal running `kiro-cli login`.
- [ ] **Attach Image or File** opens a picker; images attach, other files insert their path.

### Terminal chat
- [ ] **New Terminal Chat** and the Terminal "+" → **Kiro Chat** each open an independent chat.
- [ ] The prompt shows `N% >`, or `N% !>` with Autopilot.
- [ ] Each reply ends with `▸ Credits: … • Time: …`.
- [ ] `/` shows the menu; ↑/↓, Tab, Enter and Esc work; it fits narrow terminals.
- [ ] `/help` lists all commands; unknown `/foo` isn't sent to the model.
- [ ] Spot-check: `/context show`, `/compact`, `/usage`, `/model`, `/rewind` (asks first), `/title`, `/spawn`, `/resume`.
- [ ] `/remote` starts remote access and opens the pairing card in the editor (nothing secret in the terminal); `/remote link` opens a new card, `/remote stop` turns it off; `/remote on` and `/remote off` work too; `/remote x` prints the usage. With remote access failing (untrusted workspace), the terminal says there is no card instead of claiming it opened.
- [ ] Approvals take `y` / `n` / Tab (reason) / `t` (allow rule) / `d` (deny rule); rules are picked by number, Esc goes back. Compound lines name the command. Esc cancels a reply.
- [ ] A question from the agent shows numbered choices: a number, your own text, an empty line (recommended choice) and Esc (skip) all work. A choice with sub-options shows a checklist (number keys toggle, Enter sends, Esc goes back).
- [ ] `@file:path` attaches the file as in the webview chat.
- [ ] The folder rule's input is prefilled and editable (Backspace, Ctrl+U); an invalid folder prints the reason and asks again.

### Startup errors
- [ ] With an invalid `kiroCliPath`, the chat shows a clear error.
- [ ] Logged out (`kiro-cli logout`), the chat offers a login button.

### Untrusted workspaces
- [ ] Open a folder whose `.vscode/settings.json` sets `kiroChat.kiroCliPath` and `kiroChat.autopilot: true`. VS Code reports `kiroCliPath` as a machine setting that a workspace can't set; the chat uses the user-level path.
- [ ] Choose "Don't Trust" (Restricted Mode): the chat still works, and approvals are still asked (the workspace `autopilot` is ignored).

### Engine failures
- [ ] Set `kiroChat.kiroCliPath` to a file that doesn't exist → the chat says the setting points to a missing file.
- [ ] Start a long reply, then `pkill -f "kiro-cli-chat acp"` → the chat says the engine exited, leaves the busy state, and Restart works.
- [ ] Esc during a reply → the terminal footer shows "■ Cancelled".

## Windows 11 (PowerShell)

Windows support is best effort and has not been used on a real machine yet. Report anything that fails with the Output → Kiro Chat log. Needs `kiro-cli` installed with `irm 'https://cli.kiro.dev/install.ps1' | iex` and logged in.

- [ ] The extension finds `kiro-cli` without `kiroChat.kiroCliPath` (it uses `where`, then `%LOCALAPPDATA%\Kiro-Cli\kiro-cli.exe`). With `kiroChat.kiroCliPath` set to a `.cmd` file the chat says it must be the `.exe`.
- [ ] **Open Chat** starts the engine and shows the model list. A prompt gets a reply. `kiro-cli acp --agent-engine v3` is the first thing to check here: if the engine doesn't start, the Output log has its last messages.
- [ ] Logged out: the login button opens a terminal that runs `kiro-cli login` without a PowerShell error, also when the path has a space (`C:\Users\Jane Doe\…`). Try it in cmd and Git Bash as the default terminal as well.
- [ ] Approvals: Allow, Deny, a rule and a folder rule work (file changes show as `C:/…` or `src/…`; typing a folder as `src\sub` is accepted).
- [ ] Resume lists this folder's sessions (the folder is matched however the drive letter and slashes are written).
- [ ] `@file:src\a.ts`, `@file:~\notes.md` and a dragged image file attach.
- [ ] Terminal chat (**New Terminal Chat**): typing, `/` menu, Shift+Enter, Esc, an approval with `y`, `/restart`. `/paste` says images can't be pasted here.
- [ ] Remote access with Tailscale for Windows installed: the pairing card has a QR code and the phone opens the chat. Without Tailscale it says to install it.
- [ ] Closing a chat leaves no `kiro-cli.exe` running (Task Manager).
- [ ] The status bar tooltip says Ctrl+Alt+K and the shortcut opens the chat.
