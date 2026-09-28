import type { BudgetConfig } from "./config.ts";

const en = {
	status: (kept: number, total: number, resized: number) =>
		`img ${kept}/${total}${resized ? ` · ${resized} reduced` : ""}`,
	firstEviction: (omitted: number, request: string, limit: string) =>
		`pi-image-budget: omitted ${omitted} older image(s) from the request (≈${request} / limit ${limit}). Originals stay in the session.`,
	overBudget: (request: string, limit: string) =>
		`pi-image-budget: request is still ≈${request} (limit ${limit}) after removing every unprotected image. Text context alone may be too large.`,
	payloadScrubbed: (removed: number, before: string, after: string) =>
		`pi-image-budget: payload guard removed ${removed} image(s) (${before} → ${after}).`,
	payloadTooLarge: (bytes: string, limit: string) =>
		`pi-image-budget: provider payload is ${bytes}, above the ${limit} limit, and no removable images remain.`,
	learned: (what: string) => `pi-image-budget: the provider rejected the request; ${what} for this session.`,
	learnedRequest: (rejected: string, limit: string) => `request limit lowered to ${limit} (rejected at ${rejected})`,
	learnedCount: (limit: number) => `image count limited to ${limit}`,
	learnedImageBytes: (limit: string) => `images larger than ${limit} will be reduced`,
	learnedDimension: (limit: number) => `images larger than ${limit}px will be reduced`,
	learnedInvalid: "the only image in the request was dropped because the provider could not process it",
	cannotLocateImage: "pi-image-budget: invalid image, but its identity is ambiguous. No image was guessed or removed; re-read or replace the affected source.",
	recovering: "pi-image-budget: retrying with a smaller request.",
	cannotRecover: `pi-image-budget: the request was rejected as too large, but it cannot be made any smaller. Start a new session or reduce context.`,
	configErrors: (errors: string[]) => `pi-image-budget config problems (invalid entries ignored):\n${errors.join("\n")}`,
	enabled: "pi-image-budget enabled for this session.",
	disabled: "pi-image-budget disabled for this session.",
	reset: "pi-image-budget: learned limits and eviction history cleared for this session.",
	reloaded: (sources: string[]) => `pi-image-budget config reloaded from: ${sources.length ? sources.join(", ") : "defaults"}`,
	resizeFailed: (detail: string) => `pi-image-budget: image compression failed (${detail}). Keeping originals within hard caps; oversized images become placeholders.`,
	usage: "Usage: /image-budget [status|on|off|reset|reload]",
};

const zh: typeof en = {
	status: (kept, total, resized) => `图 ${kept}/${total}${resized ? ` · 压缩 ${resized}` : ""}`,
	firstEviction: (omitted, request, limit) =>
		`pi-image-budget：已从请求中省略 ${omitted} 张旧图（约 ${request} / 上限 ${limit}），原图仍保存在会话中。`,
	overBudget: (request, limit) =>
		`pi-image-budget：已移除所有可移除的图片，请求仍约 ${request}（上限 ${limit}），可能是文本上下文本身过大。`,
	payloadScrubbed: (removed, before, after) => `pi-image-budget：请求兜底移除了 ${removed} 张图片（${before} → ${after}）。`,
	payloadTooLarge: (bytes, limit) => `pi-image-budget：请求体 ${bytes} 超过上限 ${limit}，且已没有可移除的图片。`,
	learned: (what) => `pi-image-budget：请求被服务商拒绝，本会话已${what}。`,
	learnedRequest: (rejected, limit) => `把请求上限下调为 ${limit}（被拒请求 ${rejected}）`,
	learnedCount: (limit) => `把图片数量限制为 ${limit} 张`,
	learnedImageBytes: (limit) => `把超过 ${limit} 的图片改为压缩发送`,
	learnedDimension: (limit) => `把边长超过 ${limit}px 的图片改为缩小发送`,
	learnedInvalid: "移除请求中唯一一张被服务商拒绝的图片",
	cannotLocateImage: "pi-image-budget：服务商无法解码图片，但无法确定是哪一张；未猜测删除。请重新读取或更换相关源图。",
	recovering: "pi-image-budget：已缩小请求，正在自动重试。",
	cannotRecover: "pi-image-budget：请求因过大被拒绝，但已无法再缩小。请新开会话或减少上下文。",
	configErrors: (errors) => `pi-image-budget 配置有误（无效项已忽略）：\n${errors.join("\n")}`,
	enabled: "pi-image-budget 已在本会话启用。",
	disabled: "pi-image-budget 已在本会话停用。",
	reset: "pi-image-budget：已清除本会话学到的上限和省略记录。",
	reloaded: (sources) => `pi-image-budget 配置已重新加载：${sources.length ? sources.join("，") : "默认值"}`,
	resizeFailed: (detail) => `pi-image-budget：压缩失败（${detail}）。符合单图硬上限的原图继续保留，超限图片会用文字占位。`,
	usage: "用法：/image-budget [status|on|off|reset|reload]",
};

export type Messages = typeof en;

export function messagesFor(locale: BudgetConfig["locale"]): Messages {
	if (locale === "zh-CN") return zh;
	if (locale === "en") return en;
	const detected = process.env.LANG || process.env.LC_ALL || Intl.DateTimeFormat().resolvedOptions().locale || "";
	return /^zh/i.test(detected) ? zh : en;
}
