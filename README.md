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
  Browser  <— WebSocket —>  agent-well  <— stdio JSON-RPC —>  ACP Agent
                            (localhost)                       (subprocess)
```

## Features

- Multi-agent registry (Claude / Codex / Gemini / Goose / Qwen / etc.)
- Streaming chat with collapsible tool calls, agent thoughts, diffs, plans
- Permission requests surfaced as modal dialogs
- Filesystem read/write on behalf of the agent (`fs/read_text_file`,
  `fs/write_text_file`)
- Full terminal lifecycle (`terminal/create`, `output`, `wait_for_exit`,
  `kill`, `release`)
- Session resume (for agents that advertise the `loadSession` capability)
- Session persistence under `~/.agent-well/sessions/`
- Localhost-only binding (`127.0.0.1`) + per-launch token in the URL

## Install

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

`npm start` also spawns `ngrok http --url=$AGENT_WELL_NGROK_URL 7777`
(default `oleh.ngrok.io`) so the QR points at a public tunnel — you can
scan it from any phone, anywhere. ngrok must be installed and
authenticated locally. Set `AGENT_WELL_NGROK_URL=` (empty) to skip the
tunnel and fall back to the LAN URL.

The server prints a QR code plus the relevant URLs:

```
  Scan with your phone (or open on this machine):

    <QR code rendered in the terminal>

  Tunnel: https://oleh.ngrok.io/?token=<launch-token>
  Local:  http://127.0.0.1:7777/?token=<launch-token>
  LAN:    http://192.168.x.y:7777/?token=<launch-token>
```

Open one of the URLs (or scan the QR from your phone). Click **+ New**,
pick an agent and working directory, and start chatting.

## Configuration

- `AGENT_WELL_NGROK_URL` — ngrok reserved hostname (default
  `oleh.ngrok.io`). Set to empty to disable the tunnel.
- `AGENT_WELL_HOST` — bind host (default `0.0.0.0` so phones on your
  LAN can reach the server). Set to `127.0.0.1` to restrict to the
  local machine.
- `AGENT_WELL_PORT` — port to bind (default `7777`).
- `AGENT_WELL_LOG` — `debug` | `info` | `warn` | `error` (default `info`).

## Notes

- The server binds to `0.0.0.0` by default so other devices on your LAN
  (e.g., your phone) can connect. The 192-bit per-launch token in the
  URL is the security boundary: anyone who has the URL can drive the
  agent on your machine, so don't share it. Set `AGENT_WELL_HOST=127.0.0.1`
  if you only want loopback access.
- All file paths in ACP are absolute. The fs handlers refuse relative
  paths.
- Session transcripts are written to `~/.agent-well/sessions/<id>.json`.
  Delete them to forget a session.
