# pi-image-budget

[中文文档与完整配置表](README.zh-CN.md)

A Pi extension that reduces image-heavy requests **before** they hit relay/provider limits. Original images and session messages are untouched: only outbound copies are rewritten. This cannot cure rate limits, overloaded servers, billing errors, or text-only context overflow.

## Strategy

- Keep at most **12 images** by default; prefer original quality for the newest **2**.
- Compress older candidates to **1280px / 400KiB base64**, then omit the oldest images only if budgets still overflow. Output may be PNG or lossy JPEG. Reduced images carry dimension/coordinate mapping notes.
- Enforce **2000px / 4.5MiB base64** per-image caps even on protected images. If protected images alone overflow the request, try compressing them too.
- Enforce total **16MiB image data / 24MiB JSON body** budgets, with a **0.75 low watermark** for batch eviction. Keep omission text stable within a branch.
- Deduplicate only byte-identical images of the same MIME type; sampled fingerprints are not treated as proof of equality.
- Measure every final provider envelope without allocating another full JSON request string. Guard known Anthropic, OpenAI Chat/Responses, Gemini and Bedrock content arrays, including merged-message count caps. Never walk tool schemas or arbitrary metadata looking for images.

## Recovery

Recognizes HTTP 413, `Request exceeds the maximum size`, `exceeded request buffer limit while retrying upstream`, image-count, single-image byte and dimension errors. Only numbers clearly associated with limits are learned. Limits follow the model and active session branch.

Learning happens at `message_end`, before Pi's own transient-error retry. The extension can initiate up to **2** additional continuations per input, only when the relevant metric actually shrinks. `autoRecover` and `maxAutoRecoveries` do **not** override Pi's native retry policy.

An invalid-image error only removes an image when a single-image request identifies it unambiguously. Multi-image errors are reported rather than guessing which image is corrupt. Compression failures are visible; originals under hard caps remain, oversized ones become placeholders. If the request still cannot fit, the extension warns instead of claiming success.

## Performance and privacy

Uses Pi's exported Photon `resizeImage`, no extra image dependency. At most two encodes run concurrently, only for candidates that can survive the count cap. First-time encoding can take around a second per screenshot; worker loading failures may make Pi fall back to in-process encoding.

An in-memory LRU cache is bounded by **128 entries and 32MiB**, keyed by full SHA-256, MIME and target parameters. Failed encodes are cached too. No extra copies of screenshots are persisted on disk; cache eviction/restart may require deterministic re-encoding. Neutral message estimates count base64 lengths directly, while final payload sizing handles actual JSON escaping.

## Installation

```sh
pi install git:github.com/Aaalice233/pi-image-budget
```

Run `/reload` after updating an existing checkout. Optional configuration: `~/.pi/agent/image-budget.json`, then trusted-project `.pi/image-budget.json`.

```json
{
  "maxImages": 12,
  "compress": true,
  "compressMaxDimension": 1280,
  "compressMaxBytes": "400KB",
  "maxBytesPerImage": "4.5MB",
  "maxImageDimension": 2000,
  "protectRecent": 2,
  "models": { "my-gateway/*": { "maxRequestBytes": "12MB" } }
}
```

See [the schema](image-budget.schema.json) and [configuration table](README.zh-CN.md#安装与配置) for all options. Byte units are binary. Total count/byte limits accept `null` for unlimited; resize targets, retry count and protected count must be finite. Catalog `inputLimits` only tighten configured values, including image resize dimensions and bytes.

`/image-budget [status|on|off|reset|reload]` shows statistics, controls the session switch, resets the current model's learned limits/invalid-image records and omissions, or reloads config. Footer statistics represent the neutral planning phase; further payload-guard removals are notified separately.

## Development

```sh
npm ci
npm run check
npm test
npm run bench
node scripts/e2e.mjs --turns=10
node scripts/e2e.mjs --buffer-error --turns=10
node scripts/e2e.mjs --without-extension
```

Tests cover real Photon encoding, memory bounds, config, branches, recovery, JSON sizing and provider envelopes. E2E uses a real local Pi CLI and an 8MiB mock gateway, without paid API calls. Work files live in `.tmp/e2e-work` and are normally cleaned up. The benchmark separates warm planning, final sizing, and original serialization; it does not claim to include first-time image encoding or Pi's context cloning.

MIT.
