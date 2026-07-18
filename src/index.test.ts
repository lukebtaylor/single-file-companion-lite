import { strict as assert } from "node:assert";
import { join, resolve } from "node:path";
import {
	handleError,
	type Options,
	parseMessage,
	parseOptions,
	processMessage,
	readExact,
	type Reader,
	savePage,
	type Writer,
} from "./index.ts";

// An in-memory Reader that hands back the given chunks one read() call at a
// time - including chunks as small as a single byte - to simulate a stdin
// pipe that never guarantees a full buffer per call. This is the exact
// scenario that used to corrupt the native-messaging length header and
// silently drop saves (see #17, #16, #15, #11).
function chunkedReader(chunks: Uint8Array[]): Reader {
	let index = 0;
	return {
		read(p: Uint8Array): Promise<number | null> {
			if (index >= chunks.length) {
				return Promise.resolve(null);
			}
			const chunk = chunks[index++];
			const n = Math.min(chunk.length, p.length);
			p.set(chunk.subarray(0, n));
			return Promise.resolve(n);
		},
	};
}

// An in-memory Reader that serves a single flat buffer, correctly handling
// reads of any size across multiple calls (unlike chunkedReader above, which
// intentionally hands out one fixed-size array element per call and is not
// meant to be fed a single chunk larger than a single read request - doing
// that would silently drop everything past the first read's length). Use
// this whenever the exact byte-boundaries of individual read() calls don't
// matter and the goal is just "deliver this whole message correctly".
function bufferReader(data: Uint8Array): Reader {
	let offset = 0;
	return {
		read(p: Uint8Array): Promise<number | null> {
			if (offset >= data.length) {
				return Promise.resolve(null);
			}
			const n = Math.min(data.length - offset, p.length);
			p.set(data.subarray(offset, offset + n));
			offset += n;
			return Promise.resolve(n);
		},
	};
}

function collectingWriter(): { writer: Writer; chunks: Uint8Array[] } {
	const chunks: Uint8Array[] = [];
	return {
		chunks,
		writer: {
			write(p: Uint8Array): Promise<number> {
				chunks.push(p.slice());
				return Promise.resolve(p.length);
			},
		},
	};
}

function encodeMessage(payload: unknown): Uint8Array {
	const json = new TextEncoder().encode(JSON.stringify(payload));
	const header = new Uint8Array(4);
	new DataView(header.buffer).setUint32(0, json.length, true);
	const combined = new Uint8Array(header.length + json.length);
	combined.set(header, 0);
	combined.set(json, header.length);
	return combined;
}

async function withTempCwd(fn: (dir: string) => Promise<void>): Promise<void> {
	const dir = await Deno.makeTempDir();
	const cwd = Deno.cwd();
	try {
		Deno.chdir(dir);
		await fn(dir);
	} finally {
		Deno.chdir(cwd);
		await Deno.remove(dir, { recursive: true });
	}
}

Deno.test("readExact assembles a buffer split across many single-byte reads", async () => {
	const data = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
	const reader = chunkedReader(Array.from(data, (b) => new Uint8Array([b])));
	const result = await readExact(reader, data.length);
	assert.ok(result);
	assert.deepEqual(Array.from(result as Uint8Array), Array.from(data));
});

Deno.test("readExact returns null on early EOF instead of a truncated buffer", async () => {
	const reader = chunkedReader([new Uint8Array([1, 2])]);
	const result = await readExact(reader, 10);
	assert.equal(result, null);
});

Deno.test("parseMessage decodes a message delivered as single-byte reads", async () => {
	const payload = encodeMessage({ method: "save", pageData: { filename: "a.html", content: "hi" } });
	const reader = chunkedReader(Array.from(payload, (b) => new Uint8Array([b])));
	const message = await parseMessage(reader);
	assert.ok(message);
	assert.equal(message?.method, "save");
	assert.equal(message?.pageData.filename, "a.html");
	assert.equal(message?.pageData.content, "hi");
});

Deno.test("parseMessage returns undefined when the stream ends mid-header", async () => {
	const reader = chunkedReader([new Uint8Array([1, 2])]);
	const message = await parseMessage(reader);
	assert.equal(message, undefined);
});

Deno.test("parseMessage returns undefined when the stream ends mid-body", async () => {
	const header = new Uint8Array(4);
	new DataView(header.buffer).setUint32(0, 100, true);
	const reader = chunkedReader([header, new Uint8Array([1, 2, 3])]);
	const message = await parseMessage(reader);
	assert.equal(message, undefined);
});

Deno.test("savePage writes content under the configured savePath", () =>
	withTempCwd(async (dir) => {
		const options: Options = { savePath: "./out/" };
		await savePage({ filename: "example.com/page.html", content: "<html></html>" }, options);
		const written = await Deno.readTextFile(join(dir, "out", "example.com", "page.html"));
		assert.equal(written, "<html></html>");
	}));

