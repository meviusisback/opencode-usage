# opencode-usage

A [Hermes Agent](https://github.com/NousResearch/hermes-agent) desktop plugin that shows your **active session's AI provider usage** in the status bar.

```
OC 5h 39% · W 15% · M 13%   Claude W 62% · M 40%   Codex W 10%
```

Session-aware: it reads the focused session's provider and shows **only that provider**. Switch sessions and the chip follows.

## How it works (hybrid design)

Not all providers can be read the same way. This plugin uses two paths:

| Provider | Data source | Backend needed? |
|----------|-------------|-----------------|
| Claude, Codex, Cursor, Kimi, OpenRouter, Nous | Gateway RPCs `account.usage` / `usage.bars` (the gateway already holds their credentials) | **No** |
| OpenCode Go, OpenCode Zen | Bundled Python backend → `https://opencode.ai/zen/(go\|zen)/v1/usage` (key from `.env`) | **Yes** |

The gateway exposes a usage RPC for the first group but **not** for OpenCode (it treats OpenCode as a generic inference relay). So OpenCode is the only family that needs the Python backend + an API key.

## Install

```bash
# 1. Desktop plugin (the status bar chip) — works for Claude/Codex/etc. immediately
rm -rf ~/.hermes/desktop-plugins/opencode-usage
mkdir -p ~/.hermes/desktop-plugins/opencode-usage
cp desktop-plugins/opencode-usage/plugin.js ~/.hermes/desktop-plugins/opencode-usage/
cp desktop-plugins/opencode-usage/plugin.yaml ~/.hermes/desktop-plugins/opencode-usage/

# 2. (Optional) Python backend — only needed for OpenCode Go / Zen
#    Copy the full repo so plugin.yaml's `api:` points at dashboard/plugin_api.py
rm -rf ~/.hermes/plugins/opencode-usage
git clone --depth 1 https://github.com/meviusisback/opencode-usage.git ~/.hermes/plugins/opencode-usage
```

Then in Hermes Desktop: **⌘K → "Reload desktop plugins"**.

### Enabling the OpenCode backend

OpenCode needs the Python backend mounted **and** the API key present:

1. Make sure `~/.hermes/.env` contains `OPENCODE_GO_API_KEY=...` (and/or `OPENCODE_ZEN_API_KEY=...`).
2. Ensure `opencode-usage` is in `plugins.enabled` in `~/.hermes/config.yaml`:

   ```yaml
   plugins:
     enabled:
       - opencode-usage
   ```

3. **Quit and reopen Hermes Desktop** (the backend loads at startup, not on hot-reload).

Without the backend, gateway-native providers still work; OpenCode shows `OC ⚠` ("backend not enabled").

## Add a provider

- **Gateway-native** (Claude/Codex/... style): add an entry to `GATEWAY_PROVIDERS` in `plugin.js` with the window ids your provider returns.
- **OpenCode-family** (needs a key): add an entry to `PROVIDERS` in `dashboard/plugin_api.py` with `id`, `key_env`, `endpoint`, and `windows`.

## Security

- API keys are read only from `~/.hermes/.env` (must be `0600`). They are **never** sent to the client.
- All upstream errors are sanitized to a generic code (`auth-failed`, `network-error`, `upstream-error`).
- TLS verification is enforced; response size is capped at 4 KB.

## License

MIT
