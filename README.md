# opencode-usage

A [Hermes Agent](https://github.com/NousResearch/hermes-agent) desktop plugin that shows your **active session's AI provider usage** in the status bar.

```
OC 5h 39% · W 15% · M 13%
```

- **Session-aware** — reads the focused/active session's own `/usage` output, so the chip always reflects the provider you are currently using. Switch sessions and it follows.
- **No secrets** — uses the same gateway RPCs Hermes already owns (`slash.exec 'usage'`, `account.usage`, `usage.bars`). No API keys, no `.env`, no Python backend.
- **Flexible windows** — a provider can report any number of limits (rolling / weekly / monthly / custom); the chip renders exactly what the data contains. Colour-coded green → amber → red as usage climbs.
- **Extensible** — add a vendor to the `PROVIDERS` registry in `plugin.js` to give it a friendly name and a status-bar code.

## Install

Copy the plugin folder into your Hermes desktop plugins directory:

```bash
git clone https://github.com/meviusisback/opencode-usage.git /tmp/opencode-usage
mkdir -p ~/.hermes/desktop-plugins
cp -r /tmp/opencode-usage/desktop-plugins/opencode-usage ~/.hermes/desktop-plugins/
```

The desktop app hot-reloads within seconds. If it does not appear, run **"Reload desktop plugins"** from the command palette (⌘K).

> Requirements: you must be signed into the provider you want to track (e.g. OpenCode Go). The plugin only reads usage Hermes can already see.

## How it works

```
┌─────────────────────────────────────────────────────────────────┐
│ Status bar chip (desktop/plugin.js)                              │
│                                                                 │
│  1. Reads active session id from host.state                     │
│  2. Calls gateway RPCs (no keys, no network egress):            │
│       slash.exec { command:'usage', session_id }  ← primary    │
│       account.usage                              ← fallback     │
│       usage.bars                                ← Nous fallback │
│  3. Parses the returned windows (rolling/weekly/monthly/...)    │
│  4. Renders "CODE label% · label% · ..." with colour coding     │
└─────────────────────────────────────────────────────────────────┘
```

All calls go through the desktop plugin SDK (`host.request` JSON-RPC) to the
gateway that is already running on your machine. Nothing leaves the device
except the same usage calls those providers already make for you.

## Architecture

This is a **single-file desktop plugin** — there is no Python backend.

```
opencode-usage/
├── README.md
├── LICENSE
└── desktop-plugins/
    └── opencode-usage/
        ├── plugin.js      ← the entire plugin (UI + data fetch + parsers)
        └── plugin.yaml    ← manifest (name, label, version)
```

Earlier versions shipped a Python backend that proxied the OpenCode API with
a key read from `.env`. That was unnecessary: the gateway already exposes the
same usage data through first-party RPCs, so the current plugin is pure
front-end and needs no configuration, no credential files, and no backend
process.

## Adding a provider

Open `desktop-plugins/opencode-usage/plugin.js` and add an entry to
`PROVIDERS`:

```js
{ id: 'github-copilot', name: 'GitHub Copilot', short: 'GH', match: ['copilot', 'github copilot'] },
```

The `match` substrings are used to recognise the vendor in usage text and
`account.usage` snapshots. Window limits are read from the data, so nothing
else needs to change.

## Updating

```bash
rm -rf ~/.hermes/desktop-plugins/opencode-usage
cp -r /tmp/opencode-usage/desktop-plugins/opencode-usage ~/.hermes/desktop-plugins/
```

Then **"Reload desktop plugins"** (⌘K).

## License

MIT
