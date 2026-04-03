---
name: browser-bridge
description: >
  Access and interact with websites through the user's Chrome browser via CDP proxy,
  with intelligent tool selection for web research. Use when user asks to browse websites,
  read web pages, interact with web applications, research topics online, check social media,
  or access login-required sites. Also use when WebSearch/WebFetch fail and a fallback is needed,
  or when the user mentions Chrome, browser, CDP, web scraping, or site interaction.
  Trigger on: 网页, 浏览器, 搜索, 抓取, 小红书, 微博, Twitter, 公众号.
---

# Browser Bridge

## Prerequisites

Before any browser operation, verify environment:

```bash
node ~/.claude/skills/browser-bridge/scripts/check-env.mjs
```

This checks Node.js, Chrome debug port, and starts the CDP Proxy if needed.

## Tool Selection

| Scenario | First choice | Fallback chain |
|----------|-------------|----------------|
| Keyword search, discover sources | WebSearch | — |
| Read article/docs at known URL | WebFetch | curl → Jina (r.jina.ai/URL) → CDP |
| Need raw HTML (meta tags, JSON-LD) | curl | CDP /eval |
| JS-rendered SPA content | CDP /new + /eval | — |
| Login-required site | CDP (uses Chrome login state) | — |
| Form submission / interaction | CDP /type + /click + /press | — |

**Jina** (optional, saves tokens): Prefix URL with `r.jina.ai/` to get Markdown conversion.
Good for articles/docs. Bad for dashboards, e-commerce, data-heavy pages.

### Degradation principle

Each step's result is evidence — don't retry the same method expecting different results.
Move to next tool in the chain. If WebFetch returns garbage, try curl or Jina.
If static methods all fail, escalate to CDP.

## Core Principles

1. **Evidence-driven progression** — Every result tells you something. Failed fetch ≠ "try again", it means "try differently"
2. **Login delay** — Always attempt to get content first. Only ask user to login when you've confirmed the content is gated AND login would solve it
3. **Trust site-generated links** — URLs extracted from page DOM carry full context (session tokens, query params). Hand-constructed URLs may miss implicit required params
4. **Skeptical of platform errors** — A platform returning "content not found" or "page doesn't exist" may be an access-method issue (anti-bot, missing params), not a real 404

## Information Research

For keyword searches and competitive analysis:

1. Start with **WebSearch** to discover sources
2. For each promising source: **WebFetch** to extract key info
3. If a source blocks WebFetch: escalate to **CDP** (open in browser, /eval to extract)
4. Cross-reference claims across sources — search engines discover, they don't verify

**Output format**: Structured findings with source URL and access date for each claim.

## Read Known URL

When the URL is already known:

1. **WebFetch** with a focused prompt — fastest path
2. If content is incomplete/blocked: **curl** the URL, or **Jina** (`r.jina.ai/domain.com/path`)
3. If JS-rendered: **CDP** `/new?url=URL` then `/eval` with `document.body.innerText`
4. For PDF URLs: download with curl, read with built-in PDF tools

## Platform Operations

For social platforms and login-required sites:

### Before operating

Check for site experience:
```bash
node ~/.claude/skills/browser-bridge/scripts/match-site.mjs "domain"
```

### Risk levels

- **Read-only** (browse public content, view profiles): Proceed without warning
- **Write operations** (post, comment, like): Warn user of platform risk, proceed only after confirmation
- **Batch automation** (mass actions): Refuse — too high risk of account ban

### CDP workflow

1. Run check-env to ensure proxy is ready
2. `/new?url=TARGET_URL` — open in background tab
3. `/eval` — check page state, extract content
4. `/click`, `/type`, `/press` — interact as needed
5. `/close` — clean up tab when done

Always close tabs you created. Never close user's existing tabs.

## CDP Proxy API

Base: `http://127.0.0.1:9400` — All responses: `{"ok":true,...}` or `{"ok":false,"error":"..."}`

| Endpoint | Method | Body/Params | Purpose |
|----------|--------|-------------|---------|
| /health | GET | — | Check proxy status |
| /targets | GET | — | List open tabs |
| /new | GET | ?url= | Create background tab |
| /close | GET | ?target= | Close tab |
| /navigate | GET | ?target=&url= | Navigate tab |
| /info | GET | ?target= | Page title/URL/state |
| /eval | POST | JS expression | Execute JavaScript |
| /click | POST | CSS selector | Click element |
| /type | POST | {"selector","text"} | Type into element |
| /press | POST | Key name | Press key (Enter, Tab...) |
| /screenshot | GET | ?target= | Capture to /tmp/cdp-shots/ |
| /scroll | GET | ?target=&direction= | Scroll (up/down/top/bottom) |

For detailed API docs, JS extraction patterns, and multi-step recipes:
read `references/cdp-api.md`

## Technical Facts

- DOM contains loaded but hidden content (carousel frames, collapsed sections, lazy placeholders) — access via /eval regardless of visibility
- Shadow DOM and iframes are selector boundaries — use recursive /eval to traverse
- /scroll to bottom triggers lazy loading — scroll before extracting images
- Public resources: download directly after getting URL from DOM. Login-required: stay in browser
- Dense /new requests may trigger anti-bot — pace parallel operations
- Platform "content not found" messages may reflect access-method issues, not actual 404s

## Parallel Sub-Agent Dispatch

When researching multiple independent targets (e.g., "research these 5 competitors"):

- Dispatch one sub-agent per target using the Agent tool
- Each sub-agent shares the same proxy (127.0.0.1:9400) but creates its own tabs
- No conflicts — different targetIds, same Chrome instance

**Sub-agent prompt guidelines:**
- Include: `Must load browser-bridge skill and follow its guidance`
- Describe the **goal** ("find pricing info for X"), not the **method** ("search for X")
- Avoid verbs that anchor to specific tools ("search" → WebSearch, "scrape" → CDP)
- Use neutral verbs: "find", "investigate", "gather", "determine"

## Site Experience

Accumulated per-domain knowledge stored in `references/site-patterns/`.

**Before operating**: Run match-site.mjs to check for existing experience.
**After success**: If you discovered useful patterns (URL structure, anti-bot behavior,
effective selectors, login requirements), write a new experience file:

```markdown
---
domain: example.com
aliases: [示例, example]
updated: YYYY-MM-DD
---
## Platform Notes
[Architecture, auth model, content loading behavior]

## Effective Patterns
[Verified URL patterns, selectors, API endpoints]

## Known Issues
[What fails and why — dated]
```

## Security Notice

The `/eval` endpoint executes arbitrary JavaScript in the user's real browser session.
This is powerful but carries risk — only execute on intended target pages.
Never eval untrusted or user-provided code without review.
