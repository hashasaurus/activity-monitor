# Activity Monitor

A Claude Code plugin that opens an **Activity** pane beside the chat. It shows a live feed of every tool call Claude makes, what each one cost, and how full the context window is.

## What it shows

- **Live tool-call feed.** One row per call has the tool, its target, whether it worked, how long it took, and when it started. Calls made by sub-agents appear too.
- **Tokens per call.** `↑` is the context sent to the model and `↓` is what the model wrote back. `÷N` means N calls shared one response, so its tokens are split between them.
- **Which model made the call.** Each row has an emoji: 🧠 Opus, 🎵 Sonnet, 🍃 Haiku, 🦉 Fable, ❔ anything else. That makes model switches and sub-agents easy to spot.
- **Cost per call.** Shown in green next to the model icon. It's the call's share of the response's price at Anthropic's public API list prices.
- **Cache savings.** A 💵 line in gray shows what prompt-cache reads saved, compared with sending the same tokens uncached.
- **Context meter.** A bar shows how full the context window is. It turns yellow at 75% and red at 90%. In yellow or red you can **click the bar to run `/compact`**. The meter updates as soon as any compaction finishes.
- **Model picker.** Click the model name in the top bar (marked ▾) to choose a different model from a list. Picking one runs `/model` for you. If Claude is mid-reply, the switch waits until the reply finishes. The name in the top bar changes after the next request, because it shows the model that actually answered.
- **Cache status.** The line under the bar shows how long the prompt cache stays warm and how long you've been idle. While it's warm, your next message reads the conversation from the cache at a fraction of the normal price. Once it expires, the next message sends the whole conversation again and pays to rewrite the cache. Nothing in the conversation is lost either way; only the cost changes.
  - In the last few minutes before it expires (5 by default, see `coolingMinutes`), the line says **Cooling** and shows **↻**. Press it to keep the cache warm: a tiny request reads the cache and restarts its timer, which costs far less than a rewrite later. It's worth doing if you'll keep working in this session.
  - After the cache has expired, **↻** rewrites it right away. That costs the same as your next message would, so the only gain is a faster first reply.

Costs are estimates from list prices. They don't reflect discounts, a subscription plan, or batch pricing.

## Install

> **Git is required.** Adding the marketplace clones this plugin's GitHub repository, so the install fails if Git isn't installed. Check with `git --version`, and if it's missing, install it from [git-scm.com](https://git-scm.com/downloads) first.

Run these in a terminal:

```
claude plugin marketplace add hashasaurus/activity-monitor
claude plugin install activity-monitor@hashasaurus
```

Or, inside Claude Code:

```
/plugin marketplace add hashasaurus/activity-monitor
/plugin install activity-monitor@hashasaurus
```

Then restart Claude Code or run `/reload-plugins`. The pane opens by itself when a session starts. If you close it, type `/activity` to reopen it.

After installing, you may see a message like `24 userConfig options not yet set — run /plugin configure…`. Every option has a default, so you can ignore it. Configure only the settings you want to change (see [Settings](#settings)).

This plugin runs its own code to draw the pane, so Claude Code may ask you to trust it the first time it loads.

To update to the latest version:

```
claude plugin marketplace update hashasaurus
claude plugin update activity-monitor@hashasaurus
```

## Settings

Change these through `/config` or with `claude plugin configure activity-monitor`.

| Setting | Default | What it does |
|---|---|---|
| `contextWindow` | 200000 | Context window size used by the meter when Claude Code doesn't report one |
| `barWidth` | 30 | Meter width in characters (10–60) |
| `warnAtPercent` | 75 | When the bar turns the warning color and becomes clickable |
| `compactAtPercent` | 90 | When the bar turns the critical color |
| `meterColor` / `warnColor` / `criticalColor` | `#F7931A` / yellow / red | Bar colors |
| `cacheTtl` | 5m | Cache lifetime assumed until a response reports its own (`5m` or `1h`) |
| `opusIcon` / `sonnetIcon` / `haikuIcon` / `fableIcon` / `otherModelIcon` | 🧠 / 🎵 / 🍃 / 🦉 / ❔ | Model emojis |
| `coolingMinutes` | 5 | How long before the cache expires the status line shows Cooling and offers ↻ (at most a fifth of the cache's lifetime, so the last minute of a 5-minute cache) |
| `warmColor` / `coolingColor` | `#CC5500` / cyan | Cache status line while warm, and while cooling |
| `idleColor` / `idleLateColor` | green / `#F7931A` | Idle time on the cache status line, and while cooling |
| `costColor` | green | Color of the cost next to the model icon |
| `savingsIcon` / `savingsColor` | 💵 / gray | Cache-savings line |
| `outgoingColor` / `incomingColor` | `#F7931A` / cyan | Colors of `↑` and `↓` |
| `rowSeparatorColor` | black | Line between calls in the feed |
| `callsColor`, `runColor`, `failColor`, `modelColor`, `separatorColor`, `contextLabelColor` | — | Colors in the top bar and meter label |

A color can be a name such as `cyan`, or a hex value such as `#F7931A`.

## License

MIT. See [LICENSE](LICENSE).
