/**
 * OpenCode Go Usage — Hermes Desktop status bar chip.
 *
 * Shows the ACTIVE session's AI provider usage in the status bar.
 * Session-aware by construction: it reads the focused/active session's
 * own `/usage` output, so the chip always reflects the provider you are
 * currently using — switch sessions and it follows.
 *
 * No API keys, no .env, no Python backend. All data comes from the same
 * gateway RPCs Hermes already uses for usage display:
 *   - slash.exec { command: 'usage', session_id }   (session-scoped)
 *   - account.usage                                 (signed-in vendors)
 *   - usage.bars                                   (Nous Portal)
 *
 * Extensible: add an entry to PROVIDERS to give any vendor a friendly
 * name and status-bar code. Window limits are NOT hardcoded — they are
 * read from the parsed usage data, so a provider can declare any number
 * of windows (rolling / weekly / monthly / custom) and the chip adapts.
 */
import * as sdk from '@hermes/plugin-sdk'
import { jsx, jsxs } from 'react/jsx-runtime'
import { useState, useEffect, useCallback, useMemo } from 'react'

const PLUGIN_ID = 'opencode-usage'
const REFRESH_MS = 60000

const host = sdk.host
const { useValue, Tip, cn } = sdk

// --- Provider registry (extensible) ------------------------------------
// match: substrings used to recognise this vendor in usage text / snapshots.
// Windows come from the parsed data, not from here — add a vendor and the
// chip automatically shows whatever limits that vendor reports.
const PROVIDERS = [
  { id: 'opencode-go', name: 'OpenCode Go', short: 'OC', match: ['opencode', 'opencode go', 'opencode-go'] },
  { id: 'nous', name: 'Nous Portal', short: 'NS', match: ['nous'] },
  { id: 'anthropic', name: 'Claude', short: 'CL', match: ['anthropic', 'claude'] },
  { id: 'openai-codex', name: 'Codex', short: 'CX', match: ['codex', 'openai-codex'] },
  { id: 'cursor', name: 'Cursor', short: 'CU', match: ['cursor'] },
  { id: 'kimi', name: 'Kimi', short: 'KI', match: ['kimi'] },
  { id: 'openrouter', name: 'OpenRouter', short: 'OR', match: ['openrouter'] },
]

function findProvider(label) {
  const l = String(label || '').toLowerCase()
  return PROVIDERS.find(p => p.match.some(m => l.includes(m))) || null
}

function shortCode(name) {
  const p = PROVIDERS.find(x => x.name.toLowerCase() === String(name).toLowerCase())
  return p ? p.short : String(name || '??').split(' ').map(w => w[0]).join('').slice(0, 2)
}

// --- Helpers -----------------------------------------------------------
function clampPct(n) {
  const v = Number(n)
  if (!Number.isFinite(v)) return null
  return Math.max(0, Math.min(100, Math.round(v)))
}

function statusColor(used) {
  if (used == null) return 'var(--ui-text-quaternary)'
  if (used >= 90) return 'var(--ui-red)'
  if (used >= 70) return 'var(--ui-yellow)'
  return 'var(--ui-green)'
}

// Normalise a raw window label to a compact status-bar token.
function windowLabel(raw) {
  const l = String(raw || '').toLowerCase()
  if (/(roll|5h|hour|daily)/.test(l)) return '5h'
  if (/week/.test(l)) return 'W'
  if (/month/.test(l)) return 'M'
  return raw
}

// Parse one "Label: NN% used / remaining" line into a window.
function parseWindowLine(line) {
  let m = line.match(/^(.+?):\s*(\d+)%\s*remaining\s*\((\d+)%\s*used\)/i)
  if (m) return { label: windowLabel(m[1]), remaining: clampPct(m[2]), used: clampPct(m[3]) }
  m = line.match(/^(.+?):\s*(\d+)%\s*used\s*\((\d+)%\s*remaining\)/i)
  if (m) return { label: windowLabel(m[1]), used: clampPct(m[2]), remaining: clampPct(m[3]) }
  m = line.match(/^(.+?):\s*(\d+)%\s*used/i)
  if (m) return { label: windowLabel(m[1]), used: clampPct(m[2]), remaining: clampPct(100 - m[2]) }
  m = line.match(/^(.+?):\s*(\d+)%/i)
  if (m) return { label: windowLabel(m[1]), used: clampPct(m[2]), remaining: clampPct(100 - m[2]) }
  return null
}

function parseUsageText(text) {
  const windows = []
  for (const raw of String(text || '').split('\n')) {
    const line = raw.replace(/\*\*/g, '').replace(/^📈\s*/, '').trim()
    if (!line) continue
    if (/^(account limits|session (token )?usage|session info|rate limits|nous credits)\b/i.test(line)) continue
    const w = parseWindowLine(line)
    if (w && w.label) windows.push(w)
  }
  return windows
}

