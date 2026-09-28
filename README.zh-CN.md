# pi-image-budget

[English](README.md)

给 Pi 的图片请求设置数量、尺寸和体积预算，降低截图密集的长会话撞上中转站请求上限的风险。仅改变发送副本，**不改写原始会话、源图片或工具结果**。不承诺消除服务商过载、限流、余额不足和文本上下文超限等无关错误。

## 处理顺序

1. 精确去重、保留先前省略的图片记录；先处理图片数量及每条消息上限。
2. 最近 2 张图优先保留原图；较旧的候选图压缩到长边不超过 1280px、base64 不超过 400KB。压缩由 Pi 导出的 `resizeImage` 完成，可能输出 PNG 或 JPEG，允许有损。占位说明包含原始/新尺寸及坐标换算比例。
3. 单图超过 4.5MB base64 或 2000px 时，即使是新图也需要缩小。压缩失败会提示；符合硬上限的原图继续保留，超限图片换成文字占位。
4. 总预算仍超限时，按时间先省略旧图，尽量一次降到上限的 75%，减少请求前缀频繁变化。若仅受保护的新图就超限，再尝试压缩新图。
5. 每次发送前测量最终 JSON 请求体，并在真实消息内容中兜底处理。支持 Anthropic、OpenAI Chat/Responses、Gemini 和 Bedrock 常见图片结构；不会遍历、修改工具定义中的示例或参数。

默认最多保留 **12 张**。原图继续保存在会话；需要看细节时让模型重新读取。压缩无法保证文字/透明通道/动画帧完全保真。

## 错误恢复

- **请求体过大**：识别 HTTP 413、`Request exceeds the maximum size`、`exceeded request buffer limit while retrying upstream` 等。
- **图片数量、单图字节、尺寸限制**：分别收紧对应预算；只在错误明确关联了上限数字时使用该数字，否则保守下调。
- **解码错误**：仅当请求中唯一图片可被确定时省略它并重试。多图错误无法准确定位时提示用户，**不会猜测删除最新图片**。
- 上限按模型在当前会话分支内学习并持久化；下次请求前已经生效，包括 Pi 自己发起的重试。
- 插件最多发起 2 次继续请求，且只在相关指标确实变小时才继续。`autoRecover` / `maxAutoRecoveries` 不修改 Pi 自身的 `retry` 设置；原生重试可能仍受该设置控制。
- 图片预算无法解决纯文本过大。若新图无法压缩且保护策略使请求仍超限，会明确警告，不声称已修好。

## 性能与隐私

- 不新增图像依赖；使用 Pi 自带的 Photon worker 路径。首次压缩可能增加约秒级延迟，成本随图片及机器变化；Pi 在 worker 不可用时可能退回主线程，因此不能保证所有运行时完全不阻塞。
- 最多两个压缩任务并发，只处理可能保留的候选图，不对新图做无用的后台预压缩。
- 用完整 SHA-256、MIME 和目标参数缓存压缩结果；缓存同时受 **128 项 / 32MiB** 上限约束，也缓存失败。不会仅凭消息 ID 或采样指纹复用另一张图。
- 缓存仅在内存，不额外落盘保存截图；进程重启或缓存淘汰后会重新计算。相同输入和参数的编码保持确定性。
- 中立消息估算避免重复序列化整个 base64 历史；最终请求每次精确测量，不因之前的估算偏小而跳过保护。JSON 测量不分配一个完整的大请求字符串。

## 安装与配置

```sh
pi install git:github.com/Aaalice233/pi-image-budget
```

已有本地 Git 安装更新后执行 `/reload`。全局配置：`~/.pi/agent/image-budget.json`；可信项目的 `.pi/image-budget.json` 可覆盖它。

```json
{
  "locale": "zh-CN",
  "maxImages": 12,
  "compress": true,
  "compressMaxDimension": 1280,
  "compressMaxBytes": "400KB",
  "protectRecent": 2,
  "models": {
    "my-gateway/*": { "maxRequestBytes": "12MB", "maxImages": 8 }
  }
}
```

| 选项 | 默认值 | 含义 |
|---|---|---|
| `enabled` | `true` | 总开关 |
| `maxImages` | `12` | 每次请求保留的图片数 |
| `maxImagesPerMessage` | 不限 | 消息图片上限；最终请求会检查服务商合并后的消息 |
| `maxImageBytes` | `16MB` | 图片 base64 合计大小 |
| `maxRequestBytes` | `24MB` | 整个 JSON 请求体大小 |
| `maxBytesPerImage` | `4.5MB` | 单图 base64 硬上限，有限正数 |
| `maxImageDimension` | `2000` | 单图最大宽/高，有限正整数 |
| `compress` | `true` | 对较旧图片压缩；关掉仍执行单图硬上限 |
| `compressMaxDimension` | `1280` | 较旧图片最大宽/高，有限正整数 |
| `compressMaxBytes` | `400KB` | 较旧图片 base64 目标大小，有限正数 |
| `protectRecent` | `2` | 优先保留原图的最新图片数；硬上限优先 |
| `lowWatermark` | `0.75` | 触发省略后尝试降低到的比例 |
| `dedupe` | `true` | 同 MIME、字节完全相同的图片只保留最新一份 |
| `payloadGuard` | `true` | 最终请求体的体积和数量兜底 |
| `autoRecover` | `true` | 允许插件发起自动继续 |
| `maxAutoRecoveries` | `2` | 每次输入后插件最多继续次数 |
| `initialOverheadBytes` | `512KB` | 首次校准前的系统提示/工具定义开销估算 |
| `showStatus` | `true` | 压缩或省略图片时显示底栏统计 |
| `locale` | `auto` | 通知语言：`auto`、`en`、`zh-CN` |
| `models` | `{}` | `provider/modelId` 通配符预算覆盖 |

单位按 1024 换算；整体数量/总字节预算接受 `null` 表示不限，压缩尺寸、单图体积、保护数量和重试次数必须有限。无效配置提示后忽略。模型目录的 `inputLimits` 只会收紧限制，包括图片 `resize.maxWidth/maxHeight/maxBytes`。

状态示例：`图 8/14 · 压缩 6`。最终请求兜底若进一步移除图片，会单独通知；底栏是中立消息规划阶段的统计。

## 命令

`/image-budget [status|on|off|reset|reload]`

- `status`：预算、压缩节省量、请求测量结果、配置来源。
- `on` / `off`：本会话开启或关闭。
- `reset`：清除当前模型学到的限制、解码失败记录和省略记录。
- `reload`：重新读取配置。

## 验证

```sh
npm ci
npm run check
npm test
npm run bench
node scripts/e2e.mjs --turns=10
node scripts/e2e.mjs --buffer-error --turns=10
node scripts/e2e.mjs --without-extension
```

单元测试覆盖压缩、缓存上限、JSON 大小、配置、错误分类、分支恢复、最终请求格式和真实 Photon 编码。端到端测试启动本地模拟网关，用真实 Pi CLI 发送图片，验证超限恢复；不会访问付费模型。基准测试区分规划、最终测量和原始请求序列化，不把首次解码开销隐藏在稳态结果里。

测试目录位于 `.tmp/e2e-work`，正常结束会清理。原生 CLI / 第三方扩展未来版本的事件变化仍可能需要适配；未知图片引用形态不会被盲目重写。

MIT。
