# Browser Bridge

A [Claude Code](https://docs.anthropic.com/en/docs/claude-code) skill that gives the agent access to your real Chrome browser via Chrome DevTools Protocol (CDP).

When `WebSearch` and `WebFetch` aren't enough — login-required sites, JS-rendered SPAs, anti-bot platforms — Browser Bridge lets Claude operate inside the same Chrome session you're already logged into.

## What it solves

| Limitation | Browser Bridge does |
|---|---|
| `WebFetch` returns empty on JS-rendered pages | `/eval` extracts after render |
| Login-required content (X, 小红书, 公众号 backend) | Reuses your existing Chrome login state |
| Anti-bot blocks (Cloudflare, fingerprinting) | You're a real user — no headless detection |
| Form submission, multi-step interaction | `/click` + `/type` + `/press` |

## How it works

```
Claude Code  ──(HTTP)──►  CDP Proxy (127.0.0.1:9400)  ──(WebSocket)──►  Your Chrome
```

A Node.js proxy translates 12 ergonomic HTTP endpoints into Chrome DevTools Protocol commands. The agent calls the proxy via `curl`; the proxy drives your already-running Chrome instance.

## Setup

1. Launch Chrome with remote debugging enabled:
   ```bash
   /Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
     --remote-debugging-port=9222
   ```

2. Install the skill into Claude Code's skills directory:
   ```bash
   git clone https://github.com/RyanYunweiYan/browser-bridge ~/.claude/skills/browser-bridge
   ```

3. Verify the environment:
   ```bash
   node ~/.claude/skills/browser-bridge/scripts/check-env.mjs
   ```

The skill auto-activates when you mention browsing, scraping, or specific platforms (小红书, 微博, Twitter, 公众号).

## API surface

12 endpoints on `127.0.0.1:9400`:

| Endpoint | Purpose |
|---|---|
| `/health`, `/targets` | Proxy status, list tabs |
| `/new`, `/close`, `/navigate` | Tab lifecycle |
| `/info` | Page title / URL / state |
| `/eval` | Execute JS in page context |
| `/click`, `/type`, `/press` | UI interaction |
| `/scroll`, `/screenshot` | Inspection |

Full reference: [`references/cdp-api.md`](references/cdp-api.md).

## Tool-selection strategy

The skill teaches the agent a **degradation chain** instead of reflexively reaching for CDP:

```
WebSearch  →  WebFetch  →  curl / Jina  →  CDP
(discover)  (read public)  (raw HTML)    (auth / SPA / anti-bot)
```

Each step's failure is evidence — the agent moves down the chain rather than retrying the same tool. CDP is the heaviest option, used last.

## Site experience

Per-domain knowledge accumulates in `references/site-patterns/`. After a successful session on a new site, the agent writes down what it learned (URL patterns, selectors, anti-bot quirks) so the next session starts informed.

Example: [`xiaohongshu.com.md`](references/site-patterns/xiaohongshu.com.md) — covers the `xsec_token` one-per-post rule and the correct multi-post browsing flow.

## Security

`/eval` executes arbitrary JavaScript in your real browser session. Only point it at intended targets. Never eval untrusted or user-provided code without review.

## License

MIT
