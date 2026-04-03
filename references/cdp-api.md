# CDP Proxy API Reference

## 1. Overview

The CDP Proxy provides a simplified HTTP interface to Chrome DevTools Protocol, enabling browser automation without managing WebSocket connections directly.

| Property        | Value                          |
|-----------------|--------------------------------|
| **Base URL**    | `http://127.0.0.1:9400`       |
| **Protocol**    | HTTP (GET and POST)            |
| **Response**    | JSON                           |

**Success response:**
```json
{"ok": true, ...}
```

**Error response:**
```json
{"ok": false, "error": "description of what went wrong"}
```

**General rules:**
- All `target` parameters refer to a Chrome tab ID (obtained from `/targets` or `/new`).
- POST endpoints accept plain text bodies unless noted otherwise.
- The proxy auto-connects to Chrome via its DevTools WebSocket. If Chrome is not running or the connection drops, endpoints return an error with `"ok": false`.

---

## 2. Endpoint Reference

### 2.1 GET /health

Check proxy status. Does **not** require an active Chrome connection.

| Field     | Value       |
|-----------|-------------|
| Method    | `GET`       |
| Params    | None        |

```bash
curl http://127.0.0.1:9400/health
```

```json
{"ok": true, "connected": true}
```

If Chrome is not connected, `connected` will be `false` but the response is still `ok: true` (the proxy itself is healthy).

---

### 2.2 GET /targets

List all open browser tabs.

| Field     | Value       |
|-----------|-------------|
| Method    | `GET`       |
| Params    | None        |

```bash
curl http://127.0.0.1:9400/targets
```

```json
{
  "ok": true,
  "targets": [
    {"id": "ABC123", "title": "Google", "url": "https://www.google.com/"},
    {"id": "DEF456", "title": "GitHub", "url": "https://github.com/"}
  ]
}
```

---

### 2.3 GET /new

Create a new background tab and navigate to a URL. Automatically waits for page load.

| Field     | Value                      |
|-----------|----------------------------|
| Method    | `GET`                      |
| Params    | `url` (required) — the URL to open |

```bash
curl "http://127.0.0.1:9400/new?url=https://example.com"
```

```json
{"ok": true, "target": "GHI789", "title": "Example Domain", "url": "https://example.com/"}
```

---

### 2.4 GET /close

Close a tab.

| Field     | Value                             |
|-----------|-----------------------------------|
| Method    | `GET`                             |
| Params    | `target` (required) — tab ID     |

```bash
curl "http://127.0.0.1:9400/close?target=GHI789"
```

```json
{"ok": true}
```

---

### 2.5 GET /navigate

Navigate an existing tab to a new URL. Automatically waits for page load and returns the final URL (follows redirects).

| Field     | Value                                        |
|-----------|----------------------------------------------|
| Method    | `GET`                                        |
| Params    | `target` (required), `url` (required)        |

```bash
curl "http://127.0.0.1:9400/navigate?target=ABC123&url=https://github.com/trending"
```

```json
{"ok": true, "url": "https://github.com/trending", "title": "Trending repositories on GitHub"}
```

---

### 2.6 GET /info

Get page title, URL, and ready state for a tab.

| Field     | Value                             |
|-----------|-----------------------------------|
| Method    | `GET`                             |
| Params    | `target` (required) — tab ID     |

```bash
curl "http://127.0.0.1:9400/info?target=ABC123"
```

```json
{"ok": true, "title": "Google", "url": "https://www.google.com/", "readyState": "complete"}
```

---

### 2.7 POST /eval

Execute arbitrary JavaScript in the target tab and return the result.

| Field     | Value                                     |
|-----------|-------------------------------------------|
| Method    | `POST`                                    |
| Params    | `target` (required) — tab ID (query)     |
| Body      | Plain text JavaScript expression           |

```bash
curl -X POST "http://127.0.0.1:9400/eval?target=ABC123" \
  -d "document.title"
```

```json
{"ok": true, "value": "Google"}
```

The body is evaluated as an expression. For complex logic, wrap in an IIFE:

