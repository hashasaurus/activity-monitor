import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Activity, Ctx, Tokens } from '../types'

const PANE = 'activity-monitor'
const TITLE = 'Activity'
const KEEP = 300
const calls = atom({ plugin: 'activity-monitor', key: 'calls' } as const, [], { shape: 'calls-1' })
const totals = atom({ plugin: 'activity-monitor', key: 'totals' } as const, { in: 0, out: 0, cached: 0, steps: 0 }, {
  shape: 'totals-1',
})

const EMPTY_CTX: Ctx = { tokens: 0, lastAt: 0, ttlMs: 300_000 }
const ctx = atom({ plugin: 'activity-monitor', key: 'ctx' } as const, EMPTY_CTX, { shape: 'ctx-1' })
const now = atom({ plugin: 'activity-monitor', key: 'now' } as const, 0, { shape: 'now-1' })
const TTL_MS = { '5m': 300_000, '1h': 3_600_000 }
const scroll = atom({ plugin: 'activity-monitor', key: 'scroll' } as const, 0, { shape: 'scroll-1' })
const warming = atom({ plugin: 'activity-monitor', key: 'warming' } as const, false, { shape: 'warming-1' })
const compacting = atom({ plugin: 'activity-monitor', key: 'compacting' } as const, false, { shape: 'compacting-1' })
const picking = atom({ plugin: 'activity-monitor', key: 'picking' } as const, false, { shape: 'picking-1' })
// Whether the feed shows each call's target. null follows the showTargets setting
// until the header toggle is clicked in this session.
const targetsShown = atom({ plugin: 'activity-monitor', key: 'targetsShown' } as const, null as boolean | null, { shape: 'targets-1' })
const totalsShown = atom({ plugin: 'activity-monitor', key: 'totalsShown' } as const, true as boolean, { shape: 'totals-1' })
// Calls whose target was clicked open while targets are hidden.
const opened = atom({ plugin: 'activity-monitor', key: 'opened' } as const, [] as string[], { shape: 'opened-1' })
// What the picker offers when the engine's /config has no model row with choices:
// the aliases /model takes, each resolving to that family's latest model.
const MODEL_CHOICES = [
  { value: 'default', label: 'Default (recommended)' },
  { value: 'fable', label: 'Fable' },
  { value: 'opus', label: 'Opus' },
  { value: 'sonnet', label: 'Sonnet' },
  { value: 'haiku', label: 'Haiku' },
]
// The choices offered when the context bar is clicked to compact.
const COMPACT_NOW = 'Compact now'
const COMPACT_TASK = 'Focus on current task'
const TASK_FOCUS =
  'Focus on the current task: keep its goal, decisions made, open items and the files involved; drop finished side topics.'
const TICK_MS = 5000
// Widest token line: "↓999k÷9" is 7 columns.
// Widest model line: "🧠 $12.34" is 9 columns (an emoji takes two).
const DUR_W = 5 // "999ms", "12.3s"
const CLOCK_W = 8 // hh:mm:ss
// The left column: tokens, model and cost, savings, and under them the call's
// duration and start time side by side.
const TOK_W = DUR_W + 1 + CLOCK_W

// A response's usage names no tool-call ids, only the calls in order, so each
// call waiting to run is matched by loop and tool name, first come first served.
type Pending = { loop: string; tool: string; tokens: Tokens }
let pending: Pending[] = []
// The model each loop ('main' or an agent id) last used, for calls with no matched response.
const lastModel = new Map<string, string>()

const KEYS = ['file_path', 'command', 'pattern', 'url', 'query', 'skill', 'description', 'prompt', 'path', 'action']

function targetOf(input: unknown): string {
  const rec = (input ?? {}) as Record<string, unknown>
  for (const k of KEYS) {
    const v = rec[k]
    if (typeof v === 'string' && v.trim() !== '') {
      const one = v.replace(/\s+/g, ' ').trim()
      return one.length > 70 ? one.slice(0, 69) + '…' : one
    }
  }
  return ''
}

