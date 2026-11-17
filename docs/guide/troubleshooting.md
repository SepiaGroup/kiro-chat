# Troubleshooting

[Guide index](README.md) · [Getting started](getting-started.md) · [Chat tabs](chat-tabs.md) · [Terminal chat](terminal-chat.md) · [Slash commands](slash-commands.md) · [Remote access](remote-access.md) · [Reference](reference.md) · [Troubleshooting](troubleshooting.md)

Logs are in **Output → Kiro Chat** (View → Output, then pick it from the
list). They show the kiro-cli path used, the engine detected and the engine's
own messages.

- **"Could not find the kiro-cli binary"**: install kiro-cli, or set
  `kiroChat.kiroCliPath` (user settings) to its full path. `which kiro-cli`
  in a terminal (`where kiro-cli` in PowerShell) shows where it is.
- **"kiroChat.kiroCliPath is set to …, which doesn't exist"**: fix or clear
  the setting.
- **Login card keeps coming back**: run `kiro-cli login` in a terminal, then
  click Retry. `kiro-cli whoami` shows whether you're logged in.
- **"No Kiro engine runs on this machine"**: run
  `kiro-cli chat --agent-engine v3` in a terminal. If that crashes with
  `illegal hardware instruction` (SIGILL), your kiro-cli version needs AVX even
  for the engine; try updating it.
- **"The Kiro engine sent nothing for 10m 0s"**: the engine never replied to
  your prompt, so the turn was cancelled. Send it again; use Restart if it
  keeps happening. A turn that goes quiet after it has started is not stopped
  (a build can take a while); the log notes it after 30 seconds.
- **"The Kiro engine didn't answer … within …s"**: the engine hung while
  starting. Use **Restart** (or `/restart` in a terminal chat); the log shows
  the engine's last messages.
- **A reply fails with "Not authenticated" or "Session expired"**: log in
  again (the Log In command, or `/login` in the terminal chat), then send the
  message again. Network and session errors say what to try.
- **A red "busy" or rate-limit line during a reply**: the engine is short of
  capacity and retries; the reply carries on.
- **Engine exited**: the chat says so. Restart starts a new engine; Resume
  reopens the conversation.

Still stuck? Open an issue at
[github.com/SepiaGroup/kiro-chat/issues](https://github.com/SepiaGroup/kiro-chat/issues)
with the Output → Kiro Chat log.