```bash
curl -X POST "http://127.0.0.1:9400/eval?target=ABC123" \
  -d "(()=>{ const links = document.querySelectorAll('a'); return links.length; })()"
```

---

### 2.8 POST /click

Click a DOM element matching a CSS selector.

| Field     | Value                                     |
|-----------|-------------------------------------------|
| Method    | `POST`                                    |
| Params    | `target` (required) — tab ID (query)     |
| Body      | Plain text CSS selector                    |

```bash
curl -X POST "http://127.0.0.1:9400/click?target=ABC123" \
  -d "button.submit"
```

```json
{"ok": true}
```

---

### 2.9 POST /type

Type text into a DOM element. Uses `Input.insertText` for compatibility with frameworks that don't listen to key events.

| Field     | Value                                           |
|-----------|-------------------------------------------------|
| Method    | `POST`                                          |
| Params    | `target` (required) — tab ID (query)           |
| Body      | JSON: `{"selector": "...", "text": "..."}`      |

```bash
curl -X POST "http://127.0.0.1:9400/type?target=ABC123" \
  -H "Content-Type: application/json" \
  -d '{"selector": "input[name=q]", "text": "CDP automation"}'
```

```json
{"ok": true}
```

---

### 2.10 POST /press

Press a keyboard key.

| Field     | Value                                     |
|-----------|-------------------------------------------|
| Method    | `POST`                                    |
| Params    | `target` (required) — tab ID (query)     |
| Body      | Plain text key name                        |

**Supported keys:** `Enter`, `Tab`, `Escape`, `Backspace`, `ArrowDown`, `ArrowUp`, `ArrowLeft`, `ArrowRight`, `Space`

```bash
curl -X POST "http://127.0.0.1:9400/press?target=ABC123" \
  -d "Enter"
```

```json
{"ok": true}
```

---

### 2.11 GET /screenshot

Capture the visible viewport as a PNG image. Saved to `/tmp/cdp-shots/`.

| Field     | Value                             |
|-----------|-----------------------------------|
| Method    | `GET`                             |
| Params    | `target` (required) — tab ID     |

```bash
curl "http://127.0.0.1:9400/screenshot?target=ABC123"
```

```json
{"ok": true, "file": "/tmp/cdp-shots/ABC123-1717200000000.png"}
```

---

### 2.12 GET /scroll

Scroll the page in a given direction. Waits 600ms after scrolling for lazy-loaded content to render.

| Field     | Value                                                    |
|-----------|----------------------------------------------------------|
| Method    | `GET`                                                    |
| Params    | `target` (required), `direction` (required), `y` (optional) |

**Direction values:** `up`, `down`, `top`, `bottom`

The `y` parameter specifies scroll amount in pixels (used with `up`/`down`).

```bash
# Scroll down 500px
curl "http://127.0.0.1:9400/scroll?target=ABC123&direction=down&y=500"

# Jump to top
curl "http://127.0.0.1:9400/scroll?target=ABC123&direction=top"
```

```json
{"ok": true}
```

---

## 3. JS Extraction Patterns

Reusable JavaScript expressions for `/eval`. Copy these directly as the POST body.

### Get all links

```javascript
Array.from(document.querySelectorAll('a[href]')).map(a=>({text:a.textContent.trim(),href:a.href}))
```

### Get page text

```javascript
document.body.innerText
```

### Get all images

```javascript
Array.from(document.querySelectorAll('img[src]')).map(i=>({alt:i.alt,src:i.src}))
```

### Get meta info

```javascript
JSON.stringify({title:document.title,desc:document.querySelector('meta[name=description]')?.content})
```

### Check login indicators

```javascript
!!document.querySelector('.user-avatar, .profile-link, [data-user], .logout')
```

Returns `true` if common login-state elements exist on the page.

### Extract table data

```javascript
Array.from(document.querySelectorAll('table')).map(t=>Array.from(t.rows).map(r=>Array.from(r.cells).map(c=>c.textContent.trim())))
```

Returns a 3D array: `tables[tableIndex][rowIndex][cellIndex]`.

### Shadow DOM traversal

