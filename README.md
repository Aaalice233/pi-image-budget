# pi-image-budget

[简体中文](README.zh-CN.md)

A [Pi](https://pi.dev) extension that keeps image payloads in every model request within count and byte budgets, so long screenshot-heavy sessions never get stuck on `413 Request exceeds the maximum size`.

## The problem

Pi resends the whole conversation on every request, and images stay in it forever. Pi resizes each image only when it exceeds 2000×2000 px or 4.5 MB, so a typical 1920×1080 PNG screenshot (2–3.5 MB of base64) goes in unchanged. Read a dozen screenshots over a session and every request is 30+ MB. Gateways commonly cap request bodies at 20–32 MB, and from then on **every** request fails, including retries. Compaction does not help because it counts tokens, not image bytes. Upstream treats this as extension territory (earendil-works/pi#4642).

## What it does

Before every provider request, on a per-request copy (the session file is never modified):

1. **Image count budget**: keep at most `maxImages` images (default 8).
2. **Image byte budget**: kept images total at most `maxImageBytes` (default 16 MB).
3. **Request size budget**: the whole estimated request body stays under `maxRequestBytes` (default 24 MB). The estimate is calibrated against the real serialized payload after the first request.
4. **Oldest first, newest protected**: the oldest images are replaced with a short text placeholder that names the source (for example `read D:/shots/ads.png (1920x1080, image/png, 3.1 MB)`), so the model knows it can read the file again. The newest `protectRecent` images (default 2) are never removed by budgets.
5. **Cache friendly**: when a budget is exceeded, it evicts in one batch down to `limit × lowWatermark` (default 0.75), and evicted images stay evicted with byte-identical placeholders. The request prefix changes rarely, so provider prompt caches keep hitting.
6. **Dedupe**: if the same image appears twice, only the newest copy is kept.
7. **413 recovery**: if a gateway still rejects a body as too large (HTTP 413, or an equivalent error text), the limit for this model is lowered to 90% of the rejected size, stored in the session so it survives restarts, and the turn is retried automatically without the failed response.
8. **Payload guard**: if the final provider payload still exceeds the limit (for example on the first request, before calibration), the oldest images are replaced directly in the payload. It supports Anthropic, OpenAI Chat/Responses, Gemini, and Bedrock wire formats.
9. **Honors model catalog limits**: `inputLimits.maxRequestBytes`, `images.maxPerRequest`, and `images.maxPerMessage` from `models.json` are enforced. Pi documents these fields but does not enforce them yet.

## Install

```bash
pi install npm:pi-image-budget
```

It works with the defaults as soon as it is installed. The footer shows `img 6/14` whenever some images are omitted.

It pairs well with a per-model resize profile, which makes each image small in the first place:

```json
// ~/.pi/agent/models.json → your model entry
"inputLimits": { "images": { "resize": { "maxWidth": 1568, "maxHeight": 1568, "maxBytes": 1048576 } } }
```

## Configuration

Optional. Global: `~/.pi/agent/image-budget.json`. Project (only when the project is trusted): `.pi/image-budget.json`, layered on top of the global file.

```json
{
  "$schema": "https://unpkg.com/pi-image-budget/image-budget.schema.json",
  "maxImages": 8,
  "maxImageBytes": "16MB",
  "maxRequestBytes": "24MB",
  "protectRecent": 2,
  "models": {
    "my-gateway/*": { "maxRequestBytes": "30MB" },
    "github-copilot/*": { "maxRequestBytes": "4MB", "maxImages": 3 }
  }
}
```

| Option | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Master switch |
| `maxImages` | `8` | Images kept per request |
| `maxImagesPerMessage` | unlimited | Images kept per message |
| `maxImageBytes` | `16MB` | Total base64 bytes of kept images |
| `maxRequestBytes` | `24MB` | Estimated whole request body |
| `protectRecent` | `2` | Newest images that budgets never remove |
| `lowWatermark` | `0.75` | Evict down to `limit × ratio` once a limit is hit |
| `dedupe` | `true` | Keep only the newest copy of identical images |
| `payloadGuard` | `true` | Last-resort scrub of the provider payload |
| `autoRecover` | `true` | Lower the limit and retry after a 413 |
| `maxAutoRecoveries` | `2` | Automatic 413 retries per prompt |
| `initialOverheadBytes` | `512KB` | Assumed system prompt/tool size before the first measurement |
| `showStatus` | `true` | Footer indicator when images are omitted |
| `locale` | `auto` | `en`, `zh-CN`, or `auto` |
| `models` | `{}` | Overrides of the limit options by `provider/modelId` glob |

Sizes accept bytes, `"512KB"`, `"24MB"`, and so on (1024-based), or `null` for unlimited. Invalid entries are reported once and ignored; the rest of the file still applies. Later `models` globs win, and model catalog limits only ever tighten the result.

## Command

`/image-budget [status|on|off|reset|reload]`

- `status`: effective limits, last request statistics, and config sources.
- `on` / `off`: toggle for this session.
- `reset`: forget the learned 413 limit and eviction history for this session.
- `reload`: re-read the config files.

## Limitations

- Omitted images are gone from the model's view until they are read again. Raise `maxImages` or `protectRecent` if your workflow compares many images at once.
- The per-message cap applies to Pi messages. Providers that merge consecutive tool results into one wire message may see more images per message.
- Existing oversized sessions recover on the next request after installing. The session file itself is not rewritten.

## Development

```bash
npm install
npm run check      # TypeScript
npm test           # unit + extension-wiring tests
node scripts/e2e.mjs [--without-extension] [--with-user-packages]
```

`scripts/e2e.mjs` runs the real `pi` CLI against a mock gateway that answers 413 above 8 MB. Without the extension, the session gets stuck; with it, the session recovers and stays usable.

## License

MIT
