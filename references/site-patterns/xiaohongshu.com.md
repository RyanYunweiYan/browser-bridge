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
- **xsec_token 一帖一密，绝对不能复用**：每个帖子的 xsec_token 绑定该帖子 ID，把 A 帖子的 token 拼到 B 帖子的 URL 会触发 300017 安全限制（"访问链接异常"）。正确做法：每次都回搜索结果页，重新点击目标帖子获取它自己的 token (2026-04-04)
- 多帖子浏览的正确模式：搜索 → 点击帖子A → 读完 → 浏览器后退回搜索页 → 点击帖子B → 读完 → 后退 → 点击帖子C。不要手动构造 URL，不要复用 token (2026-04-04)
- Aggressive anti-bot: avoid dense automated requests, pace operations with 3-5s intervals between page loads (2026-04-04)
