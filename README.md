# codex-telegram-bridge

Telegram bridge for local Codex sessions. It sends one Telegram message when Codex needs a decision or when a turn stops, includes the thread title and summary, and lets you continue a stopped thread from your phone.

This project does not implement command approval. If Codex asks for command/file approval, the bridge will not expose an approve button in Telegram.

## Install

```sh
npm install -g github:antoinegg1/codex-telegram-bridge
```

Set the bot token and the one Telegram chat that may control Codex:

```sh
export CODEX_TG_BOT_TOKEN="123456:token"
export CODEX_TG_CHAT_ID="123456789"
```

PowerShell:

```powershell
[Environment]::SetEnvironmentVariable("CODEX_TG_BOT_TOKEN", "123456:token", "User")
[Environment]::SetEnvironmentVariable("CODEX_TG_CHAT_ID", "123456789", "User")
```

Optional:

```sh
export CODEX_TG_TIMEOUT_SECONDS=900
export CODEX_CLI_PATH=/absolute/path/to/codex
```

`CODEX_TG_CHAT_IDS` may be used instead of `CODEX_TG_CHAT_ID` for a comma-separated allow-list.

## Configure Codex hooks

```sh
codex-telegram-bridge install-codex-hooks
```

The installer:

- backs up `~/.codex/config.toml`
- sets Codex `notify` to call `codex-telegram-bridge hook notify`
- enables Codex hooks
- appends a marked global instruction block to `~/.codex/AGENTS.md`
- removes legacy Telegram approval hooks that call the old PowerShell scripts, when found

## Run

```sh
codex-telegram-bridge run
```

The bridge uses Telegram long polling, so no public webhook URL is needed.

## Telegram commands

- `/help` shows commands.
- `/threads` lists recent/active Codex threads.
- `/status` shows the selected thread state.

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
