/**
 * AI Usage — Hermes Desktop status bar chip (hybrid).
 *
 * Two data sources, chosen per-provider:
 *
 *  1. GATEWAY-NATIVE providers (Claude, Codex, Cursor, Kimi, OpenRouter, Nous)
 *     are read DIRECTLY from the gateway RPCs `account.usage` / `usage.bars`.
 *     No backend, no API keys, no .env — the gateway already holds their creds.
 *
 *  2. OPENCODE family (opencode-go, opencode-zen) has NO gateway RPC (the gateway
 *     treats them as generic inference relays). Their quota is fetched by the
 *     bundled Python backend (dashboard/plugin_api.py), which reads the key from
 *     .env and calls https://opencode.ai/zen/(go|zen)/v1/usage.
 *
 * The chip is session-aware: it reads the active session's provider from
 * host.state.model (or the focused session) and shows ONLY that provider.
 *
 * Install: copy this folder to ~/.hermes/desktop-plugins/opencode-usage/
 * (The Python backend is optional; without it, only gateway-native providers show.)
 */
import { host, Tip, cn } from '@hermes/plugin-sdk'
import { jsx, jsxs } from 'react/jsx-runtime'
import { useState, useEffect, useCallback, useMemo } from 'react'

const ID = 'opencode-usage'
const REFRESH_MS = 60000
let backendRest = null  // set in register() if a Python backend is mounted

// Which providers are read from the gateway RPCs (no backend needed).
const GATEWAY_PROVIDERS = {
  anthropic: { name: 'Claude', windows: [{ id: 'weekly', label: 'W' }, { id: 'monthly', label: 'M' }] },
  'openai-codex': { name: 'Codex', windows: [{ id: 'weekly', label: 'W' }, { id: 'monthly', label: 'M' }] },
  cursor: { name: 'Cursor', windows: [{ id: 'weekly', label: 'W' }, { id: 'monthly', label: 'M' }] },
  kimi: { name: 'Kimi', windows: [{ id: 'weekly', label: 'W' }, { id: 'monthly', label: 'M' }] },
  'kimi-coding': { name: 'Kimi', windows: [{ id: 'weekly', label: 'W' }, { id: 'monthly', label: 'M' }] },
  openrouter: { name: 'OpenRouter', windows: [{ id: 'daily', label: 'D' }, { id: 'monthly', label: 'M' }] },
  nous: { name: 'Nous Portal', windows: [{ id: 'monthly', label: 'M' }] },
}
// OpenCode family -> fetched via the Python backend.
const BACKEND_PROVIDERS = ['opencode-go', 'opencode-zen']

function formatPercent(val) {
  if (val == null || isNaN(val)) return '—'
  return Math.round(val) + '%'
}
function statusColor(percent) {
  if (percent == null) return 'var(--ui-text-quaternary)'
  if (percent >= 90) return '#ef4444'
  if (percent >= 70) return '#f59e0b'
  return '#22c55e'
}
function shortName(name) {
  if (!name) return '??'
  return name.split(' ').map(w => w[0]).join('')
}

// Derive provider id from the active session's model string or session info.
function providerFromModel(model) {
  if (!model || typeof model !== 'string') return null
  const slash = model.indexOf('/')
  return slash > 0 ? model.slice(0, slash) : null
}

function WindowBadge(props) {
  const { label, percent, resetsAt } = props
  const color = statusColor(percent)
  const tip = resetsAt
    ? label + ': ' + formatPercent(percent) + ' used — resets ' + new Date(resetsAt).toLocaleString()
    : label + ': ' + formatPercent(percent) + ' used'
  return jsx(Tip, {
    label: tip,
    children: jsx('span', {
      className: 'inline-flex items-center gap-0.5 text-[0.625rem] font-mono',
      children: [
        jsx('span', { className: 'text-(--ui-text-quaternary)', children: label }),
        jsx('span', { style: { color: color }, children: formatPercent(percent) }),
      ],
    }),
  })
}

function ProviderChip(props) {
  const { provider, windows, usage, error } = props
  if (error && !usage) {
    return jsx(Tip, {
      label: provider + ' — ' + error,
      children: jsx('span', { className: 'inline-flex items-center gap-0.5 text-[0.625rem] text-(--ui-text-quaternary)', children: shortName(provider) + ' ⚠' }),
    })
  }
  const badges = []
  for (let i = 0; i < windows.length; i++) {
    const w = windows[i]
    const data = usage && usage[w.id]
    if (i > 0) badges.push(jsx('span', { key: 's' + i, className: 'text-(--ui-text-quaternary)', children: '·' }))
    badges.push(jsx(WindowBadge, { key: w.id, label: w.label, percent: data && data.percent, resetsAt: data && data.resetsAt }))
  }
  return jsx(Tip, {
    label: provider + ' (' + windows.map(w => w.label).join(' / ') + ')',
    children: jsx('span', { className: 'inline-flex items-center gap-0.5 text-[0.625rem] font-mono', children: [
      jsx('span', { className: 'text-(--ui-text-quaternary) font-semibold', children: shortName(provider) }),
    ].concat(badges) }),
  })
}

