---
domain: xiaohongshu.com
aliases: [小红书, RED, xhs]
updated: 2026-04-04
---
## Platform Notes
JS-rendered SPA, content requires login for search and some features.
Dark theme UI. Comments lazy-load on scroll.

## Effective Patterns
- Search via URL: `https://www.xiaohongshu.com/search_result?keyword=ENCODED_KEYWORD&source=web_search_result_notes`
- Post content selector: `#detail-desc .note-text`
- Author: `.username` or `a.name`
- Engagement counts: `[class*=like] .count`, `[class*=collect] .count`, `[class*=chat] .count`
- Date: `.date` or `[class*=date]`
- Search result cards: `section.note-item` with links `a[href*=explore]`
- Comments: `[class*=comment] [class*=content]`
- Login popup close: `.close-button`

## Known Issues
- New tabs via Target.createTarget do NOT inherit login cookies — must use user's existing logged-in tab (2026-04-04)
- Direct URL navigation to posts fails without xsec_token — must click through from search results or feed, the click carries the full token automatically (2026-04-04)
- Aggressive anti-bot: avoid dense automated requests, pace operations
