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

A Node.js proxy translates 12 ergonomic HTTP endpoints into Chrome DevTools Protocol commands. The agent calls the proxy via the authenticated `proxy-client.mjs` helper; the proxy drives your already-running Chrome instance.

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

Run `scripts/check-env.mjs` to start the protected proxy. It creates one random credential in the current user's private runtime directory `~/.cache/browser-bridge/` (directory mode 0700, file mode 0600). This directory is outside the Skill and must not enter backups. The proxy and `scripts/proxy-client.mjs` read it internally; never read, print, copy, or ask the user to paste its value. A malformed, symlinked, or non-private credential file causes a safe stop. `CDP_PROXY_STATE_DIR` can select an isolated runtime directory for testing. An explicitly provided `CDP_PROXY_AUTH_TOKEN` is supported for managed environments, but must not be logged.

Use `proxy-client.mjs` for all browser-control and status calls. It verifies the process on the port using a random `/auth-challenge` before sending the credential in `X-CDP-Proxy-Token`; it refuses redirects and non-local destinations. The server validates the exact `127.0.0.1` Host and rejects any Origin header. Unknown services on the port cause a safe stop; do not kill them automatically. Existing clients without the header receive HTTP 401. Replace their raw curl calls with the helper. Same-user malware and the separate Chrome debugging port are outside this HTTP credential boundary.

To roll back, stop only this proxy and restore the backed-up files; restoring old code also restores its unauthenticated behavior. Do not delete browser data. `CDP_CHROME_PORT` may pin the intended local Chrome debug port, especially for an isolated test browser.


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
