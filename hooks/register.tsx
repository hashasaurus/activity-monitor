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
// What the picker offers when the engine's /config has no model row with choices:
// the aliases /model takes, each resolving to that family's latest model.
const MODEL_CHOICES = [
  { value: 'default', label: 'Default (recommended)' },
  { value: 'fable', label: 'Fable' },
  { value: 'opus', label: 'Opus' },
  { value: 'sonnet', label: 'Sonnet' },
  { value: 'haiku', label: 'Haiku' },
]
const PAGE = 3
const TICK_MS = 5000
// Widest token line: "↓999k÷9" is 7 columns.
// Widest model line: "🧠 $12.34" is 9 columns (an emoji takes two).
const TOK_W = 9
const DUR_W = 6 // "999ms", "12.3s"
const CLOCK_W = 8 // hh:mm:ss

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
      const after = (r as { tokensAfter?: number }).tokensAfter ?? 0
      await update($, ctx, cur => ({ ...cur, tokens: after })).catch(() => {})
    }
    return r
  })

  on('turn.step', async function* ($, e, next) {
    const sentAt = await $.clock.now()
    const r = yield* next(e)
    const u = r.usage
    if (u) {
      const sent = u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens
      await update($, totals, t => ({
        in: t.in + sent,
        out: t.out + u.output_tokens,
        cached: t.cached + u.cache_read_input_tokens,
        steps: t.steps + 1,
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
        pending = [...pending, ...r.toolUses.map(t => ({ loop, tool: t.name, tokens }))].slice(-50)
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
    const entry: Activity = { id, tool: e.tool, target: targetOf(e), startedAt, status: 'running', tokens, model }
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

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Select } = $.ui.resolve(e)
    const list = await read($, calls)
    const tot = await read($, totals)
    const off0 = await read($, scroll)
    const isWarming = await read($, warming)
    const isCompacting = await read($, compacting)
    const isPicking = await read($, picking)
    const mine = await read($, ctx)
    // Prefer the engine's own reading of the main loop; fall back to what turn.step saw.
    let eng: Awaited<ReturnType<typeof $.agent.list>>[number] | undefined
    try {
      eng = (await $.agent.list()).find(a => a.id === 'main')
    } catch {
      eng = undefined
    }
    const fromEngine = !!eng && eng.tokenCount > 0
    const c: Ctx = fromEngine
      ? {
          tokens: eng!.tokenCount,
          lastAt: eng!.lastRequest?.at ?? mine.lastAt,
          ttlMs: eng!.lastRequest?.cacheTtl ? TTL_MS[eng!.lastRequest.cacheTtl] : mine.ttlMs,
        }
      : mine
    await read($, now) // subscribes the pane to the idle ticker
    const clockNow = await $.clock.now()
    const room = Math.max(1, e.viewport?.rows ?? 30) // the list box clips what doesn't fit
    const win = fromEngine && eng!.contextWindowSize ? eng!.contextWindowSize : num(options.contextWindow, 200_000, 1000, 100_000_000)
    const cols = e.viewport?.columns ?? 80
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
    const modelColor = opt(options.modelColor, 'green')
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
    const modelIcon = (id: string) => icons[familyOf(id) ?? ''] ?? otherIcon
    const pct = Math.min(1, c.tokens / win)
    const filled = Math.round(pct * width)
    const started = c.lastAt > 0
    const idleMs = started ? Math.max(0, clockNow - c.lastAt) : 0
    const leftMs = c.ttlMs - idleMs
    const expired = started && leftMs <= 0
    const compact = pct >= warnAt
    const heavy = pct >= warnPct || compact // yellow or red: the bar becomes a /compact button
    const barColor = compact ? criticalColor : pct >= warnPct ? warnColor : color
    const ttlLabel = c.ttlMs >= TTL_MS['1h'] ? '1h' : '5m'
    const off = Math.min(off0, Math.max(0, list.length - 1))
    const running = list.filter(c => c.status === 'running').length
    const failed = list.filter(c => c.status === 'error' || c.status === 'denied').length
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
      await update($, compacting, () => true)
      try {
        const r = await $.session.compact()
        const after = (r as { tokensAfter?: number }).tokensAfter
        $.ui.toast(r.skip ? `Compact skipped: ${r.skip}` : `Compacted${after !== undefined ? ` to ~${n(after)}` : ''}`)
      } catch (err) {
        $.ui.toast(`Couldn't compact: ${err instanceof Error ? err.message : String(err)} · try again when Claude is idle`)
      } finally {
        await update($, compacting, () => false)
      }
    }
    // The model picker, opened by clicking the model name. It offers the engine's
    // own list when /config has a model row with choices, else the /model aliases.
    let modelChoices = MODEL_CHOICES
    if (isPicking) {
      try {
        const row = (await $.config.list()).find(r => r.key === 'model')
        if (row?.options?.length) modelChoices = row.options.map(v => ({ value: v, label: modelLabel(v) || v }))
      } catch {
        // keep the aliases
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
    const clear = () => {
      void update($, scroll, () => 0)
      void update($, calls, () => [])
      void update($, totals, () => ({ in: 0, out: 0, cached: 0, steps: 0 }))
    }

    return (
      <Box flexDirection="column" height={e.viewport?.rows ? Math.max(8, e.viewport.rows - 6) : undefined}>
       <Box flexDirection="column" flexShrink={0}>
        <Box flexDirection="row" gap={1}>
          <Text bold color={callsColor}>{list.length} calls</Text>
          <Text color={runColor}>{running} run</Text>
          <Text color={failed ? failColor : undefined} dimColor={!failed}>{failed} fail</Text>
          {modelName !== '' && <Text color={sepColor}>|</Text>}
          {modelName !== '' && (
            <Button key="model-name" label="Change model" plain onPress={() => void update($, picking, p => !p)}>
              <Text color={modelColor}>{modelLabel(modelName)}</Text>
              <Text dimColor>{isPicking ? ' ▴' : ' ▾'}</Text>
            </Button>
          )}
        </Box>
        {isPicking && (
          <Box flexDirection="row" gap={1}>
            <Select
              key="model-select"
              label="Model:"
              options={modelChoices}
              value={modelChoices.find(o => o.value === familyOf(modelName))?.value}
              autoFocus
              onSelect={v => void pickModel(v)}
            />
            <Button key="model-cancel" onPress={() => void update($, picking, () => false)}>Cancel</Button>
          </Box>
        )}
        <Box flexDirection="row" gap={1}>
          <Button onPress={() => void update($, scroll, o => Math.max(0, o - PAGE))}>▲</Button>
          <Button onPress={() => void update($, scroll, o => Math.min(Math.max(0, list.length - 1), o + PAGE))}>▼</Button>
          {off > 0 && <Text dimColor>+{off} newer</Text>}
          <Button onPress={clear}>Clear</Button>
        </Box>
        <Text dimColor>
          Tokens over {tot.steps} responses: {n(tot.in)} sent ({n(tot.cached)} cached) · {n(tot.out)} written
        </Text>
       </Box>
       <Box flexDirection="column" flexGrow={1} flexShrink={1} minHeight={0} overflow="hidden">
        {list.length === 0 && <Text dimColor>No tool calls yet.</Text>}
        {list
          .slice()
          .reverse()
          .slice(off, off + room)
          .map((c, i) => (
            <Box key={c.id} flexDirection="column" flexShrink={0}>
            {i > 0 && <Text dimColor wrap="truncate-end">{'─'.repeat(Math.max(1, cols))}</Text>}
            <Box flexDirection="row" gap={1} flexShrink={0}>
              <Box width={TOK_W} flexShrink={0} flexDirection="column">
                <Text color={outColor} wrap="truncate-end">{c.tokens ? `↑${n(c.tokens.in)}` : ''}</Text>
                <Text color={inColor} wrap="truncate-end">
                  {c.tokens ? `↓${n(c.tokens.out)}${c.tokens.shared > 1 ? `÷${c.tokens.shared}` : ''}` : ''}
                </Text>
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
              </Box>
              <Box width={1} flexShrink={0}>
                <Text color={COLOR[c.status]}>{MARK[c.status]}</Text>
              </Box>
              <Box flexGrow={1} flexShrink={1}>
                <Text wrap="wrap">
                  <Text bold>{c.tool}</Text>
                  <Text dimColor>{c.target ? ` ${c.target}` : ''}</Text>
                </Text>
              </Box>
              <Box width={DUR_W} flexShrink={0} justifyContent="flex-end">
                <Text dimColor wrap="truncate-end">{took(c.ms)}</Text>
              </Box>
              <Box width={CLOCK_W} flexShrink={0}>
                <Text dimColor>{clock(c.startedAt)}</Text>
              </Box>
            </Box>
            </Box>
          ))}
       </Box>
        <Box flexDirection="column" flexShrink={0}>
          <Box flexDirection="row" gap={1}>
            <Text bold color={labelColor}>Context</Text>
            {heavy ? (
              <Button key="compact-bar" label="Run /compact" plain onPress={() => void runCompact()}>
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
            <Text dimColor>{n(c.tokens)}/{n(win)} {fromEngine ? 'engine' : 'est'}</Text>
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
                  {isWarming ? <Text color="yellow">…</Text> : <Button onPress={() => void warm()}>↻</Button>}
                  <Text color="yellow" wrap="truncate-end">
                    {isWarming ? 'Warming…' : `Reload ~${n(c.tokens)} · idle ${span(idleMs)} · press ↻ to warm`}
                  </Text>
                </Box>
              ) : (
                <Text color={leftMs < 60_000 ? 'yellow' : 'green'} wrap="truncate-end">✓ Warm {span(leftMs)} · idle {span(idleMs)}</Text>
              )}
            </Box>
          )}
        </Box>
      </Box>
    )
  })
}
