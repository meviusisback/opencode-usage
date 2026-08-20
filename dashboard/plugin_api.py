"""
OpenCode Usage — Python backend (OpenCode family only).

Why a backend is needed:
  The Hermes gateway exposes `account.usage` / `usage.bars` RPCs that already
  cover Claude, Codex, Cursor, Kimi, OpenRouter and Nous (it holds their
  credentials).  OpenCode Go / OpenCode Zen are *reseller relays* — the gateway
  treats them as generic OpenAI-compatible inference endpoints and never queries
  their quota endpoint.  So there is NO gateway RPC for OpenCode usage; the only
  path is the vendor API + the key from $HERMES_HOME/.env.

This backend ONLY handles the OpenCode family.  Every other provider is read
directly by the desktop plugin via the gateway RPCs (no backend, no keys).

Endpoints:
  GET /providers        -> [{id,name,key_env,windows:[...]}]
  GET /usage/<id>       -> {<window_id>: {status,percent,resetsAt}, ...}
  GET /usage            -> {<provider_id>: {...windows...}, ...}  (all enabled OC providers)

Security notes:
  - API keys are read from $HERMES_HOME/.env (0600). Never returned to the client.
  - All outbound errors are sanitized to a generic code (no headers/keys leaked).
  - TLS verification is enforced. Response size is capped.
"""
import os, json, ssl, stat, urllib.request, urllib.error, logging
from pathlib import Path

TIMEOUT_SECONDS = 15
MAX_RESPONSE_BYTES = 4096
MAX_ERROR_CHARS = 120

logging.basicConfig(level=logging.ERROR)
log = logging.getLogger("opencode_usage")

# --- Provider registry: add OpenCode-family providers here -------------------
PROVIDERS = [
    {
        "id": "opencode-go",
        "name": "OpenCode Go",
        "key_env": "OPENCODE_GO_API_KEY",
        "endpoint": "https://opencode.ai/zen/go/v1/usage",
        "windows": [
            {"id": "rolling", "label": "5h"},
            {"id": "weekly", "label": "W"},
            {"id": "monthly", "label": "M"},
        ],
    },
    {
        "id": "opencode-zen",
        "name": "OpenCode Zen",
        "key_env": "OPENCODE_ZEN_API_KEY",
        "endpoint": "https://opencode.ai/zen/v1/usage",
        "windows": [
            {"id": "rolling", "label": "5h"},
            {"id": "weekly", "label": "W"},
            {"id": "monthly", "label": "M"},
        ],
    },
]


def _ssl_context():
    ctx = ssl.create_default_context()
    ctx.check_hostname = True
    ctx.verify_mode = ssl.CERT_REQUIRED
    return ctx


def _load_env_keys():
    """Read API keys from $HERMES_HOME/.env (0600). Returns {ENV_VAR: value}."""
    hermes_home = Path(os.environ.get("HERMES_HOME", Path.home() / ".hermes"))
    env_path = hermes_home / ".env"
    keys = {}
    try:
        if not env_path.exists():
            return keys
        mode = stat.S_IMODE(env_path.stat().st_mode)
        if mode & 0o077:
            log.warning("Refusing to read world/group-readable .env (perms %o)", mode)
            return keys
        for line in env_path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, _, v = line.partition("=")
            keys[k.strip()] = v.strip().strip('"').strip("'")
    except Exception:
        log.exception("Failed reading .env")
    return keys


def normalize_status(raw):
    if raw is None:
        return "ok"
    r = str(raw).lower()
    if r in ("ok", "active", "good", "normal"):
        return "ok"
    if r in ("warn", "warning", "near_limit"):
        return "warn"
    if r in ("exceeded", "exhausted", "blocked", "limit_reached", "over"):
        return "exceeded"
    return "ok"


def fetch_provider(provider):
    """Fetch one provider's usage. Returns (data_dict, error_or_None)."""
    keys = _load_env_keys()
    api_key = keys.get(provider["key_env"])
    if not api_key:
        return None, "missing-key"
    try:
        req = urllib.request.Request(
            provider["endpoint"],
            headers={"Authorization": f"Bearer {api_key}", "User-Agent": "hermes-opencode-usage/0.2"},
        )
        with urllib.request.urlopen(req, timeout=TIMEOUT_SECONDS, context=_ssl_context()) as resp:
            raw = resp.read(MAX_RESPONSE_BYTES)
        body = json.loads(raw)
        usage = body.get("usage", body)
        out = {}
        for w in provider["windows"]:
            node = usage.get(w["id"], {}) if isinstance(usage, dict) else {}
            out[w["id"]] = {
                "status": normalize_status(node.get("status")),
                "percent": node.get("percent"),
                "resetsAt": node.get("resetsAt"),
            }
        return out, None
    except urllib.error.HTTPError as e:
        if e.code in (401, 403):
            return None, "auth-failed"
        return None, "upstream-error"
    except urllib.error.URLError:
        return None, "network-error"
    except Exception:
        return None, "upstream-error"


def serialize(obj):
    import datetime
    import decimal
    import flask
    return flask.jsonify(obj)


def register(ctx):
    for p in PROVIDERS:
        pid = p["id"]

        def make_get_one(prov):
            def get_one():
                import flask
                data, err = fetch_provider(prov)
                if err:
                    return serialize({"error": err, "provider": prov["id"]}), 200
                return serialize({"provider": prov["id"], "windows": data}), 200
            return get_one

        ctx.route(f"/usage/{pid}", methods=["GET"])(make_get_one(p))

    def get_providers():
        import flask
        return serialize([{"id": p["id"], "name": p["name"], "windows": p["windows"]} for p in PROVIDERS]), 200

    def get_all():
        import flask
        out = {}
        for p in PROVIDERS:
            data, err = fetch_provider(p)
            out[p["id"]] = data if data is not None else {"error": err}
        return serialize(out), 200

    ctx.route("/providers", methods=["GET"])(get_providers)
    ctx.route("/usage", methods=["GET"])(get_all)
