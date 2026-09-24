import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { DEFAULT_CONFIG, loadConfig, MiB, parseLayer, parseSize, resolveLimits } from "../src/config.ts";

test("sizes are binary and accept null as unlimited", () => {
	assert.equal(parseSize("32MB"), 32 * MiB);
	assert.equal(parseSize("512 KiB"), 512 * 1024);
	assert.equal(parseSize("1.5m"), Math.floor(1.5 * MiB));
	assert.equal(parseSize(1000), 1000);
	assert.equal(parseSize(null), Infinity);
	assert.throws(() => parseSize("big"));
	assert.throws(() => parseSize(-1));
});

test("invalid entries are reported and skipped, valid ones kept", () => {
	const errors: string[] = [];
	const layer = parseLayer({ maxImages: 4, maxImageBytes: "lots", bogus: 1, models: { "x/*": { enabled: false } } }, "file", errors);
	assert.equal(layer.maxImages, 4);
	assert.equal(layer.maxImageBytes, undefined);
	assert.equal(errors.length, 3);
});

test("model globs override in order and catalog limits only tighten", () => {
	const config = {
		...DEFAULT_CONFIG,
		models: { "yuan/*": { maxRequestBytes: 30 * MiB, maxImages: 12 }, "*/claude-*": { maxImages: 10 } },
	};
	const limits = resolveLimits(config, {
		provider: "yuan",
		id: "claude-opus",
		inputLimits: { maxRequestBytes: 20 * MiB, images: { maxPerRequest: 20, maxPerMessage: 3 } },
	});
	assert.equal(limits.maxRequestBytes, 20 * MiB);
	assert.equal(limits.maxImages, 10);
	assert.equal(limits.maxImagesPerMessage, 3);
});

test("project config layers on global config; untrusted projects are ignored", () => {
	const root = mkdtempSync(join(process.cwd(), "test", ".tmp-"));
	const agent = join(root, "agent");
	const project = join(root, "project");
	mkdirSync(agent, { recursive: true });
	mkdirSync(join(project, ".pi"), { recursive: true });
	writeFileSync(join(agent, "image-budget.json"), JSON.stringify({ maxImages: 5, models: { "a/*": { maxImages: 2 } } }));
	writeFileSync(join(project, ".pi", "image-budget.json"), JSON.stringify({ maxImages: 3, models: { "b/*": { maxImages: 1 } } }));
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agent;
	try {
		const trusted = loadConfig(project, true);
		assert.equal(trusted.config.maxImages, 3);
		assert.deepEqual(Object.keys(trusted.config.models), ["a/*", "b/*"]);
		assert.equal(trusted.sources.length, 2);
		const untrusted = loadConfig(project, false);
		assert.equal(untrusted.config.maxImages, 5);
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		rmSync(root, { recursive: true, force: true });
	}
});
