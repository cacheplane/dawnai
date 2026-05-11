#!/usr/bin/env node
// Capture a real OpenAI chat-completion response for the README demo gif.
//
// Strategy:
//   1. Start a tiny local proxy that forwards POST /v1/chat/completions to
//      api.openai.com and saves the response body to disk.
//   2. Scaffold a temp Dawn app under /tmp/dawn-demo-capture-$$ using
//      `pnpm create dawn-ai-app` (template: basic).
//   3. Run `pnpm exec dawn run "src/app/(public)/hello/[tenant]"` against the
//      proxy with OPENAI_BASE_URL set. ChatOpenAI honors OPENAI_BASE_URL.
//   4. Write the captured response to docs/brand/quickstart-fixture.json.
//   5. Always clean up the temp app on exit.
//
// Requires OPENAI_API_KEY in /Users/blove/repos/dawn/.env (or the repo's
// .env at the original root, not this worktree).

import { spawn, spawnSync } from "node:child_process";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { request as httpsRequest } from "node:https";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SELF = fileURLToPath(import.meta.url);
const BRAND_DIR = dirname(SELF);
const REPO_ROOT = resolve(BRAND_DIR, "..", "..");
const FIXTURE_OUT = join(BRAND_DIR, "quickstart-fixture.json");
const PROXY_PORT = 4318;

function log(msg) {
	process.stderr.write(`[capture] ${msg}\n`);
}

