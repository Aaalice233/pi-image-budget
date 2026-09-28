// End-to-end check against the real `pi` CLI.
//
// Starts a mock OpenAI-compatible endpoint that rejects bodies above LIMIT with HTTP 413 (like a
// gateway), then drives several print-mode turns in one session, each attaching a fresh screenshot.
// --buffer-error answers oversized bodies like a relay whose retry buffer overflowed (HTTP 500 with text
// that Pi itself treats as retryable), which checks that Pi's own retry already sends a smaller body.
// Usage: node scripts/e2e.mjs [--without-extension] [--buffer-error] [--turns=N] [--with-user-packages] [--keep]
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync, crc32 } from "node:zlib";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const work = join(root, ".tmp", "e2e-work");
const cli = join(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))), "bundle", "cli.js");
const withExtension = !process.argv.includes("--without-extension");
const LIMIT = 8 * 1024 * 1024;
const TURNS = Number(process.argv.find((arg) => arg.startsWith("--turns="))?.slice(8) ?? 6);
const bufferError = process.argv.includes("--buffer-error");

function chunk(type, data) {
	const length = Buffer.alloc(4);
	length.writeUInt32BE(data.length);
	const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32(body) >>> 0);
	return Buffer.concat([length, body, crc]);
}

/** Incompressible 1024x768 RGB noise PNG (~2.3 MB) so Pi forwards it unchanged. */
function noisePng(seed) {
	const width = 1024;
	const height = 768;
	const raw = Buffer.alloc((width * 3 + 1) * height);
	let state = seed * 2654435761;
	for (let i = 0; i < raw.length; i += 1) {
		state = (state * 1103515245 + 12345) >>> 0;
		raw[i] = i % (width * 3 + 1) === 0 ? 0 : state >>> 24;
	}
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr[8] = 8;
	ihdr[9] = 2;
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk("IHDR", ihdr),
		chunk("IDAT", deflateSync(raw, { level: 0 })),
		chunk("IEND", Buffer.alloc(0)),
	]);
}

const requests = [];
const server = createServer((req, res) => {
	const parts = [];
	req.on("data", (part) => parts.push(part));
	req.on("end", () => {
		const body = Buffer.concat(parts);
		const images = (body.toString("utf8").match(/data:image\//g) ?? []).length;
		const rejected = body.length > LIMIT;
		const status = rejected ? (bufferError ? 500 : 413) : 200;
		requests.push({ bytes: body.length, images, status });
		if (rejected) {
			const message = bufferError ? "exceeded request buffer limit while retrying upstream" : "Request exceeds the maximum size";
			res.writeHead(status, { "content-type": "application/json" });
			res.end(JSON.stringify({ error: { message, type: "proxy_error", code: status } }));
			return;
		}
		res.writeHead(200, { "content-type": "text/event-stream" });
		const base = { id: "mock", object: "chat.completion.chunk", created: 0, model: "mock-vision" };
		res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: `seen ${images}` }, finish_reason: null }] })}\n\n`);
		res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } })}\n\n`);
		res.end("data: [DONE]\n\n");
	});
});

await new Promise((done) => server.listen(0, "127.0.0.1", done));
const port = server.address().port;

const agentDir = join(work, "agent");
// A junction left by an earlier --keep run must be unlinked before any recursive delete.
if (existsSync(join(agentDir, "npm"))) unlinkSync(join(agentDir, "npm"));
rmSync(work, { recursive: true, force: true });
mkdirSync(agentDir, { recursive: true });
writeFileSync(
	join(agentDir, "models.json"),
	JSON.stringify({
		providers: {
			mock: {
				baseUrl: `http://127.0.0.1:${port}/v1`,
				api: "openai-completions",
				apiKey: "mock-key",
				models: [{ id: "mock-vision", name: "Mock Vision", input: ["text", "image"], contextWindow: 10_000_000, maxTokens: 1000 }],
			},
		},
	}),
);
// --with-user-packages: also load the packages installed in the real agent dir (coexistence check).
const withUserPackages = process.argv.includes("--with-user-packages");
const settings = { retry: bufferError ? { maxRetries: 3, baseDelayMs: 50 } : { maxRetries: 0 } };
if (withUserPackages) {
	const realAgent = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
	settings.packages = JSON.parse(readFileSync(join(realAgent, "settings.json"), "utf8")).packages ?? [];
	symlinkSync(join(realAgent, "npm"), join(agentDir, "npm"), "junction");
}
writeFileSync(join(agentDir, "settings.json"), JSON.stringify(settings));

const env = { ...process.env, PI_CODING_AGENT_DIR: agentDir, LANG: "en_US.UTF-8" };
const results = [];
for (let turn = 1; turn <= TURNS; turn += 1) {
	const image = join(work, `shot${turn}.png`);
	writeFileSync(image, noisePng(turn));
	const args = [
		"--provider", "mock", "--model", "mock-vision",
		"--session-dir", join(work, "sessions"),
		...(withUserPackages ? [] : ["--no-extensions"]),
		"--no-skills", "--no-prompt-templates",
		...(withExtension ? ["-e", root] : []),
		...(turn > 1 ? ["--continue"] : []),
		"-p", `@${image}`, `turn ${turn}: describe`,
	];
	const before = requests.length;
	// Async spawn: a synchronous child would block this process's mock server.
	const run = await new Promise((done) => {
		const child = spawn(process.execPath, [cli, ...args], { cwd: work, env, stdio: ["ignore", "pipe", "pipe"] });
		child.on("error", (error) => done({ status: 1, stdout: "", stderr: String(error) }));
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (d) => (stdout += d));
		child.stderr.on("data", (d) => (stderr += d));
		const timer = setTimeout(() => child.kill(), 120_000);
		child.on("close", (status) => {
			clearTimeout(timer);
			done({ status, stdout, stderr });
		});
	});
	results.push({
		turn,
		exit: run.status,
		output: `${run.stdout}${run.stderr}`.trim().split("\n").slice(-3).join(" | ").slice(0, 300),
		requests: requests.slice(before),
	});
}
server.close();
// pi child processes may still hold session files briefly on Windows.
const cleanup = () => {
	// Remove the junction first so the real package directory is never traversed.
	if (withUserPackages) unlinkSync(join(agentDir, "npm"));
	rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
};

for (const result of results) {
	const sent = result.requests.map((r) => `${r.status} ${(r.bytes / 1048576).toFixed(1)}MB/${r.images}img`).join(", ");
	console.log(`turn ${result.turn}: exit=${result.exit} requests=[${sent}] output=${result.output}`);
}
const lastOk = results.every((result) => result.exit === 0 && result.requests.at(-1)?.status === 200);
const recovered = requests.some((request) => request.status >= 400);
const recoveryVerified = TURNS < 10 || !withExtension || recovered;
if (!recoveryVerified) console.error("FAIL: recovery run never exercised a rejection");
console.log(withExtension ? (lastOk ? "PASS: final turn succeeded" : "FAIL: final turn did not succeed") : "control run finished");
if (!process.argv.includes("--keep")) cleanup();
process.exit(withExtension ? (lastOk && recoveryVerified ? 0 : 1) : (lastOk ? 1 : 0));