// ---- Gateway-native fetch (Claude/Codex/Cursor/Kimi/OpenRouter/Nous) --------
function parseGatewaySnapshots(account, bars) {
  // account.usage -> { snapshots: [{ provider, windows: {id:{percent,resetsAt,status}} }] }
  // usage.bars    -> { plan_bar, topup_bar } (Nous)
  const out = {}
  const snaps = (account && account.snapshots) || []
  for (const s of snaps) {
    const pid = s.provider
    if (!pid) continue
    const wins = {}
    const ws = s.windows || {}
    for (const k of Object.keys(ws)) wins[k] = { status: ws[k].status || 'ok', percent: ws[k].percent, resetsAt: ws[k].resetsAt }
    out[pid] = wins
  }
  if (bars && (bars.plan_bar || bars.topup_bar)) {
    const nb = {}
    if (bars.plan_bar) nb.monthly = { status: 'ok', percent: bars.plan_bar.percent_used ?? bars.plan_bar.percent, resetsAt: bars.plan_bar.resets_at }
    if (bars.topup_bar) nb.topup = { status: 'ok', percent: bars.topup_bar.percent_used ?? bars.topup_bar.percent, resetsAt: bars.topup_bar.resets_at }
    out.nous = nb
  }
  return out
}

function UsageChip() {
  const [providerData, setProviderData] = useState(null)
  const [activeProvider, setActiveProvider] = useState(null)
  const [windows, setWindows] = useState([])
  const [error, setError] = useState(null)
  const restFn = useMemo(() => backendRest, [])

  // Detect active provider from the focused/active session.
  useEffect(() => {
    let cancelled = false
    const detect = () => {
      const sid = host.state.activeSessionId?.get?.() || host.state.focusedSessionId?.get?.()
      const model = host.state.model?.get?.()
      const pid = providerFromModel(model) || (sid ? null : null)
      if (!cancelled) setActiveProvider(pid || 'opencode-go') // default to opencode-go for this setup
    }
    detect()
    const t = setInterval(detect, 5000)
    return () => { cancelled = true; clearInterval(t) }
  }, [])

  const fetchGateway = useCallback(async (pid) => {
    const [acc, bars] = await Promise.all([
      host.request('account.usage', {}).catch(() => null),
      host.request('usage.bars', {}).catch(() => null),
    ])
    const parsed = parseGatewaySnapshots(acc, bars)
    return parsed[pid] ? { windows: GATEWAY_PROVIDERS[pid].windows, usage: parsed[pid] } : null
  }, [])

  const fetchBackend = useCallback(async (pid) => {
    if (!restFn) throw new Error('backend-unavailable')
    const resp = await restFn('/usage/' + pid, { method: 'GET', timeoutMs: 20000 })
    if (resp && resp.error) throw new Error(resp.error)
    return { windows: BACKEND_PROVIDERS.includes(pid) ? [{ id: 'rolling', label: '5h' }, { id: 'weekly', label: 'W' }, { id: 'monthly', label: 'M' }] : [], usage: resp.windows }
  }, [restFn])

  useEffect(() => {
    if (!activeProvider) return
    let cancelled = false
    const load = async () => {
      try {
        let result
        if (GATEWAY_PROVIDERS[activeProvider]) {
          result = await fetchGateway(activeProvider)
          if (!result) { setError('no-data'); setProviderData(null); return }
          setWindows(result.windows); setProviderData(result.usage); setError(null)
        } else if (BACKEND_PROVIDERS.includes(activeProvider)) {
          result = await fetchBackend(activeProvider)
          setWindows(result.windows); setProviderData(result.usage); setError(null)
        } else {
          setError('unsupported-provider'); setProviderData(null)
        }
      } catch (e) {
        if (cancelled) return
        setError(String(e.message || e))
        setProviderData(null)
      }
    }
    load()
    const timer = setInterval(load, REFRESH_MS)
    return () => { cancelled = true; clearInterval(timer) }
  }, [activeProvider, fetchGateway, fetchBackend])

  if (!activeProvider) return null
  const name = (GATEWAY_PROVIDERS[activeProvider] && GATEWAY_PROVIDERS[activeProvider].name) || activeProvider
  if (error && !providerData) {
    return jsx(Tip, {
      label: name + (error === 'backend-unavailable' ? ' — backend not enabled' : ' — ' + error),
      children: jsx('span', { className: 'inline-flex items-center gap-0.5 text-[0.625rem] text-(--ui-text-quaternary)', children: shortName(name) + ' ⚠' }),
    })
  }
  return jsx(ProviderChip, { provider: name, windows: windows, usage: providerData, error: error })
}

export default {
  id: ID,
  name: 'AI Usage',
  defaultEnabled: true,
  register(ctx) {
    if (ctx.rest) backendRest = ctx.rest.bind(ctx)
    ctx.register({
      id: 'chip',
      area: 'statusBar.right',
      order: 1000,
      render: () => jsx(UsageChip, {}),
    })
  },
}