function loadEnvKey() {
	// Prefer the worktree's parent repo .env (the host repo, not the agent worktree).
	const candidates = [
		"/Users/blove/repos/dawn/.env",
		resolve(REPO_ROOT, ".env"),
	];
	for (const path of candidates) {
		if (!existsSync(path)) continue;
		const raw = readFileSync(path, "utf8");
		for (const line of raw.split("\n")) {
			const m = /^\s*OPENAI_API_KEY\s*=\s*(.+?)\s*$/.exec(line);
			if (m) {
				const v = m[1].replace(/^["']|["']$/g, "");
				log(`loaded OPENAI_API_KEY from ${path}`);
				return v;
			}
		}
	}
	return null;
}

function startProxy(apiKey) {
	let captured = null;
	const server = createServer((req, res) => {
		if (req.method !== "POST" || !req.url?.startsWith("/v1/chat/completions")) {
			res.writeHead(404);
			res.end();
			return;
		}
		const chunks = [];
		req.on("data", (c) => chunks.push(c));
		req.on("end", () => {
			const body = Buffer.concat(chunks);
			log(`forwarding ${body.length} bytes to api.openai.com`);
			const upstream = httpsRequest(
				{
					host: "api.openai.com",
					port: 443,
					path: "/v1/chat/completions",
					method: "POST",
					headers: {
						"content-type": "application/json",
						"content-length": body.length,
						authorization: `Bearer ${apiKey}`,
						accept: "application/json",
					},
				},
				(upRes) => {
					const respChunks = [];
					upRes.on("data", (c) => respChunks.push(c));
					upRes.on("end", () => {
						const respBody = Buffer.concat(respChunks);
						const contentType =
							upRes.headers["content-type"] || "application/json";
						log(
							`upstream status ${upRes.statusCode}, ${respBody.length} bytes, type=${contentType}`,
						);
						const text = respBody.toString("utf8");
						if (contentType.includes("event-stream")) {
							captured = { contentType, body: text };
						} else {
							try {
								captured = { contentType, body: JSON.parse(text) };
							} catch (err) {
								log(
									`warning: failed to parse upstream response: ${err.message}`,
								);
								captured = { contentType, body: text };
							}
						}
						res.writeHead(upRes.statusCode || 500, {
							"content-type": contentType,
						});
						res.end(respBody);
					});
				},
			);
			upstream.on("error", (err) => {
				log(`upstream error: ${err.message}`);
				res.writeHead(502, { "content-type": "application/json" });
				res.end(JSON.stringify({ error: { message: err.message } }));
			});
			upstream.write(body);
			upstream.end();
		});
	});
	return new Promise((resolveStart) => {
		server.listen(PROXY_PORT, "127.0.0.1", () => {
			log(`proxy listening on http://127.0.0.1:${PROXY_PORT}`);
			resolveStart({
				getCaptured: () => captured,
				close: () =>
					new Promise((r) => {
						server.close(() => r());
					}),
			});
		});
	});
}

function run(cmd, args, opts = {}) {
	log(`$ ${cmd} ${args.join(" ")}${opts.cwd ? `  (cwd=${opts.cwd})` : ""}`);
	const res = spawnSync(cmd, args, {
		stdio: ["ignore", "inherit", "inherit"],
		...opts,
	});
	if (res.status !== 0) {
		throw new Error(
			`${cmd} ${args.join(" ")} exited with status ${res.status}`,
		);
	}
}

async function runWithInput(cmd, args, opts, input) {
	log(
		`$ echo '...' | ${cmd} ${args.join(" ")}${opts?.cwd ? `  (cwd=${opts.cwd})` : ""}`,
	);
	return new Promise((resolveRun, rejectRun) => {
		const child = spawn(cmd, args, {
			stdio: ["pipe", "inherit", "inherit"],
			...opts,
		});
		child.on("error", rejectRun);
		child.on("exit", (code) => {
			if (code === 0) resolveRun();
			else rejectRun(new Error(`${cmd} exited with code ${code}`));
		});
		child.stdin.write(input);
		child.stdin.end();
	});
}

async function main() {
	const apiKey = loadEnvKey();
	if (!apiKey) {
		log("ERROR: OPENAI_API_KEY not found in any .env candidate");
		process.exit(1);
	}

	const tmpRoot = mkdtempSync(join(tmpdir(), "dawn-demo-capture-"));
	const appDir = join(tmpRoot, "my-app");
	log(`temp app dir: ${appDir}`);

	let proxy;
	try {
		proxy = await startProxy(apiKey);

		// Scaffold via the local create-dawn-app build (faster + matches this commit).
		// Build create-dawn-app first.
		// Assume the workspace is already built (`pnpm build` from repo root).
		if (!existsSync(join(REPO_ROOT, "packages/create-dawn-app/dist/bin.js"))) {
			run("pnpm", ["build"], { cwd: REPO_ROOT });
		}
		run(
			"node",
			[
				join(REPO_ROOT, "packages/create-dawn-app/dist/bin.js"),
				appDir,
				"--template",
				"basic",
				"--mode",
				"internal",
			],
			{ cwd: REPO_ROOT },
		);

		run("pnpm", ["install"], { cwd: appDir });

		// The scaffolded greet tool has no Zod input schema, which OpenAI's
		// function-tool validator rejects (400: "object schema missing properties").
		// For the demo gif we only need the agent's first turn — a plain reply —
		// so drop the tools directory before invoking.
		rmSync(join(appDir, "src/app/(public)/hello/[tenant]/tools"), {
			recursive: true,
			force: true,
		});

		await runWithInput(
			"pnpm",
			["exec", "dawn", "run", "hello/[tenant]"],
			{
				cwd: appDir,
				env: {
					...process.env,
					OPENAI_API_KEY: apiKey,
					OPENAI_BASE_URL: `http://127.0.0.1:${PROXY_PORT}/v1`,
				},
			},
			JSON.stringify({
				tenant: "acme",
				messages: [
					{
						role: "user",
						content:
							"In one short sentence, greet the user and ask what they need help with. Do not mention placeholder variables or curly braces.",
					},
				],
			}) + "\n",
		);

		const captured = proxy.getCaptured();
		if (!captured) {
			throw new Error("no response captured from upstream");
		}
		writeFileSync(
			FIXTURE_OUT,
			JSON.stringify(captured, null, 2) + "\n",
			"utf8",
		);
		log(`wrote ${FIXTURE_OUT}`);
	} finally {
		if (proxy) await proxy.close();
		try {
			rmSync(tmpRoot, { recursive: true, force: true });
			log(`cleaned up ${tmpRoot}`);
		} catch (err) {
			log(`warning: cleanup failed: ${err.message}`);
		}
	}
}

main().catch((err) => {
	log(`FATAL: ${err.message}`);
	process.exit(1);
});
