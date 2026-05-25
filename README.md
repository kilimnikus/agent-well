# agent-well

A browser-based ACP client. Open a URL, pick an ACP-driven agent
(Claude Agent, Codex, Gemini CLI, Goose, Qwen, Auggie, Mistral Vibe,
Cursor, Factory Droid, Pi), and chat with it from any browser tab.
The agent runs as a subprocess on your local machine — agent-well is
the bridge.

This is roughly [`agent-shell`](https://github.com/xenodium/agent-shell)
for the browser, built on the
[Agent Client Protocol](https://agentclientprotocol.com).

```
  Browser  <— HTTP long-poll —>  agent-well  <— stdio JSON-RPC —>  ACP Agent
                                 (localhost)                       (subprocess)
```

## Features

- Multi-agent registry (Claude / Codex / Gemini / Goose / Qwen / etc.)
- Streaming chat with collapsible tool calls, agent thoughts, plans
- **Expandable edit rows** — `Edit`/`Write` tool calls auto-open with a
  side-by-side diff and a `+N −M` summary chip
- **Rich rendering** in agent output (driven by a per-session preamble the
  bridge prepends — see `src/bridge.ts:EMBED_PREAMBLE`):
  - Allowlisted media tags inline: `<audio>`, `<video>`, `<img>`
  - LaTeX math via KaTeX: `$inline$`, `$$display$$`, `\[…\]`, `\(…\)`
  - Standard markdown (headings, lists, code blocks, links)
- Permission requests surfaced as modal dialogs
- Filesystem read/write on behalf of the agent (`fs/read_text_file`,
  `fs/write_text_file`)
- Full terminal lifecycle (`terminal/create`, `output`, `wait_for_exit`,
  `kill`, `release`)
- Session resume (for agents that advertise the `loadSession` capability)
- Session persistence under `~/.agent-well/sessions/`
- Localhost-only binding (`127.0.0.1`) + per-launch token in the URL
- `ETag` + `Last-Modified` revalidation on static assets so a browser
  refresh always picks up the latest `public/` files

## Install

Requires Node ≥ 22.7 (for `--env-file-if-exists`).

```bash
npm install
npm run build
```

You'll also need the ACP wrapper for whichever agent(s) you want to use.
For Claude:

```bash
npm install -g @agentclientprotocol/claude-agent-acp
```

See `src/agents/registry.ts` for the install hint for each supported
agent.

## Run

```bash
npm start
```

`npm start` runs `node --env-file-if-exists=.env dist/index.js` and, by
default, spawns `ngrok http <port>` to expose the server over a public
tunnel. The QR points at that tunnel so you can scan it from any phone,
anywhere. ngrok must be installed and authenticated locally.

There are two tunnel modes, switched by `AGENT_WELL_NGROK_URL`:

- **Reserved hostname** — set in `.env`:

  ```ini
  # .env
  AGENT_WELL_NGROK_URL=your-reserved.ngrok.io
  ```

  agent-well runs `ngrok http --url=$AGENT_WELL_NGROK_URL <port>` so the
  hostname is stable across launches.

- **Ephemeral hostname (default)** — leave `AGENT_WELL_NGROK_URL` unset.
  agent-well runs `ngrok http <port>` and discovers the assigned hostname
  via ngrok's local inspector API (`http://127.0.0.1:4040/api/tunnels`).
  The hostname changes on every launch.

To skip ngrok entirely (LAN/localhost only), set
`AGENT_WELL_NGROK_DISABLE=1`.

The server prints a QR code plus the relevant URLs:

```
  Scan with your phone (or open on this machine):

    <QR code rendered in the terminal>

  Tunnel: https://your-reserved.ngrok.io/?token=<launch-token>
  Local:  http://127.0.0.1:7777/?token=<launch-token>
  LAN:    http://192.168.x.y:7777/?token=<launch-token>
```

Open one of the URLs (or scan the QR from your phone). Click **+ New**,
pick an agent and working directory, and start chatting.

### Session controls

- **Cancel** (visible only while the agent is busy) sends `session/cancel`
  to the ACP subprocess, stopping the current turn cleanly. Already-run
  side effects (edits, shell commands) are not undone.
- **Close** terminates the ACP subprocess and clears the session from
  memory; its transcript stays on disk.

## Configuration

All variables can be set in `.env` (loaded via `--env-file-if-exists=.env`)
or via the shell environment.

- `AGENT_WELL_NGROK_URL` — ngrok reserved hostname. Unset/empty falls
  back to an ephemeral hostname (discovered via ngrok's local API).
- `AGENT_WELL_NGROK_DISABLE` — set to `1` to skip ngrok entirely
  (LAN/localhost only).
- `NGROK_API_PORT` — port for ngrok's local inspector API used to
  discover the ephemeral hostname (default `4040`).
- `AGENT_WELL_HOST` — bind host (default `0.0.0.0` so phones on your
  LAN can reach the server). Set to `127.0.0.1` to restrict to the
  local machine.
- `AGENT_WELL_PORT` — port to bind (default `7777`).
- `AGENT_WELL_LOG` — `debug` | `info` | `warn` | `error` (default `info`).
  Known-benign stderr noise (e.g. `No onPostToolUseHook found …` from
  claude-agent-acp's TodoWrite path) is downgraded to `debug`.

## Notes

- Only Claude Agent and Pi have actually been exercised so far. The other
  agents are wired up via `src/agents/registry.ts` but untested — PRs with
  fixes, install hints, or new agents are very welcome.
- The server binds to `0.0.0.0` by default so other devices on your LAN
  (e.g., your phone) can connect. The 192-bit per-launch token in the
  URL is the security boundary: anyone who has the URL can drive the
  agent on your machine, so don't share it. Set `AGENT_WELL_HOST=127.0.0.1`
  if you only want loopback access.
- All file paths in ACP are absolute. The fs handlers refuse relative
  paths.
- Session transcripts are written to `~/.agent-well/sessions/<id>.json`.
  Delete them to forget a session.
