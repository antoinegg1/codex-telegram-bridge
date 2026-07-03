# codex-telegram-bridge

Telegram bridge for local Codex sessions. It sends one Telegram message when Codex needs a decision or when a turn stops, includes the thread title and summary, and lets you continue a stopped thread from your phone.

This project does not implement command approval. If Codex asks for command/file approval, the bridge will not expose an approve button in Telegram.

## Complete Setup

### 1. Install dependencies

You need:

- Node.js 20 or newer, with npm
- Codex CLI installed and usable from a terminal
- A Telegram bot token from BotFather

Check the local tools:

```sh
node --version
npm --version
codex --version
```

If `codex` is not on `PATH`, set `CODEX_CLI_PATH` later to the absolute path of your Codex executable.

### 2. Install the bridge

```sh
npm install -g https://github.com/antoinegg1/codex-telegram-bridge/archive/refs/heads/main.tar.gz
```

Confirm the command is available:

```sh
codex-telegram-bridge --help
```

### 3. Create a Telegram bot and set the token

In Telegram, open `@BotFather`, run `/newbot`, and copy the bot token. Keep it secret and never commit it to Git.

macOS/Linux:

```sh
export CODEX_TG_BOT_TOKEN="123456:token"
```

Add the same export to your shell profile, such as `~/.zshrc` or `~/.bashrc`, if you want it to persist.

Windows PowerShell:

```powershell
$env:CODEX_TG_BOT_TOKEN = "123456:token"
[Environment]::SetEnvironmentVariable("CODEX_TG_BOT_TOKEN", $env:CODEX_TG_BOT_TOKEN, "User")
```

### 4. Discover and set your Telegram chat id

Send any message to your new bot in Telegram, then run:

```sh
codex-telegram-bridge chat-id
```

The command waits up to 60 seconds and prints your `CODEX_TG_CHAT_ID`.

macOS/Linux:

```sh
export CODEX_TG_CHAT_ID="123456789"
```

Add the same export to your shell profile if you want it to persist.

Windows PowerShell:

```powershell
$env:CODEX_TG_CHAT_ID = "123456789"
[Environment]::SetEnvironmentVariable("CODEX_TG_CHAT_ID", $env:CODEX_TG_CHAT_ID, "User")
```

Use the value printed by `codex-telegram-bridge chat-id`; `123456789` is only an example. Close and reopen terminals after setting permanent Windows user environment variables, or keep the `$env:` values in the current terminal.

### 5. Optional configuration

Optional:

```sh
export CODEX_TG_TIMEOUT_SECONDS=900
export CODEX_CLI_PATH=/absolute/path/to/codex
```

Windows PowerShell:

```powershell
$env:CODEX_TG_TIMEOUT_SECONDS = "900"
$env:CODEX_CLI_PATH = "C:\absolute\path\to\codex.exe"
[Environment]::SetEnvironmentVariable("CODEX_TG_TIMEOUT_SECONDS", $env:CODEX_TG_TIMEOUT_SECONDS, "User")
[Environment]::SetEnvironmentVariable("CODEX_CLI_PATH", $env:CODEX_CLI_PATH, "User")
```

If `codex-telegram-bridge run` prints `fetch failed` while Telegram works in your browser or PowerShell, Node is probably not using your system proxy. Set Node's environment proxy support:

```sh
export HTTPS_PROXY=http://127.0.0.1:7890
export HTTP_PROXY=http://127.0.0.1:7890
export NODE_USE_ENV_PROXY=1
```

PowerShell:

```powershell
[Environment]::SetEnvironmentVariable("HTTPS_PROXY", "http://127.0.0.1:7890", "User")
[Environment]::SetEnvironmentVariable("HTTP_PROXY", "http://127.0.0.1:7890", "User")
[Environment]::SetEnvironmentVariable("NODE_USE_ENV_PROXY", "1", "User")
```

`CODEX_TG_CHAT_IDS` may be used instead of `CODEX_TG_CHAT_ID` for a comma-separated allow-list.

### 6. Configure Codex hooks

```sh
codex-telegram-bridge install-codex-hooks
```

The installer:

- backs up `~/.codex/config.toml`
- sets Codex `notify` to call `codex-telegram-bridge hook notify`
- enables Codex hooks
- appends a marked global instruction block to `~/.codex/AGENTS.md`
- removes legacy Telegram approval hooks that call the old PowerShell scripts, when found

### 7. Verify and start

```sh
codex-telegram-bridge doctor
codex-telegram-bridge run
```

The bridge uses Telegram long polling, so no public webhook URL is needed.

Leave `codex-telegram-bridge run` running while you want Telegram notifications and replies to work. Start it again on each machine where you want the bridge active.

## Telegram commands

- `/help` shows commands.
- `/threads` lists recent/active Codex threads.
- `/status` shows the selected thread without resuming it: title, status flags, thread id, working directory, continuable state, turn id, pending decision count and timeout, current question, and latest summary when available.

Every bridge notification includes inline buttons. Select a thread from a message, then send a plain text reply to continue it if it is stopped or idle. Plain text replies are rejected while the selected thread is actively running.

## Phone notifications

Telegram notification filtering is configured on the phone. To allow this bot to notify you while muting other chats, keep notifications enabled for this bot chat and mute other chats or groups in Telegram mobile settings.

## Local state and logs

The bridge keeps local logs and state outside the repo:

- Windows: `%APPDATA%/codex-telegram-bridge`
- macOS: `~/Library/Application Support/codex-telegram-bridge`
- Linux: `$XDG_STATE_HOME/codex-telegram-bridge` or `~/.local/state/codex-telegram-bridge`

Logs may include Telegram message text and Codex summaries. Bot tokens are not written by the bridge.

## Security

- Keep `CODEX_TG_BOT_TOKEN` secret.
- Only configured chat IDs may control Codex.
- Do not commit `.env`, logs, or local state.
- The bridge does not publish or upload logs.