Deno.test("savePage rejects a filename that escapes savePath via ../", () =>
	withTempCwd(async (dir) => {
		const options: Options = { savePath: "./out/" };
		await assert.rejects(() => savePage({ filename: "../../escape.html", content: "pwned" }, options));
		const escaped = await Deno.stat(resolve(dir, "..", "..", "escape.html")).catch(() => null);
		assert.equal(escaped, null);
	}));

Deno.test("savePage rejects an absolute filename", () =>
	withTempCwd(async () => {
		const options: Options = { savePath: "./out/" };
		const absolute = Deno.build.os === "windows" ? "C:\\evil.html" : "/etc/evil.html";
		await assert.rejects(() => savePage({ filename: absolute, content: "pwned" }, options));
	}));

Deno.test("savePage propagates mkdir errors instead of swallowing them (#6)", () =>
	withTempCwd(async (dir) => {
		// Put a *file* where savePage needs to create a *directory* so
		// Deno.mkdir is guaranteed to fail.
		await Deno.writeTextFile(join(dir, "blocked"), "");
		const options: Options = { savePath: "./blocked/" };
		await assert.rejects(() => savePage({ filename: "page.html", content: "x" }, options));
	}));

Deno.test("parseOptions returns {} when options.json is missing", () =>
	withTempCwd(async () => {
		const options = await parseOptions();
		assert.deepEqual(options, {});
	}));

Deno.test("parseOptions reads savePath and errorFilePath", () =>
	withTempCwd(async (dir) => {
		await Deno.writeTextFile(
			join(dir, "options.json"),
			JSON.stringify({ savePath: "./x/", errorFilePath: "./err.log" }),
		);
		const options = await parseOptions();
		assert.equal(options.savePath, "./x/");
		assert.equal(options.errorFilePath, "./err.log");
	}));

Deno.test("handleError writes to errorFilePath when configured", () =>
	withTempCwd(async (dir) => {
		const options: Options = { errorFilePath: "./err.log" };
		const { writer } = collectingWriter();
		await handleError(new Error("boom"), options, writer);
		const logged = await Deno.readTextFile(join(dir, "err.log"));
		assert.ok(logged.includes("boom"));
	}));

Deno.test("handleError falls back to console.error when errorFilePath is unset", async () => {
	const options: Options = {};
	const originalConsoleError = console.error;
	let captured = "";
	console.error = (msg: string) => {
		captured = msg;
	};
	const { writer } = collectingWriter();
	try {
		await handleError(new Error("boom"), options, writer);
	} finally {
		console.error = originalConsoleError;
	}
	assert.ok(captured.includes("boom"));
});

Deno.test("handleError writes a correctly length-prefixed JSON error", async () => {
	const options: Options = {};
	const originalConsoleError = console.error;
	console.error = () => {};
	const { writer, chunks } = collectingWriter();
	try {
		await handleError(new Error("boom"), options, writer);
	} finally {
		console.error = originalConsoleError;
	}
	assert.equal(chunks.length, 2);
	const length = new DataView(chunks[0].buffer, chunks[0].byteOffset, chunks[0].byteLength).getUint32(0, true);
	assert.equal(length, chunks[1].length);
	const body = JSON.parse(new TextDecoder().decode(chunks[1]));
	assert.ok(String(body.error).includes("boom"));
});

// These two cover the actual bug report: a successful save produced no
// response at all, and SingleFile's own companion.js only forgives a
// response-less exit if the browser's disconnect message happens to contain
// the Chrome-specific string "Native host has exited" - which isn't
// guaranteed to hold on every browser. Sending an explicit response removes
// that dependency entirely.
Deno.test("processMessage writes a success response (no .error) after a successful save", () =>
	withTempCwd(async (dir) => {
		const payload = encodeMessage({ method: "save", pageData: { filename: "page.html", content: "hi" } });
		const reader = bufferReader(payload);
		const options: Options = { savePath: "./out/" };
		const { writer, chunks } = collectingWriter();

		await processMessage(reader, options, writer);

		const written = await Deno.readTextFile(join(dir, "out", "page.html"));
		assert.equal(written, "hi");
		assert.equal(chunks.length, 2);
		const length = new DataView(chunks[0].buffer, chunks[0].byteOffset, chunks[0].byteLength).getUint32(0, true);
		assert.equal(length, chunks[1].length);
		const body = JSON.parse(new TextDecoder().decode(chunks[1]));
		assert.equal(body.error, undefined);
	}));

Deno.test("processMessage writes an error response when the save fails", () =>
	withTempCwd(async () => {
		const payload = encodeMessage({ method: "save", pageData: { filename: "../escape.html", content: "x" } });
		const reader = bufferReader(payload);
		const options: Options = { savePath: "./out/" };
		const originalConsoleError = console.error;
		console.error = () => {};
		const { writer, chunks } = collectingWriter();
		try {
			await processMessage(reader, options, writer);
		} finally {
			console.error = originalConsoleError;
		}
		assert.equal(chunks.length, 2);
		const body = JSON.parse(new TextDecoder().decode(chunks[1]));
		assert.ok(String(body.error).length > 0);
	}));
