import type { BudgetConfig } from "./config.ts";

const en = {
	status: (kept: number, total: number) => `img ${kept}/${total}`,
	firstEviction: (omitted: number, request: string, limit: string) =>
		`pi-image-budget: omitted ${omitted} older image(s) from the request (≈${request} / limit ${limit}). Originals stay in the session.`,
	overBudget: (request: string, limit: string) =>
		`pi-image-budget: request is still ≈${request} (limit ${limit}) after removing every unprotected image. Text context alone may be too large.`,
	payloadScrubbed: (removed: number, before: string, after: string) =>
		`pi-image-budget: payload guard removed ${removed} image(s) (${before} → ${after}).`,
	payloadTooLarge: (bytes: string, limit: string) =>
		`pi-image-budget: provider payload is ${bytes}, above the ${limit} limit, and no removable images remain.`,
	learned: (rejected: string, limit: string) =>
		`pi-image-budget: gateway rejected a ${rejected} request (413). Request limit for this session lowered to ${limit}.`,
	recovering: (limit: string) => `pi-image-budget: retrying with older images removed (limit ${limit}).`,
	cannotRecover: `pi-image-budget: the request was rejected as too large, but no more images can be removed. Start a new session or reduce context.`,
	configErrors: (errors: string[]) => `pi-image-budget config problems (invalid entries ignored):\n${errors.join("\n")}`,
	enabled: "pi-image-budget enabled for this session.",
	disabled: "pi-image-budget disabled for this session.",
	reset: "pi-image-budget: learned limit and eviction history cleared for this session.",
	reloaded: (sources: string[]) => `pi-image-budget config reloaded from: ${sources.length ? sources.join(", ") : "defaults"}`,
	usage: "Usage: /image-budget [status|on|off|reset|reload]",
};

const zh: typeof en = {
	status: (kept, total) => `图 ${kept}/${total}`,
	firstEviction: (omitted, request, limit) =>
		`pi-image-budget：已从请求中省略 ${omitted} 张旧图（约 ${request} / 上限 ${limit}），原图仍保存在会话中。`,
	overBudget: (request, limit) =>
		`pi-image-budget：已移除所有可移除的图片，请求仍约 ${request}（上限 ${limit}），可能是文本上下文本身过大。`,
	payloadScrubbed: (removed, before, after) => `pi-image-budget：请求兜底移除了 ${removed} 张图片（${before} → ${after}）。`,
	payloadTooLarge: (bytes, limit) => `pi-image-budget：请求体 ${bytes} 超过上限 ${limit}，且已没有可移除的图片。`,
	learned: (rejected, limit) => `pi-image-budget：网关拒绝了 ${rejected} 的请求（413），本会话请求上限已下调为 ${limit}。`,
	recovering: (limit) => `pi-image-budget：已移除较早的图片并自动重试（上限 ${limit}）。`,
	cannotRecover: "pi-image-budget：请求因过大被拒绝，但已没有可移除的图片。请新开会话或减少上下文。",
	configErrors: (errors) => `pi-image-budget 配置有误（无效项已忽略）：\n${errors.join("\n")}`,
	enabled: "pi-image-budget 已在本会话启用。",
	disabled: "pi-image-budget 已在本会话停用。",
	reset: "pi-image-budget：已清除本会话学到的上限和省略记录。",
	reloaded: (sources) => `pi-image-budget 配置已重新加载：${sources.length ? sources.join("，") : "默认值"}`,
	usage: "用法：/image-budget [status|on|off|reset|reload]",
};

export type Messages = typeof en;

export function messagesFor(locale: BudgetConfig["locale"]): Messages {
	if (locale === "zh-CN") return zh;
	if (locale === "en") return en;
	const detected = process.env.LANG || process.env.LC_ALL || Intl.DateTimeFormat().resolvedOptions().locale || "";
	return /^zh/i.test(detected) ? zh : en;
}
