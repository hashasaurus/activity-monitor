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
- **Cache status.** The line under the bar says whether the prompt cache is still warm. Once the cache has expired, press **↻** to warm it with a tiny request before you continue.

Costs are estimates from list prices. They don't reflect discounts, a subscription plan, or batch pricing.

## Install

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
| `warmColor` / `coolingColor` | `#CC5500` / cyan | Cache status line while warm, and in its last minute before it expires |
| `idleColor` / `idleLateColor` | green / `#F7931A` | Idle time on the cache status line, and in the cache's last minute |
| `costColor` | green | Color of the cost next to the model icon |
| `savingsIcon` / `savingsColor` | 💵 / gray | Cache-savings line |
| `outgoingColor` / `incomingColor` | `#F7931A` / cyan | Colors of `↑` and `↓` |
| `rowSeparatorColor` | black | Line between calls in the feed |
| `callsColor`, `runColor`, `failColor`, `modelColor`, `separatorColor`, `contextLabelColor` | — | Colors in the top bar and meter label |

A color can be a name such as `cyan`, or a hex value such as `#F7931A`.

## License

MIT. See [LICENSE](LICENSE).