```javascript
(function walk(root){const els=[];root.querySelectorAll('*').forEach(el=>{els.push(el);if(el.shadowRoot)els.push(...walk(el.shadowRoot))});return els})(document).filter(el=>el.matches('a[href]')).map(a=>({text:a.textContent.trim(),href:a.href}))
```

Recursively enters shadow roots to find elements that normal `querySelectorAll` misses (common in Web Components).

---

## 4. Multi-Step Recipes

### Search and extract results

Open a search engine, type a query, press Enter, then extract links from the results page.

```bash
# 1. Open Google
TARGET=$(curl -s "http://127.0.0.1:9400/new?url=https://www.google.com" | jq -r .target)

# 2. Type search query
curl -s -X POST "http://127.0.0.1:9400/type?target=$TARGET" \
  -H "Content-Type: application/json" \
  -d '{"selector": "textarea[name=q]", "text": "browser automation CDP"}'

# 3. Press Enter to submit
curl -s -X POST "http://127.0.0.1:9400/press?target=$TARGET" -d "Enter"

# 4. Wait for results to load
sleep 2

# 5. Extract result links
curl -s -X POST "http://127.0.0.1:9400/eval?target=$TARGET" \
  -d "Array.from(document.querySelectorAll('h3')).map(h=>({title:h.textContent,href:h.closest('a')?.href}))"
```

### Scroll through a feed

Incrementally scroll a page and collect content as it lazy-loads.

```bash
TARGET="ABC123"

# Collect items after each scroll
for i in $(seq 1 5); do
  curl -s "http://127.0.0.1:9400/scroll?target=$TARGET&direction=down&y=800"
  curl -s -X POST "http://127.0.0.1:9400/eval?target=$TARGET" \
    -d "document.querySelectorAll('.feed-item').length"
done
```

### Login check before action

Check if the user is logged in before navigating to a protected page.

```bash
TARGET="ABC123"

# Check login state
LOGGED_IN=$(curl -s -X POST "http://127.0.0.1:9400/eval?target=$TARGET" \
  -d "!!document.querySelector('.user-avatar, .profile-link, [data-user], .logout')" \
  | jq -r .value)

if [ "$LOGGED_IN" = "true" ]; then
  curl -s "http://127.0.0.1:9400/navigate?target=$TARGET&url=https://example.com/dashboard"
else
  echo "Not logged in. Navigate to login page manually."
fi
```

---

## 5. Troubleshooting

| Error | Cause | Solution |
|-------|-------|----------|
| `"error": "not connected"` | Chrome is not running or the WebSocket dropped. | Start Chrome with `--remote-debugging-port=9222` and restart the proxy. |
| `"error": "target not found"` | The tab ID is invalid or the tab was closed. | Call `/targets` to get current valid IDs. |
| `"error": "no such selector"` or click/type fails | The CSS selector doesn't match any element. | Verify the selector with `/eval` first: `document.querySelector('...')`. The page may not be fully loaded. |
| `/eval` returns `null` or `undefined` | The JS expression evaluated to nothing. | Ensure you return a value. Wrap in an IIFE if using statements. |
| `/navigate` returns a different URL than requested | The site redirected. | This is expected behavior. The returned `url` is the final destination after all redirects. |
| `/screenshot` returns error about directory | The `/tmp/cdp-shots/` directory could not be created. | Check filesystem permissions. The proxy attempts to create the directory automatically. |
| `/type` doesn't fill the field | The input field uses a framework (React/Vue) that ignores synthetic key events. | `/type` uses `Input.insertText` which handles most frameworks. If still failing, try `/click` on the field first, then `/type`. |
| `/scroll` doesn't load new content | The page needs more time for lazy loading, or scroll distance is too small. | Increase the `y` value or call `/scroll` multiple times. The built-in 600ms wait handles most cases. |
| Proxy itself is unreachable | The proxy process is not running. | Start the proxy server. Verify with `curl http://127.0.0.1:9400/health`. |
| WebSocket CLOSING state errors | The connection is in a transitional state. | Wait briefly and retry. The proxy has built-in guards for this state. |
