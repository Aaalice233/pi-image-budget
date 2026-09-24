# pi-image-budget

[English](README.md)

[Pi](https://pi.dev) 扩展：给每次模型请求里的图片设数量和体积预算，截图多的长会话也不会卡在 `413 Request exceeds the maximum size`。

## 问题

Pi 每轮都把整个对话重新发一遍，图片会一直留在对话里。Pi 只在单张图超过 2000×2000 像素或 4.5 MB 时才压缩，所以常见的 1920×1080 PNG 截图（base64 后 2–3.5 MB）会原样进入历史。一个会话里读过十来张截图，每次请求就超过 30 MB。网关的请求体上限通常在 20–32 MB，一旦超过，**之后每次请求都失败，重试也没用**。自动压缩按 token 计算，不看图片体积，所以也救不回来。上游认为这应该由扩展解决（earendil-works/pi#4642）。

## 功能

每次请求前，扩展只改写发给模型的那份副本，不修改会话文件：

1. **图片数量上限**：最多保留 `maxImages` 张（默认 8）。
2. **图片总体积上限**：保留的图片合计不超过 `maxImageBytes`（默认 16 MB）。
3. **请求总大小上限**：估算的整个请求体不超过 `maxRequestBytes`（默认 24 MB）。第一次请求后，会用实际的请求体大小校准估算。
4. **先删旧图，保护新图**：最早的图换成一行占位文字，写明来源，比如 `read D:/shots/ads.png (1920x1080, image/png, 3.1 MB)`，模型需要时可以重新读取。最新的 `protectRecent` 张（默认 2）不会因为超出预算被删除。
5. **不破坏提示缓存**：超限时一次删到 `上限 × lowWatermark`（默认 0.75）。被删的图保持删除，占位文字每次完全相同，所以请求前缀很少变化，服务商的提示缓存能持续命中。
6. **去重**：同一张图出现多次时，只保留最新的一份。
7. **413 自动恢复**：如果网关仍以请求过大拒绝（HTTP 413 或同类报错文字），扩展把这个模型的上限下调到被拒请求大小的 90%，记录在会话里（重启后仍有效），去掉失败的那条回复后自动重试。
8. **请求体兜底**：如果最终的请求体仍然超限（比如第一次请求时还没校准），直接在请求体里替换最早的图片。支持 Anthropic、OpenAI Chat/Responses、Gemini、Bedrock 格式。
9. **遵守模型目录限制**：`models.json` 里的 `inputLimits.maxRequestBytes`、`images.maxPerRequest`、`images.maxPerMessage` 会生效。Pi 文档里有这些字段，但目前还没实现。

## 安装

```bash
pi install npm:pi-image-budget
```

装好后用默认配置即可生效。有图片被省略时，底栏会显示 `图 6/14`。

建议同时给模型配置缩图参数，让每张图一开始就更小：

```json
// ~/.pi/agent/models.json → 对应模型
"inputLimits": { "images": { "resize": { "maxWidth": 1568, "maxHeight": 1568, "maxBytes": 1048576 } } }
```

## 配置

配置是可选的。全局配置：`~/.pi/agent/image-budget.json`。项目配置：`.pi/image-budget.json`，只在项目已受信任时读取，会覆盖全局配置里的同名项。

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

| 选项 | 默认值 | 含义 |
|---|---|---|
| `enabled` | `true` | 总开关 |
| `maxImages` | `8` | 每次请求最多保留的图片数 |
| `maxImagesPerMessage` | 不限 | 每条消息最多保留的图片数 |
| `maxImageBytes` | `16MB` | 保留图片的 base64 总大小 |
| `maxRequestBytes` | `24MB` | 估算的整个请求体大小 |
| `protectRecent` | `2` | 不会因为超出预算被删除的最新图片数 |
| `lowWatermark` | `0.75` | 超限后删到 `上限 × 此比例` |
| `dedupe` | `true` | 相同的图片只保留最新一份 |
| `payloadGuard` | `true` | 最终请求体超限时的兜底清理 |
| `autoRecover` | `true` | 收到 413 后下调上限并重试 |
| `maxAutoRecoveries` | `2` | 每次提问最多自动重试几次 |
| `initialOverheadBytes` | `512KB` | 第一次校准前，假定系统提示和工具定义占多大 |
| `showStatus` | `true` | 有图片被省略时在底栏显示 |
| `locale` | `auto` | `en`、`zh-CN` 或 `auto` |
| `models` | `{}` | 按 `provider/modelId` 通配符单独设置上述上限 |

大小可以写字节数，也可以写 `"512KB"`、`"24MB"` 等（按 1024 换算），`null` 表示不限。无效的项会提示一次并忽略，其余配置照常生效。`models` 里排在后面的规则优先；模型目录里的限制只会让结果更严格。

## 命令

`/image-budget [status|on|off|reset|reload]`

- `status`：当前生效的上限、上次请求的统计、配置来源。
- `on` / `off`：在本会话启用或停用。
- `reset`：清除本会话从 413 学到的上限和已省略图片的记录。
- `reload`：重新读取配置文件。

## 限制

- 图片被省略后，模型就看不到它了，需要重新读取。如果经常要同时对比很多张图，调大 `maxImages` 或 `protectRecent`。
- 每条消息的图片上限按 Pi 的消息计算。有些服务商会把连续的工具结果合并成一条消息，这时一条消息里的图片可能更多。
- 已经卡住的会话，装上扩展后下一次请求就能恢复，但会话文件本身不会被改写。

## 开发

```bash
npm install
npm run check      # TypeScript 类型检查
npm test           # 单元测试和扩展接入测试
node scripts/e2e.mjs [--without-extension] [--with-user-packages]
```

`scripts/e2e.mjs` 用真实的 `pi` 命令行，对接一个请求超过 8 MB 就返回 413 的模拟网关。不装扩展时会话会卡死；装上后会话能恢复并继续使用。

## 许可

MIT
