# Activity Monitor

A Claude Code plugin that opens an **Activity** pane beside the chat. It shows a live feed of every tool call Claude makes, what each one cost, and how full the context window is.

## What it shows

### Top bar
- **Counts.** How many calls, how many are running, and how many failed. In a narrow pane the words drop and `|` separates the numbers.
- **Model.** The emoji and name of the model that answered last. Click it (marked **≡**) to open the menu.
- **Session totals.** Three lines under the top bar:
  - `Tokens: 15.0M ($4.34)`: context sent, and what the session has spent (green).
  - `Cached: 14.7M ($41.27)`: how much of it was read from the cache, and what that saved (gray).
  - `Written: 61k`: what the model wrote.

  They count every response, including final answers that call no tools.

### The ≡ menu
Click the model name to open it; click again to close it.
- **Models.** Pick one to run `/model` for you. If Claude is mid-reply, the switch waits until the reply finishes. The name in the top bar changes after the next request, because it shows the model that actually answered.
- **◉ Show Totals.** Hides or shows the three totals lines.
- **◉ Show Commands.** Hides or shows the text after each tool name (the file, command or pattern). While hidden, a `›` follows each tool name: click the name to show that one call's target. The `showTargets` setting picks whether targets start shown.
- **💾 Save Log.** Writes the feed to a text file: the session totals, then one line per call (time, status, duration, tokens, cost, savings, model, tool, target). Files go to `claude-activity-logs` in your home folder unless `logFolder` says otherwise, named by date and time, so each save is a new file.
- **✕ Clear Logs.** Empties the feed and resets the totals.

### The feed
One entry per tool call, newest first, including calls made by sub-agents. Scroll it with the mouse wheel (or the arrow keys while the pane has focus).
- **Left column.** `↑` is the context sent to the model and `↓` is what the model wrote back; `÷N` means N calls shared one response, so its tokens are split between them. Below them: the model emoji (🧠 Opus, 🎵 Sonnet, 🍃 Haiku, 🦉 Fable, ❔ anything else) with the call's cost in green, the 💵 cache savings in gray, and the call's duration and start time.
- **Right column.** A mark for the result (⚡ worked, 💥 failed), the tool name, and its target.

Cost is the call's share of the response's price at Anthropic's public API list prices. Savings compare cache reads with sending the same tokens uncached.

### Bottom
- **Context meter.** A bar shows how full the context window is. It turns yellow at 75% and red at 90%. In yellow or red you can **click the bar to run `/compact`**. A quick question then asks what the summary should focus on, as `/compact <focus>` does. Press Enter on **Compact now** to skip it, pick **Focus on current task**, or type your own focus under Other. Esc cancels. The meter updates as soon as any compaction finishes. In a narrow pane the Context label drops.
- **Cache status.** 🌡 **Warm** shows how long the prompt cache stays warm and how long you've been idle. While it's warm, your next message reads the conversation from the cache at a fraction of the normal price. Once it expires, the next message sends the whole conversation again and pays to rewrite the cache. Nothing in the conversation is lost either way; only the cost changes.
  - In the last few minutes before it expires (5 by default, see `coolingMinutes`), the line says 🧊 **Cooling** and shows **↻**. Press it to keep the cache warm: a tiny request reads the cache and restarts its timer, which costs far less than a rewrite later. It's worth doing if you'll keep working in this session.
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
| `costColor` | green | Color of dollar spend: per call and the session total (first amount) |
| `savingsIcon` / `savingsColor` | 💵 / gray | Cache savings: per call and the session total (second amount) |
| `totalsLabelColor` / `totalsValueColor` | dim / dim | Labels (Tokens, Cached, Written) and numbers on the token totals lines; leave blank for dim |
| `warmIcon` / `coolingIcon` | 🌡 / 🧊 | Mark in front of Warm and Cooling on the cache status line |
| `okIcon` / `errorIcon` | ⚡ / 💥 | Mark beside a call that worked, and one that failed |
| `logFolder` | (home)/claude-activity-logs | Where Save Log writes its files |
| `showTargets` | true | Show each call's target after the tool name (Show Commands in the model list overrides it for the session) |
| `askCompactFocus` | true | Ask for focus instructions when the bar is clicked to compact |
| `outgoingColor` / `incomingColor` | `#F7931A` / cyan | Colors of `↑` and `↓` |
| `rowSeparatorColor` | black | Line between calls in the feed |
| `callsColor`, `runColor`, `failColor`, `modelColor`, `separatorColor`, `contextLabelColor` | — | Colors in the top bar and meter label |

A color can be a name such as `cyan`, or a hex value such as `#F7931A`.

## License

MIT. See [LICENSE](LICENSE).