function clock(ms: number): string {
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

function took(ms?: number): string {
  if (ms === undefined) return ''
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`
}

function span(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  const m = Math.floor(s / 60)
  return m >= 60 ? `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m` : `${m}:${String(s % 60).padStart(2, '0')}`
}

function num(v: unknown, fallback: number, lo: number, hi: number): number {
  const x = typeof v === 'number' && Number.isFinite(v) ? v : fallback
  return Math.min(hi, Math.max(lo, x))
}

// "claude-sonnet-5-5" -> "Sonnet 5.5"; ids it doesn't recognise are shown as given.
function modelLabel(id: string): string {
  const cap = (f: string) => f.charAt(0).toUpperCase() + f.slice(1)
  let m = id.match(/claude-(opus|sonnet|haiku|fable)-(\d+)(?:-(\d{1,2}))?(?!\d)/)
  if (m) return `${cap(m[1]!)} ${m[2]}${m[3] ? '.' + m[3] : ''}`
  m = id.match(/claude-(\d+)(?:-(\d{1,2}))?-(opus|sonnet|haiku|fable)/)
  if (m) return `${cap(m[3]!)} ${m[1]}${m[2] ? '.' + m[2] : ''}`
  return id
}

// Anthropic API list prices in $ per million tokens (as of 2026-11): input, output, cache read.
// Cache writes cost 1.25x input for the 5-minute TTL and 2x for the 1-hour TTL.
// Haiku 5.5 prompts over 100K tokens bill at the higher `big` rates.
type Price = { in: number; out: number; read: number; big?: { in: number; out: number; read: number } }
const PRICES: Array<[RegExp, Price]> = [
  [/fable-5-2|mythos-5-2/, { in: 8, out: 40, read: 0.2 }],
  [/fable-5-1|mythos-5-1|fable-5(?!-)/, { in: 10, out: 50, read: 0.25 }],
  [/opus-5-5/, { in: 4, out: 20, read: 0.2 }],
  [/opus-(5|4-[5-8])(?!-?\d)/, { in: 5, out: 25, read: 0.5 }],
  [/sonnet-5-5/, { in: 2, out: 10, read: 0.1 }],
  [/sonnet-5(?!-)/, { in: 2, out: 10, read: 0.2 }],
  [/sonnet-4-[56]/, { in: 3, out: 15, read: 0.3 }],
  [/haiku-5-5/, { in: 0.1, out: 0.5, read: 0.01, big: { in: 0.5, out: 2.5, read: 0.05 } }],
  [/haiku-4-5/, { in: 1, out: 5, read: 0.1 }],
]

type Usage = {
  model?: string
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
  ephemeral_5m_input_tokens?: number
  ephemeral_1h_input_tokens?: number
}

/**
 * What one response cost in dollars at API list prices, and what its cache reads saved
 * against sending those tokens uncached; undefined for an unknown model.
 */
function costOf(u: Usage, sent: number): { cost: number; saved: number } | undefined {
  const hit = u.model ? PRICES.find(([re]) => re.test(u.model!)) : undefined
  if (!hit) return undefined
  const p0 = hit[1]
  const p = p0.big && sent > 100_000 ? p0.big : p0
  const long = u.ephemeral_1h_input_tokens ?? 0
  const short = u.ephemeral_5m_input_tokens ?? Math.max(0, u.cache_creation_input_tokens - long)
  const cost =
    (u.input_tokens * p.in +
      u.output_tokens * p.out +
      u.cache_read_input_tokens * p.read +
      short * p.in * 1.25 +
      long * p.in * 2) /
    1_000_000
  const saved = (u.cache_read_input_tokens * (p.in - p.read)) / 1_000_000
  return { cost, saved }
}

function money(d: number): string {
  if (d > 0 && d < 0.01) return '<1¢'
  return d >= 100 ? `$${Math.round(d)}` : `$${d.toFixed(2)}`
}

function familyOf(id: string): string | undefined {
  return id.match(/opus|sonnet|haiku|fable/)?.[0]
}

function n(v: number): string {
  if (v < 1000) return String(v)
  if (v < 1_000_000) return `${(v / 1000).toFixed(v < 10_000 ? 1 : 0)}k`
  return `${(v / 1_000_000).toFixed(1)}M`
}

const MARK: Record<Activity['status'], string> = { running: '…', ok: '✓', error: '✗', denied: '⊘' }
const COLOR: Record<Activity['status'], string | undefined> = {
  running: 'yellow',
  ok: 'green',
  error: 'red',
  denied: 'magenta',
}

export const register: Register = (on, options) => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'activity', description: 'Open the Activity pane (live feed of tool calls)' })
    void $.ui.open({ id: PANE, title: TITLE })
    // Redraw on a timer so the idle clock and cache countdown stay live.
    $.clock.every(TICK_MS, async () => {
      const t = await $.clock.now()
      await update($, now, () => t)
    })
    return next(e)
  })

  on('command.run', { command: 'activity' }, async $ => {
    await $.ui.open({ id: PANE, title: TITLE })
    return { text: 'Activity pane opened.' }
  })

  on('session.end', async ($, e, next) => {
    if ((e as { reason?: string }).reason === 'clear') await update($, ctx, () => EMPTY_CTX)
    return next(e)
  })

  // After any compaction of the main conversation (/compact, auto, or the bar's
  // click), drop the meter to the new size instead of waiting for the next request.
  on('session.compact', async ($, e, next) => {
    const r = await next(e)
    if (!e.agentId && e.trigger !== 'precompute' && r.skip === undefined) {
      const done = r as { tokensAfter?: number; messages?: readonly unknown[] }
      // Core usually reports the new size; if not, estimate ~4 characters a token.
      let after = done.tokensAfter
      if (after === undefined) {
        try {
          after = Math.round(JSON.stringify(done.messages ?? []).length / 4)
        } catch {
          after = 0
        }
      }
      const at = await $.clock.now()
      await update($, ctx, cur => ({ ...cur, tokens: after, compactedAt: at })).catch(() => {})
    }
    return r
  })

  on('turn.step', async function* ($, e, next) {
    const sentAt = await $.clock.now()
    const stepLoop = e.agentId ?? 'main'
    // The request names its model up front, so calls that run while the response
    // still streams (and the first ones after a plugin reload) get the right icon.
    if (e.model) lastModel.set(stepLoop, e.model)
    // A new request in this loop means every call of its last response has
    // started; any tokens still waiting for one would only mislabel a later call.
    pending = pending.filter(p => p.loop !== stepLoop)
    const r = yield* next(e)
    const u = r.usage
    if (u) {
      const sent = u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens
      const stepPrice = costOf({ ...u, model: u.model ?? e.model ?? lastModel.get(stepLoop) }, sent)
      await update($, totals, t => ({
        in: t.in + sent,
        out: t.out + u.output_tokens,
        cached: t.cached + u.cache_read_input_tokens,
        steps: t.steps + 1,
        cost: (t.cost ?? 0) + (stepPrice?.cost ?? 0),
        saved: (t.saved ?? 0) + (stepPrice?.saved ?? 0),
      }))
      if (e.agentId === undefined) {
        const long = (u.ephemeral_1h_input_tokens ?? 0) > 0
        const short = (u.ephemeral_5m_input_tokens ?? 0) > 0
        const dflt = options.cacheTtl === '1h' ? '1h' : '5m'
        await update($, ctx, c => ({
          tokens: sent + u.output_tokens,
          model: u.model,
          lastAt: sentAt,
          ttlMs: TTL_MS[long ? '1h' : short ? '5m' : c.lastAt ? (c.ttlMs >= TTL_MS['1h'] ? '1h' : '5m') : dflt],
        }))
      }
      const loop = e.agentId ?? 'main'
      if (u.model) lastModel.set(loop, u.model)
      const count = r.toolUses.length
      const price = costOf({ ...u, model: u.model ?? lastModel.get(loop) }, sent)
      if (count > 0) {
        const tokens: Tokens = {
          model: u.model ?? lastModel.get(loop),
          in: Math.round(sent / count),
          out: Math.round(u.output_tokens / count),
          cached: Math.round(u.cache_read_input_tokens / count),
          shared: count,
          cost: price && price.cost / count,
          saved: price && price.saved / count,
        }
        // Calls can start while the response still streams, before these counts
        // exist. Give those rows their tokens now, matching the response's calls
        // in order by tool name against this loop's rows started since the
        // request; the calls not started yet wait in `pending` for tool.call.
        let waiting = r.toolUses.map(t => t.name)
        await update($, calls, list => {
          const names = r.toolUses.map(t => t.name)
          const out = list.map(c => {
            if (c.tokens || c.loop !== loop || c.startedAt < sentAt) return c
            const k = names.indexOf(c.tool)
            if (k < 0) return c
            names.splice(k, 1)
            return { ...c, tokens, model: tokens.model ?? c.model }
          })
          waiting = names
          return out
        })
        pending = [...pending, ...waiting.map(tool => ({ loop, tool, tokens }))].slice(-50)
      }
    }
    return r
  })

  on('tool.call', async ($, e, next) => {
    const startedAt = await $.clock.now()
    const loop = e.agentId ?? 'main'
    const at = pending.findIndex(p => p.loop === loop && p.tool === e.tool)
    const tokens = at >= 0 ? pending[at]?.tokens : undefined
    if (at >= 0) pending = pending.filter((_, i) => i !== at)
    const id = e.tool_use_id ?? `${e.tool}-${startedAt}`
    const model = tokens?.model ?? lastModel.get(loop)
    const entry: Activity = { id, tool: e.tool, target: targetOf(e), startedAt, status: 'running', tokens, model, loop }
    await update($, calls, list => [...list, entry].slice(-KEEP))
    let status: Activity['status'] = 'error'
    try {
      const ran = await next(e)
      status = ran.deny !== undefined ? 'denied' : ran.isError ? 'error' : 'ok'
      return ran
    } finally {
      const ms = Math.round((await $.clock.now()) - startedAt)
      await update($, calls, list => list.map(c => (c.id === id ? { ...c, status, ms } : c)))
    }
  }).catch(($, e, next) => next(e))

  // The mouse wheel (or the arrow keys while the pane has focus) scrolls the feed.
  // The pane draws its own window of calls, newest first, so a move down shows
  // older calls; the engine's own window is left where it is.
  on('ui.scroll', { requestId: PANE }, async ($, e) => {
    const total = (await read($, calls)).length
    await update($, scroll, o => Math.min(Math.max(0, total - 1), Math.max(0, o + e.by)))
    return {}
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const list = await read($, calls)
    const tot = await read($, totals)
    const off0 = await read($, scroll)
    const isWarming = await read($, warming)
    const isCompacting = await read($, compacting)
    const isPicking = await read($, picking)
    const showTot = await read($, totalsShown)
    const showAll = (await read($, targetsShown)) ?? options.showTargets !== false
    const openIds = await read($, opened)
    const showTarget = (a: Activity) => !!a.target && (showAll || openIds.includes(a.id))
    const mine = await read($, ctx)
    // Prefer the engine's own reading of the main loop; fall back to what turn.step saw.
    let eng: Awaited<ReturnType<typeof $.agent.list>>[number] | undefined
    try {
      eng = (await $.agent.list()).find(a => a.id === 'main')
    } catch {
      eng = undefined
    }
    // The engine's count is its last request's, so right after a compaction it still
    // shows the old size; use the compacted size until the next request lands.
    const justCompacted = !!mine.compactedAt && mine.compactedAt >= Math.max(mine.lastAt, eng?.lastRequest?.at ?? 0)
    const fromEngine = !!eng && eng.tokenCount > 0 && !justCompacted
    const c: Ctx = fromEngine
      ? {
          tokens: eng!.tokenCount,
          // A warm-up ping is a fork, not a main-loop request, so the engine's
          // time misses it; take whichever is later.
          lastAt: Math.max(eng!.lastRequest?.at ?? 0, mine.lastAt),
          ttlMs: eng!.lastRequest?.cacheTtl ? TTL_MS[eng!.lastRequest.cacheTtl] : mine.ttlMs,
        }
      : mine
    await read($, now) // subscribes the pane to the idle ticker
    const clockNow = await $.clock.now()
    const room = Math.max(1, e.viewport?.rows ?? 30) // the list box clips what doesn't fit
    const win = eng?.contextWindowSize ? eng.contextWindowSize : num(options.contextWindow, 200_000, 1000, 100_000_000)
    // The pane's own width; viewport.columns is the whole conversation's.
    const cols = e.props?.bodyColumns ?? e.viewport?.columns ?? 80
    const width = Math.max(8, Math.min(Math.round(num(options.barWidth, 30, 10, 60)), cols - 24))
    const warnAt = num(options.compactAtPercent, 90, 1, 100) / 100
    const color = typeof options.meterColor === 'string' && options.meterColor ? options.meterColor : '#F7931A'
    const outColor = typeof options.outgoingColor === 'string' && options.outgoingColor ? options.outgoingColor : '#F7931A'
    const inColor = typeof options.incomingColor === 'string' && options.incomingColor ? options.incomingColor : 'cyan'
    const opt = (v: unknown, d: string) => (typeof v === 'string' && v ? v : d)
    const callsColor = opt(options.callsColor, 'white')
    const runColor = opt(options.runColor, '#F7931A')
    const failColor = opt(options.failColor, 'red')
    const labelColor = opt(options.contextLabelColor, 'white')
    const warnPct = num(options.warnAtPercent, 75, 1, 100) / 100
    const warnColor = opt(options.warnColor, 'yellow')
    const criticalColor = opt(options.criticalColor, 'red')
    const sepColor = opt(options.separatorColor, 'gray')
    const rowSepColor = opt(options.rowSeparatorColor, 'black')
    const modelColor = opt(options.modelColor, 'green')
    const warmColor = opt(options.warmColor, '#CC5500')
    const coolColor = opt(options.coolingColor, 'cyan')
    const idleColor = opt(options.idleColor, 'green')
    const idleLateColor = opt(options.idleLateColor, '#F7931A')
    const modelName = mine.model ?? eng?.model ?? ''
    const icons: Record<string, string> = {
      opus: opt(options.opusIcon, '🧠'),
      sonnet: opt(options.sonnetIcon, '🎵'),
      haiku: opt(options.haikuIcon, '🍃'),
      fable: opt(options.fableIcon, '🦉'),
    }
    const otherIcon = opt(options.otherModelIcon, '❔')
    const costColor = opt(options.costColor, 'green')
    const savedIcon = opt(options.savingsIcon, '💵')
    const savedColor = opt(options.savingsColor, 'gray')
    const warmIcon = opt(options.warmIcon, '🌡')
    const coolIcon = opt(options.coolingIcon, '🧊')
    // Status marks; an emoji takes the column's two cells.
    const marks: Record<Activity['status'], string> = {
      ...MARK,
      ok: opt(options.okIcon, '⚡'),
      error: opt(options.errorIcon, '💥'),
    }
    // The token totals line; blank leaves it dim, as it was.
    const totLabelColor = opt(options.totalsLabelColor, '') || undefined
    const totValueColor = opt(options.totalsValueColor, '') || undefined
    const modelIcon = (id: string) => icons[familyOf(id) ?? ''] ?? otherIcon
    const pct = Math.min(1, c.tokens / win)
    const filled = Math.round(pct * width)
    const started = c.lastAt > 0
    const idleMs = started ? Math.max(0, clockNow - c.lastAt) : 0
    const leftMs = c.ttlMs - idleMs
    const expired = started && leftMs <= 0
    // The cooling window before expiry, when ↻ shows: a warm-up then costs only a
    // cache read and restarts the timer. Capped at a fifth of the cache's lifetime,
    // so a 5-minute cache cools in its last minute.
    const coolMs = Math.min(num(options.coolingMinutes, 5, 0, 60) * 60_000, c.ttlMs / 5)
    const cooling = started && !expired && leftMs < coolMs
    const compact = pct >= warnAt
    const heavy = pct >= warnPct || compact // yellow or red: the bar becomes a /compact button
    const barColor = compact ? criticalColor : pct >= warnPct ? warnColor : color
    const ttlLabel = c.ttlMs >= TTL_MS['1h'] ? '1h' : '5m'
    const off = Math.min(off0, Math.max(0, list.length - 1))
    const running = list.filter(c => c.status === 'running').length
    const failed = list.filter(c => c.status === 'error' || c.status === 'denied').length
    // Whether the rows overflow the list box, estimated from each row's height: its
    // token column, its wrapped tool + target text, and the separator above it. The
    // scroll buttons appear only then (or once scrolled, to scroll back).
    const paneRows = e.viewport?.rows ? Math.max(8, e.viewport.rows - 6) : 24
    // The model picker, opened by clicking the model name. It offers the engine's
    // own list when /config has a model row with choices, else the /model aliases.
    let modelChoices = MODEL_CHOICES
    // The exact choice in effect (e.g. "fable[1m]", "opusplan"), when the engine says.
    let chosen: string | undefined
    if (isPicking) {
      try {
        const row = (await $.config.list()).find(r => r.key === 'model')
        if (row?.options?.length) modelChoices = row.options.map(v => ({ value: v, label: modelLabel(v) || v }))
        if (typeof row?.value === 'string' && row.value) chosen = row.value
      } catch {
        // keep the aliases
      }
      // Each choice gets its family's icon; one with no family (Default) gets two
      // spaces in its place, an emoji's width, so the names line up.
      modelChoices = modelChoices.map(o => {
        const fam = familyOf(o.value)
        return { ...o, label: `${fam ? icons[fam] ?? otherIcon : '  '} ${o.label}` }
      })
    }
    // Mark the exact choice when it's one of the rows; otherwise fall back to the
    // family of the model that last answered (its id carries no [1m] or opusplan).
    const currentChoice = chosen && modelChoices.some(o => o.value === chosen) ? chosen : familyOf(modelName)
    // The top bar's width with its labels: counts, model (emoji is 2 wide, plus ▾),
    // and the targets toggle, one space between items. Too wide for the pane, the
    // calls/run/fail labels drop and | separates the bare counts instead.
    const barLen =
      `${list.length} calls ${running} run ${failed} fail`.length +
      (modelName !== '' ? 3 + 3 + modelLabel(modelName).length + 2 : 0)
    const tight = barLen > cols
    // The meter line with its Context label; too wide for the pane, the label drops.
    const meterTight = `Context ${'█'.repeat(width)} ${Math.round(pct * 100)}% ${n(c.tokens)}/${n(win)}`.length > cols
    // The token totals pieces, wrapped as the pane fits them.
    const totRows = showTot ? 3 : 0
    // Info bar, token totals, picker rows. The scroll row isn't counted: it appears
    // only when the rows overflow without it.
    const headerRows = 1 + totRows + (isPicking ? modelChoices.length + 7 : 0) // + two rules, Show Totals, Show Commands, Save Log, Clear Logs and a blank line
    const footerRows = 1 + (heavy ? 1 : 0) + 1 // meter, compact notice, status line
    const listRows = Math.max(1, paneRows - headerRows - footerRows)
    const textCols = Math.max(10, cols - TOK_W - 5)
    let used = 0
    for (let i = list.length - 1; i >= 0 && used <= listRows; i--) {
      const a = list[i]!
      const tokLines = (a.tokens ? 2 + ((a.tokens.saved ?? 0) > 0 ? 1 : 0) : 0) + (a.model ? 1 : 0) + 1 // + duration/time
      const textLines = Math.max(1, Math.ceil((a.tool.length + (showTarget(a) ? a.target.length + 1 : 0)) / textCols))
      used += Math.max(tokLines, textLines) + (i < list.length - 1 ? 1 : 0)
    }
    // Sends a tiny tool-less request over the session's own transcript so the prompt
    // cache is read (and rewritten if it lapsed), then restarts the meter's idle clock.
    const warm = async () => {
      await update($, warming, () => true)
      try {
        const sentAt = await $.clock.now()
        const r = await $.model.fork({
          prompt: 'Cache warm-up ping. You have no tools. Do not think it over; reply with only: ok',
        })
        if (!r.isAnswered) {
          $.ui.toast(`Warm-up failed: ${r.reason}`)
        } else {
          const u = r.usage as {
            cache_read_input_tokens: number
            cache_creation_input_tokens: number
            ephemeral_1h_input_tokens?: number
            ephemeral_5m_input_tokens?: number
          }
          const read = u.cache_read_input_tokens
          const wrote = u.cache_creation_input_tokens
          if (read + wrote > 0) {
            await update($, ctx, cur => ({
              ...cur,
              lastAt: sentAt,
              ttlMs: (u.ephemeral_1h_input_tokens ?? 0) > 0 ? TTL_MS['1h'] : (u.ephemeral_5m_input_tokens ?? 0) > 0 ? TTL_MS['5m'] : cur.ttlMs,
            }))
          }
          $.ui.toast(`Warmed: ${n(read)} read, ${n(wrote)} rewritten`)
        }
      } catch (err) {
        $.ui.toast(`Warm-up failed: ${err instanceof Error ? err.message : String(err)}`)
      } finally {
        await update($, warming, () => false)
      }
    }
    // The bar's click once it turns the warning or critical color: the same
    // compaction /compact runs. The engine refuses it while a turn is running.
    const runCompact = async () => {
      if (await read($, compacting)) return
      // Offer focus instructions for the summary, as `/compact <focus>` takes. The first
      // choice compacts with none, so Enter skips it; Esc cancels the compaction.
      let instructions: string | undefined
      if (options.askCompactFocus !== false) {
        let answer: string
        try {
          answer = await $.ui.ask('Compact the conversation: anything the summary should focus on?', {
            header: 'Compact',
            options: [COMPACT_NOW, COMPACT_TASK],
          })
        } catch {
          return // dismissed: leave the conversation as it is
        }
        instructions = answer === COMPACT_NOW ? undefined : answer === COMPACT_TASK ? TASK_FOCUS : answer.trim() || undefined
      }
      await update($, compacting, () => true)
      try {
        const r = await $.session.compact(instructions ? { instructions } : undefined)
        const after = (r as { tokensAfter?: number }).tokensAfter
        $.ui.toast(r.skip ? `Compact skipped: ${r.skip}` : `Compacted${after !== undefined ? ` to ~${n(after)}` : ''}`)
      } catch (err) {
        $.ui.toast(`Couldn't compact: ${err instanceof Error ? err.message : String(err)} · try again when Claude is idle`)
      } finally {
        await update($, compacting, () => false)
      }
    }
    const pickModel = async (value: string) => {
      await update($, picking, () => false)
      try {
        const r = await $.command.run({ command: 'model', args: value })
        $.ui.toast(r.text?.trim() || `Model set to ${value}`)
      } catch (err) {
        $.ui.toast(`Couldn't switch model: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    // Writes the feed, oldest first, with the session totals to a text file in the
    // logFolder setting (default: a claude-activity-logs folder in the home folder,
    // never the session's own folder).
    const saveLog = async () => {
      try {
        const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME'))
        const folder = opt(options.logFolder, '') || (home ? `${home}/claude-activity-logs` : '')
        if (!folder) {
          $.ui.toast('Save Log: set the logFolder setting first')
          return
        }
        const d = new Date(clockNow)
        const p2 = (x: number) => String(x).padStart(2, '0')
        const stamp = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`
        const file = `${folder.replace(/[\\/]+$/, '')}/activity-${stamp}_${clock(clockNow).replace(/:/g, '')}.log`
        const status: Record<Activity['status'], string> = { running: 'RUN ', ok: 'OK  ', error: 'FAIL', denied: 'DENY' }
        const lines = [
          `Activity log saved ${stamp} ${clock(clockNow)}`,
          `Session: ${await $.session.cwd()}`,
          `Responses: ${tot.steps}  Tokens: ${n(tot.in)}  Cached: ${n(tot.cached)}  Written: ${n(tot.out)}`,
          `Session Totals: spent ${money(tot.cost ?? 0)} | cache saved ${money(tot.saved ?? 0)} (estimates at list prices)`,
          '',
          'Time      Status  Took    Tokens in/out      Cost     Saved    Model  Tool  Target',
          ...list.map(a =>
            [
              clock(a.startedAt),
              status[a.status],
              took(a.ms).padEnd(6),
              (a.tokens ? `${n(a.tokens.in)}/${n(a.tokens.out)}${a.tokens.shared > 1 ? `÷${a.tokens.shared}` : ''}` : '').padEnd(17),
              (a.tokens?.cost !== undefined ? money(a.tokens.cost) : '').padEnd(7),
              ((a.tokens?.saved ?? 0) > 0 ? money(a.tokens!.saved!) : '').padEnd(7),
              a.model ? modelLabel(a.model) || a.model : '-',
              a.tool,
              a.target,
            ].join('  '),
          ),
          '',
        ]
        await $.fs.write(file, lines.join(String.fromCharCode(10)))
        $.ui.toast(`Saved ${list.length} calls to ${file}`)
      } catch (err) {
        $.ui.toast(`Couldn't save the log: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    const clear = () => {
      void update($, scroll, () => 0)
      void update($, calls, () => [])
      void update($, opened, () => [])
      void update($, totals, () => ({ in: 0, out: 0, cached: 0, steps: 0, cost: 0, saved: 0 }))
    }

    return (
      <Box flexDirection="column" height={e.viewport?.rows ? Math.max(8, e.viewport.rows - 6) : undefined}>
       <Box flexDirection="column" flexShrink={0}>
        <Box flexDirection="row" gap={1}>
          <Text bold color={callsColor}>{list.length}{tight ? '' : ' calls'}</Text>
          {tight && <Text color={sepColor}>|</Text>}
          <Text color={runColor}>{running}{tight ? '' : ' run'}</Text>
          {tight && <Text color={sepColor}>|</Text>}
          <Text color={failed ? failColor : undefined} dimColor={!failed}>{failed}{tight ? '' : ' fail'}</Text>
          {modelName !== '' && <Text color={sepColor}>|</Text>}
          {modelName !== '' && (
            <Button key="model-name" plain onPress={() => void update($, picking, p => !p)}>
              <Text>{modelIcon(modelName)} </Text>
              <Text color={modelColor}>{modelLabel(modelName)}</Text>
              <Text dimColor> ≡</Text>
            </Button>
          )}
        </Box>
        {/* The choices drawn open, one clickable row each, so one click on the
            model name is enough; clicking the name again closes the list. */}
        {isPicking && (
          <Box flexDirection="column" paddingLeft={2}>
            {modelChoices.map(o => {
              const isCurrent = o.value === currentChoice
              return (
                <Button key={`model-${o.value}`} plain onPress={() => void pickModel(o.value)}>
                  <Text color={isCurrent ? modelColor : undefined}>{isCurrent ? '● ' : '  '}{o.label}</Text>
                </Button>
              )
            })}
            {/* View options, below the models and set apart by a rule. */}
            <Text color={sepColor}>{'─'.repeat(Math.max(4, Math.min(24, cols - 2)))}</Text>
            <Button key="totals-toggle" plain onPress={() => void update($, totalsShown, v => !v)}>
              <Text>{showTot ? '◉' : '○'} Show Totals</Text>
            </Button>
            <Button
              key="targets-toggle"
              plain
              onPress={() => {
                void update($, targetsShown, () => !showAll)
                void update($, opened, () => [])
              }}
            >
              <Text>{showAll ? '◉' : '○'} Show Commands</Text>
            </Button>
            <Text color={sepColor}>{'─'.repeat(Math.max(4, Math.min(24, cols - 2)))}</Text>
            <Button key="save-log" plain onPress={() => void saveLog()}>
              <Text>💾 Save Log</Text>
            </Button>
            <Button key="clear" plain onPress={clear}>
              <Text>✕ Clear Logs</Text>
            </Button>
            <Text> </Text>
          </Box>
        )}
        {showTot && (<Box flexDirection="column">
        {/* Token totals, one line each; dollars in parentheses. */}
        <Text wrap="truncate-end">
          <Text color={totLabelColor} dimColor={!totLabelColor}>Tokens: </Text>
          <Text color={totValueColor} dimColor={!totValueColor}>{n(tot.in)}</Text>
          <Text color={costColor}> ({money(tot.cost ?? 0)})</Text>
        </Text>
        <Text wrap="truncate-end">
          <Text color={totLabelColor} dimColor={!totLabelColor}>Cached: </Text>
          <Text color={totValueColor} dimColor={!totValueColor}>{n(tot.cached)}</Text>
          <Text color={savedColor}> ({money(tot.saved ?? 0)})</Text>
        </Text>
        <Text wrap="truncate-end">
          <Text color={totLabelColor} dimColor={!totLabelColor}>Written: </Text>
          <Text color={totValueColor} dimColor={!totValueColor}>{n(tot.out)}</Text>
        </Text>
        </Box>)}
       </Box>
       <Box flexDirection="column" flexGrow={1} flexShrink={1} minHeight={0} overflow="hidden">
        {list.length === 0 && <Text dimColor>No tool calls yet.</Text>}
        {list
          .slice()
          .reverse()
          .slice(off, off + room)
          .map((c, i) => (
            <Box key={c.id} flexDirection="column" flexShrink={0}>
            {i > 0 && <Text color={rowSepColor} wrap="truncate-end">{'─'.repeat(Math.max(1, cols))}</Text>}
            <Box flexDirection="row" gap={1} flexShrink={0}>
              <Box width={TOK_W} flexShrink={0} flexDirection="column">
                {c.tokens && <Text color={outColor} wrap="truncate-end">↑{n(c.tokens.in)}</Text>}
                {c.tokens && (
                  <Text color={inColor} wrap="truncate-end">
                    ↓{n(c.tokens.out)}{c.tokens.shared > 1 ? `÷${c.tokens.shared}` : ''}
                  </Text>
                )}
                {c.model && (
                  <Text wrap="truncate-end">
                    {modelIcon(c.model)}
                    {c.tokens?.cost !== undefined && <Text color={costColor}> {money(c.tokens.cost)}</Text>}
                  </Text>
                )}
                {(c.tokens?.saved ?? 0) > 0 && (
                  <Text wrap="truncate-end">
                    {savedIcon}
                    <Text color={savedColor}> {money(c.tokens!.saved!)}</Text>
                  </Text>
                )}
                <Text dimColor wrap="truncate-end">{took(c.ms).padEnd(DUR_W)} {clock(c.startedAt)}</Text>
              </Box>
              <Box width={2} flexShrink={0}>
                <Text color={COLOR[c.status]}>{marks[c.status]}</Text>
              </Box>
              <Box flexGrow={1} flexShrink={1}>
                {showAll || !c.target ? (
                  <Text wrap="wrap">
                    <Text bold>{c.tool}</Text>
                    <Text dimColor>{c.target ? ` ${c.target}` : ''}</Text>
                  </Text>
                ) : (
                  // Targets hidden: click the tool name to open or close this call's target.
                  <Button
                    key={`target-${c.id}`}
                    plain
                    onPress={() => void update($, opened, ids => (ids.includes(c.id) ? ids.filter(x => x !== c.id) : [...ids, c.id]))}
                  >
                    <Text wrap="wrap">
                      <Text bold>{c.tool}</Text>
                      <Text dimColor>{openIds.includes(c.id) ? ` ${c.target}` : ' ›'}</Text>
                    </Text>
                  </Button>
                )}
              </Box>
            </Box>
            </Box>
          ))}
       </Box>
        <Box flexDirection="column" flexShrink={0}>
          <Box flexDirection="row" gap={1}>
            {!meterTight && <Text bold color={labelColor}>Context</Text>}
            {heavy ? (
              <Button key="compact-bar" plain onPress={() => void runCompact()}>
                <Text color={barColor}>{'█'.repeat(filled)}</Text>
                <Text dimColor>{'░'.repeat(width - filled)}</Text>
              </Button>
            ) : (
              <Text>
                <Text color={barColor}>{'█'.repeat(filled)}</Text>
                <Text dimColor>{'░'.repeat(width - filled)}</Text>
              </Text>
            )}
            <Text>{Math.round(pct * 100)}%</Text>
            <Text dimColor>{n(c.tokens)}/{n(win)}</Text>
          </Box>
          {heavy && (
            <Text color={barColor} wrap="truncate-end">
              {isCompacting ? 'Compacting…' : '▲ Click the bar to run /compact and save tokens'}
            </Text>
          )}
          {!started ? (
            <Text dimColor>No model requests yet.</Text>
          ) : (
            <Box flexDirection="column">
              {compact ? (
                <Text color="red" wrap="truncate-end">⚠ Near limit · idle {span(idleMs)}</Text>
              ) : expired ? (
                <Box flexDirection="row" gap={1}>
                  {isWarming ? <Text color="yellow">…</Text> : <Button plain onPress={() => void warm()}>↻</Button>}
                  <Text color="yellow" wrap="truncate-end">
                    {isWarming ? 'Warming…' : `Expired · next message reloads ~${n(c.tokens)} · idle ${span(idleMs)} · ↻ reloads now`}
                  </Text>
                </Box>
              ) : cooling ? (
                <Box flexDirection="row" gap={1}>
                  {isWarming ? <Text color={coolColor}>…</Text> : <Button plain onPress={() => void warm()}>↻</Button>}
                  <Text wrap="truncate-end">
                    <Text color={coolColor}>{isWarming ? 'Warming…' : `${coolIcon} Cooling ${span(leftMs)} · `}</Text>
                    {!isWarming && <Text color={idleLateColor}>idle {span(idleMs)}</Text>}
                    {!isWarming && <Text dimColor> · ↻ keeps it warm</Text>}
                  </Text>
                </Box>
              ) : (
                <Text wrap="truncate-end">
                  <Text color={warmColor}>{warmIcon}  Warm {span(leftMs)} · </Text>
                  <Text color={idleColor}>idle {span(idleMs)}</Text>
                </Text>
              )}
            </Box>
          )}
        </Box>
      </Box>
    )
  })
}
