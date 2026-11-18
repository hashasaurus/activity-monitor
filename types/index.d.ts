/** Tokens of the model response that asked for a call, split evenly across the calls it asked for. */
export type Tokens = {
  /** Context sent: input + cache read + cache write. */
  in: number
  /** Tokens the model wrote. */
  out: number
  /** Of that sent context, how much was a cache read. */
  cached: number
  /** How many tool calls shared the response (1 = not shared). */
  shared: number
  /** The model that wrote the response, as the API reports it. */
  model?: string
  /** This call's share of the response's price in dollars, at API list prices. */
  cost?: number
  /** This call's share of what cache reads saved, in dollars, versus sending them uncached. */
  saved?: number
}

export type Activity = {
  id: string
  tool: string
  target: string
  startedAt: number
  status: 'running' | 'ok' | 'error' | 'denied'
  ms?: number
  tokens?: Tokens
  /** The model whose response asked for the call (main loop or sub-agent). */
  model?: string
}

/** The main loop's context as of its last model request. */
export type Ctx = {
  /** Context held after the request: sent + written. 0 before the first request. */
  tokens: number
  /** When the last request was sent, in `$.clock.now()` ms; 0 before the first. */
  lastAt: number
  /** How long the prompt cache keeps what that request wrote, in ms. */
  ttlMs: number
  /** The model that answered the last request, as the API reports it. */
  model?: string
}

export type Totals = { in: number; out: number; cached: number; steps: number }

declare module 'claude-code' {
  interface PluginState {
    'activity-monitor': { calls: Shaped<Activity[]>; totals: Shaped<Totals>; ctx: Shaped<Ctx>; now: Shaped<number>; scroll: Shaped<number>; warming: Shaped<boolean>; compacting: Shaped<boolean> }
  }
}