// --- Data fetch (session-aware) ----------------------------------------
async function fetchActiveUsage(sessionId) {
  const sid = sessionId || ''

  // 1. Session-scoped /usage — inherently the active provider.
  try {
    const r = await host.request('slash.exec', { command: 'usage', session_id: sid })
    const text = (r && typeof r.output === 'string') ? r.output : ''
    const windows = parseUsageText(text)
    if (windows.length) {
      const prov = findProvider(text) || { name: 'OpenCode Go', short: 'OC' }
      return { provider: prov, windows }
    }
  } catch (e) { /* fall through */ }

  // 2. account.usage snapshots (all signed-in vendors).
  try {
    const acc = await host.request('account.usage', {})
    const snaps = (acc && acc.snapshots) || []
    for (const snap of snaps) {
      const prov = findProvider(snap.provider)
      if (!prov) continue
      const wins = (snap.windows || []).map(w => ({
        label: windowLabel(w.label || ''),
        used: clampPct(w.used_percent != null ? w.used_percent : w.used),
        remaining: clampPct(w.remaining_percent != null ? w.remaining_percent : w.remaining),
      })).filter(w => w.label)
      if (wins.length) return { provider: prov, windows: wins }
    }
  } catch (e) { /* fall through */ }

  // 3. Nous Portal bars.
  try {
    const bars = await host.request('usage.bars', {})
    if (bars && bars.available !== false) {
      const wins = []
      const push = (bar, label) => {
        if (!bar) return
        const used = clampPct(bar.pct_used)
        if (used != null) wins.push({ label, used, remaining: clampPct(100 - used) })
      }
      push(bars.plan_bar, 'Sub')
      if (bars.has_topup) push(bars.topup_bar, 'Top-up')
      if (wins.length) return { provider: { name: 'Nous Portal', short: 'NS' }, windows: wins }
    }
  } catch (e) { /* ignore */ }

  return null
}

// --- Components --------------------------------------------------------
function WindowBadge({ label, used }) {
  const color = statusColor(used)
  const tip = `${label}: ${used == null ? '—' : used + '% used'}`
  return jsx(Tip, {
    label: tip,
    children: jsx('span', {
      className: 'inline-flex items-center gap-0.5 text-[0.625rem] font-mono',
      children: [
        jsx('span', { className: 'text-(--ui-text-quaternary)', children: label }),
        jsx('span', { style: { color }, children: used == null ? '—' : used + '%' }),
      ],
    }),
  })
}

function Chip() {
  const focusedSid = useValue(host.state.focusedSessionId)
  const activeSid = useValue(host.state.activeSessionId)
  const sid = useMemo(() => focusedSid || activeSid || '', [focusedSid, activeSid])

  const [data, setData] = useState(null)
  const [error, setError] = useState(null)

  const load = useCallback(async () => {
    const id = focusedSid || activeSid || ''
    if (!id) { setData(null); setError(null); return }
    try {
      const result = await fetchActiveUsage(id)
      if (result && result.windows.length) { setData(result); setError(null) }
      else { setData(null); setError('no-data') }
    } catch (e) {
      setData(null); setError('connection-failed')
    }
  }, [focusedSid, activeSid])

  useEffect(() => {
    load()
    const t = setInterval(load, REFRESH_MS)
    return () => clearInterval(t)
  }, [load])

  if (error && !data) {
    const label = error === 'connection-failed' ? 'connection failed' : 'no usage data'
    return jsx(Tip, {
      label: 'OpenCode usage — ' + label,
      children: jsx('span', {
        className: 'inline-flex items-center px-1.5 text-[0.625rem] text-(--ui-text-quaternary)',
        children: 'OC ⚠',
      }),
    })
  }
  if (!data) return null

  const { provider, windows } = data
  const code = provider.short || shortCode(provider.name)
  const badges = []
  windows.forEach((w, i) => {
    if (i > 0) badges.push(jsx('span', { key: 's' + i, className: 'text-(--ui-text-quaternary)', children: '·' }))
    badges.push(jsx(WindowBadge, { key: w.label + i, label: w.label, used: w.used }))
  })
  return jsx(Tip, {
    label: provider.name + ' usage',
    children: jsx('span', {
      className: 'inline-flex items-center gap-0.5 text-[0.625rem] font-mono',
      children: [
        jsx('span', { className: 'text-(--ui-text-quaternary) font-semibold', children: code }),
      ].concat(badges),
    }),
  })
}

export default {
  id: PLUGIN_ID,
  name: 'OpenCode Go Usage',
  description: 'Shows the active session AI provider usage in the status bar.',
  defaultEnabled: true,
  register(ctx) {
    ctx.register({
      id: 'chip',
      area: 'statusBar.right',
      order: 90,
      render: () => jsx(Chip, {}),
    })
  },
}
