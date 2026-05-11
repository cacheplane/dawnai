#!/usr/bin/env node
// Minimal local OpenAI stub for VHS recordings.
//
// Listens on --port, replies to POST /v1/chat/completions with a fixture
// loaded from --fixture (JSON file). No npm deps; built-ins only.
//
// Logging is stderr-only so the stub is invisible to a VHS recording that
// captures stdout.

import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { argv, exit } from "node:process";

function parseFlags(args) {
	const out = { fixture: null, port: 4317 };
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		if (a === "--fixture") out.fixture = args[++i];
		else if (a === "--port") out.port = Number(args[++i]);
		else if (a === "--help" || a === "-h") {
			process.stderr.write(
				"Usage: node stub-openai.mjs --fixture <path> [--port 4317]\n",
			);
			exit(0);
		}
	}
	if (!out.fixture) {
		process.stderr.write("error: --fixture is required\n");
		exit(2);
	}
	if (!Number.isFinite(out.port)) {
		process.stderr.write("error: --port must be a number\n");
		exit(2);
	}
	return out;
}

const { fixture, port } = parseFlags(argv.slice(2));

let fixtureData;
try {
	fixtureData = JSON.parse(readFileSync(fixture, "utf8"));
} catch (err) {
	process.stderr.write(
		`error: failed to load fixture ${fixture}: ${err.message}\n`,
	);
	exit(1);
}

// Fixture shape: { contentType: string, body: string | object }.
// For event-stream, body is the raw SSE text. For JSON, body is the parsed object.
const contentType = fixtureData.contentType || "application/json";
const payload =
	typeof fixtureData.body === "string"
		? fixtureData.body
		: JSON.stringify(fixtureData.body);

const server = createServer((req, res) => {
	process.stderr.write(`[stub] ${req.method} ${req.url}\n`);
	if (
		req.method === "POST" &&
		req.url &&
		(req.url.startsWith("/v1/chat/completions") ||
			req.url.startsWith("/chat/completions"))
	) {
		// Drain request body
		req.on("data", () => {});
		req.on("end", () => {
			res.writeHead(200, {
				"content-type": contentType,
				"content-length": Buffer.byteLength(payload),
			});
			res.end(payload);
		});
		return;
	}
	res.writeHead(404, { "content-type": "application/json" });
	res.end(JSON.stringify({ error: { message: "not found" } }));
});

server.listen(port, "127.0.0.1", () => {
	process.stderr.write(
		`[stub] listening on http://127.0.0.1:${port} (fixture: ${fixture})\n`,
	);
});

for (const sig of ["SIGINT", "SIGTERM"]) {
	process.on(sig, () => {
		process.stderr.write(`[stub] ${sig} — shutting down\n`);
		server.close(() => exit(0));
	});
}
