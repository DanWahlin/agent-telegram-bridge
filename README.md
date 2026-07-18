# Grok Build Telegram Bridge

<p align="center">
  <img src="images/logo.webp" alt="Grok Build Telegram logo" width="400">
</p>

Run an xAI Grok Build coding-agent session from a private Telegram chat. The bridge uses the official [Agent Client Protocol (ACP)](https://agentclientprotocol.com) over `grok agent --model grok-4.5 stdio`; it does not expose an inbound HTTP server or Telegram webhook.

## Features

- **Secure by default**: private chats only, one numeric Telegram owner, expiring attempt-limited pairing codes, and atomic owner-only state files.
- **Multimodal prompts**: text, photos, documents, voice, and video are downloaded into a restricted inbox under the session CWD and sent as ACP content blocks (image/audio/resource when the agent advertises those capabilities; otherwise `resource_link` + on-disk path).
- **Artifact delivery**: eligible paths explicitly returned by successfully completed tools are sent back via `sendPhoto` / `sendDocument`. Paths are revalidated against the active session CWD at send time; hidden, credential-like, oversized, and out-of-root files are refused.
- **Prompt queue**: text follow-ups while ACP is busy are queued in memory (default depth 3) instead of hard-rejected. The queue is intentionally volatile across restarts; media follow-ups must wait for the active prompt.
- **Interactive permissions**: choose **Allow once**, **Allow for session**, or the reject options offered by ACP. Resolved cards are replaced with their final status, and expired cards lose their buttons. Permissions are never approved automatically unless `GROK_ALWAYS_APPROVE=true` (which prefers the session-scoped option).
- **Streaming responses**: throttled draft edits, ordered multi-message final responses, typing indicators, tool-progress bubbles, progress notices, plan cards, optional thought stream (`/verbose`), and stall recovery buttons.
- **Single-poller protection**: a PID, hostname, process-start token, and heartbeat lock prevent competing bridge instances.
- **Operational visibility**: `/status` and `health.json` report session, prompt, permission, queue, cwd, usage, and tool activity.
- **Secret isolation**: the Telegram token is not passed to the Grok subprocess, and sensitive values are redacted from permission summaries and logs.

## Requirements

- Node.js 24 or later
- A locally installed and authenticated Grok CLI with access to the `grok-4.5` model
- A Telegram bot token from [@BotFather](https://t.me/BotFather)

## Quick start

1. Clone the repository and install dependencies:

   ```bash
   git clone https://github.com/DanWahlin/grok-build-telegram.git
   cd grok-build-telegram
   npm install
   cp .env.example .env
   ```

2. Edit `.env`:

   ```dotenv
   TELEGRAM_BOT_TOKEN=your-bot-token
   GROK_CWD=/absolute/path/to/the/project
   ```

   `GROK_CWD` is the directory the Grok agent can inspect and modify. Use the narrowest practical project directory.

3. Start the bridge in development mode:

   ```bash
   npm run start:dev
   ```

4. Open a private chat with the bot and send a message. The one-time pairing code appears only in the bridge terminal. Send that code to the bot within five minutes.

5. Send a text prompt, photo, or document. The bridge keeps one persistent ACP session and processes one prompt at a time (with optional Telegram-side queue).

### Production start

Build the TypeScript output and run the compiled entry point:

```bash
npm run build
npm start
```

Run only one bridge process for a bot token. Use a process supervisor if the bridge must restart automatically.

## Telegram commands

| Command | Behavior |
| --- | --- |
| `/start`, `/help` | Show usage and pairing guidance |
| `/status` | Bridge, ACP, queue, cwd, usage, and activity status |
| `/new` | Stop the current Grok subprocess, clear queued prompts, and create a fresh ACP session |
| `/cancel` | Cancel the active ACP prompt (waits for idle) |
| `/cancel queue` | Cancel active prompt if any, and clear the follow-up queue |
| `/retry last` | Re-send the last final response and artifacts (no agent re-run) |
| `/verbose on\|off` | Toggle ACP thought-stream visibility |
| `/cwd` | List allowlisted working directories |
| `/cwd <n\|path>` | Switch CWD (allowlist only) and restart the ACP session |

Any other message text is forwarded as a prompt (including Grok slash-style text such as planning requests).

## Configuration

Copy `.env.example` to `.env`. Primary settings:

| Variable | Default | Purpose |
| --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | Required | Token issued by @BotFather |
| `GROK_CWD` | Current directory | Working directory available to Grok |
| `GROK_CWD_ALLOWLIST` | (primary only) | Comma-separated paths allowed for `/cwd` |
| `GROK_BIN` | `grok` | Grok executable path; common user locations are also detected |
| `GROK_MODEL` | `grok-4.5` | Model passed to `grok agent` |
| `STATE_DIR` | `./.grok-telegram-state` | Directory for access, lock, and health state |
| `GROK_ALWAYS_APPROVE` | `false` | Auto-approve ACP permissions (prefers the session-scoped option) |
| `MEDIA_MAX_BYTES` | `20971520` | Max attachment size (20 MiB) |
| `MEDIA_MIME_ALLOWLIST` | images/audio/video/pdf/text… | Comma-separated MIME allowlist |
| `PROMPT_QUEUE_MAX` | `3` | Follow-up queue depth while busy (`0` = reject) |
| `CANCEL_WAIT_MS` | `15000` | Wait for ACP idle after cancel |
| `RETRY_LAST_TTL_MS` | `1800000` | How long `/retry last` keeps the last response |
| `PROGRESS_NOTICE_AFTER_MS` | `90000` | First “still working” notice (mobile-friendly default) |
| `VERBOSE_DEFAULT` | `false` | Start with thought stream enabled |

`.env.example` documents all optional timing controls for pairing, permissions, streaming, typing, progress notices, health writes, API calls, and outbound pacing.

## How it works

```mermaid
flowchart LR
    telegram["Private Telegram message<br/>text / photo / file"] --> gate{"Authorized owner?"}
    gate -- No --> rejected["Reject or pair"]
    gate -- Yes --> busy{"Active ACP prompt?"}
    busy -- Yes --> queue["Telegram-side queue"]
    busy -- No --> acp["Persistent Grok ACP session<br/>ContentBlock prompt"]
    queue --> acp
    acp -- Text chunks --> response["Draft edits and final messages"]
    acp -- Artifacts under CWD --> mediaOut["sendPhoto / sendDocument"]
    acp -- Tool updates --> bubble["Tool-progress bubble"]
    acp -- Plan / thoughts --> cards["Plan card · optional thoughts"]
    acp -- Permission request --> permission["Owner-bound once/session/reject"]
    permission -- Decision --> acp
```

- `grammY` long-polls Telegram. No webhook endpoint is opened.
- Prompts are serialized to ACP. Follow-ups enqueue on the Telegram side.
- Attachments land in `<CWD>/.tg-inbox/` (mode `0700`/`0600`) and are deleted after the prompt finishes.
- Assistant output is HTML-escaped, rendered from a limited Markdown subset, and split at Telegram's message limit.
- Tool and permission controls are sent only to the authorized chat that owns the active prompt.
- Outbound Telegram operations share one paced queue with retry handling for rate limits.

## Runtime state

The bridge creates these files under `STATE_DIR`:

| File | Contents |
| --- | --- |
| `access.json` | Authorized user ID and temporary pairing state |
| `lock.json` | Single-poller ownership and heartbeat |
| `health.json` | Current bridge, Telegram, ACP, prompt, and permission status |

The state directory is forced to mode `0700` and state files to `0600`. Do not commit or share them.

Inbox files for media live under `<session CWD>/.tg-inbox/` (not `STATE_DIR`).

## Security model and limitations

- The first successfully paired Telegram user becomes the only owner. Pairing closes after that.
- Commands, prompts, callbacks, and permission decisions are accepted only from the owner in a private chat.
- Pairing codes expire and allow at most five attempts.
- The Grok subprocess receives an explicit environment allowlist and never receives `TELEGRAM_BOT_TOKEN`.
- ACP permission decisions are bound to the active request, owner, and chat.
- `GROK_ALWAYS_APPROVE=true` removes the interactive safety boundary. Leave it disabled unless the agent and working directory are fully trusted.
- Media ingress enforces MIME allowlist and size caps; paths outside the active session CWD selected from `GROK_CWD` / `GROK_CWD_ALLOWLIST` are never sent as artifacts.
- One bridge supports one owner, one Grok subprocess, and one active ACP prompt at a time.
- Use a least-privilege operating-system account and a narrowly scoped `GROK_CWD`.
- `/cwd` can only switch among `GROK_CWD` and `GROK_CWD_ALLOWLIST` paths that exist on disk.

## Troubleshooting

**The bot reports another poller or exits with a conflict**

Another process is using the same bot token. Stop the other process before restarting this bridge. Do not delete `lock.json` while a bridge process is still running.

**No pairing code appears in Telegram**

The code is intentionally printed only in the bridge terminal. Send any message to the bot in a private chat, then check the terminal output.

**Grok does not connect**

Confirm that `GROK_BIN` points to a working CLI, the CLI is already authenticated, `GROK_CWD` exists, and this command works locally:

```bash
grok agent --model grok-4.5 stdio
```

**A prompt appears stalled**

Use `/status` and inspect `STATE_DIR/health.json`. The watchdog reports inactivity after `PROMPT_STALE_AFTER_MS` and offers **Cancel** / **Keep waiting** buttons.

**Attachment rejected**

Check `MEDIA_MAX_BYTES` and `MEDIA_MIME_ALLOWLIST`. Oversized or disallowed MIME types are refused before ACP sees them.

**Final message missing after a long run**

If delivery failed, try `/retry last` within `RETRY_LAST_TTL_MS` to re-send the last stored response without re-running the agent.

## Development

```bash
npm run typecheck
npm run lint
npm test
npm run build
npm audit
```

Run the live ACP-only smoke test when a working Grok CLI is available:

```bash
npm run smoke
```

See [`AGENTS.md`](AGENTS.md) for repository structure, security invariants, testing guidance, and contributor expectations.

## License

[MIT](LICENSE)
