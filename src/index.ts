#!/usr/bin/env -S deno run --allow-write --allow-read

/*
 * Copyright 2022 Gildas Lormeau
 * contact : gildas.lormeau <at> gmail.com
 *
 * This file is part of SingleFile.
 *
 *   The code in this file is free software: you can redistribute it and/or
 *   modify it under the terms of the GNU Affero General Public License
 *   (GNU AGPL) as published by the Free Software Foundation, either version 3
 *   of the License, or (at your option) any later version.
 *
 *   The code in this file is distributed in the hope that it will be useful,
 *   but WITHOUT ANY WARRANTY; without even the implied warranty of
 *   MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU Affero
 *   General Public License for more details.
 *
 *   As additional permission under GNU AGPL version 3 section 7, you may
 *   distribute UNMODIFIED VERSIONS OF THIS file without the copy of the GNU
 *   AGPL normally required by section 4, provided you include this license
 *   notice and a URL through which recipients can access the Corresponding
 *   Source.
 */

import { resolve, parse, relative, isAbsolute } from "node:path";

const BASE_PATH = ".";
const METHOD_SAVE = "save";
const DOWNLOADS_PATH = "./WebArchives/";
const OPTIONS_FILE_PATH = "./options.json";
// Native messaging length header: 4 bytes, native byte order. Every target
// this project ships for (linux-gnu/win-msvc/darwin, all x86_64) is
// little-endian, so we read it as such explicitly below.
const HEADER_SIZE = 4;

export interface Options {
	savePath?: string;
	errorFilePath?: string;
}

export interface PageData {
	filename: string;
	content: string;
}

export interface Message {
	method: string;
	pageData: PageData;
}

// Minimal local interfaces instead of depending on Deno.Reader/Deno.Writer -
// Deno.stdin/Deno.stdout satisfy these structurally, and tests can pass in
// their own in-memory implementations without relying on Deno's own
// (sometimes-deprecated) global reader/writer type aliases.
export interface Reader {
	read(p: Uint8Array): Promise<number | null>;
}

export interface Writer {
	write(p: Uint8Array): Promise<number>;
}

if (import.meta.main) {
	main();
}

async function main(): Promise<void> {
	const options = await parseOptions();
	await processMessage(Deno.stdin, options, Deno.stdout);
}

// SingleFile's companion.js only tolerates a host that exits without ever
// responding if the browser's disconnect error text happens to contain the
// substring "Native host has exited" - that's Chrome's specific wording.
// Neither this program nor the original upstream version ever wrote a
// success response; on Firefox (and potentially other browsers/versions),
// the disconnect message is worded differently, that substring check fails,
// and SingleFile surfaces a generic "An unexpected error occurred" even
// though the save completed successfully. Sending an explicit response on
// every path - success included - sidesteps that entirely: SingleFile only
// throws if the response has a truthy `.error`, so any response without one
// reads as success regardless of how a given browser phrases a clean exit.
export async function processMessage(reader: Reader, options: Options, output: Writer): Promise<void> {
	try {
		const message = await parseMessage(reader);
		if (message && message.method == METHOD_SAVE) {
			await savePage(message.pageData, options);
			await writeResponse({}, output);
		}
	} catch (error) {
		await handleError(error as Error, options, output);
	}
}

export async function parseOptions(): Promise<Options> {
	try {
		return JSON.parse(await Deno.readTextFile(resolve(BASE_PATH, OPTIONS_FILE_PATH))) as Options;
	} catch (_error) {
		return {};
	}
}

// reader.read() may return fewer bytes than the buffer it's given - a
// single call is not guaranteed to fill it, especially over the pipes
// native messaging uses (this was the root cause of saves silently doing
// nothing: a short read on the 4-byte length header produced a garbage or
// zero message size, so the whole message was dropped without error).
// This loops until the requested number of bytes is read, or the stream
// ends early, in which case it returns null instead of a truncated buffer.
export async function readExact(reader: Reader, size: number): Promise<Uint8Array | null> {
	const buffer = new Uint8Array(size);
	let bytesRead = 0;
	while (bytesRead < size) {
		const result = await reader.read(buffer.subarray(bytesRead));
		if (result === null) {
			// stream closed before we received everything we expected
			return null;
		}
		bytesRead += result;
	}
	return buffer;
}

export async function parseMessage(reader: Reader = Deno.stdin): Promise<Message | undefined> {
	const headerBuffer = await readExact(reader, HEADER_SIZE);
	if (!headerBuffer) {
		return undefined;
	}
	const messageSize = new DataView(headerBuffer.buffer, headerBuffer.byteOffset, headerBuffer.byteLength).getUint32(0, true);
	const messageBuffer = await readExact(reader, messageSize);
	if (!messageBuffer) {
		return undefined;
	}
	return JSON.parse(new TextDecoder().decode(messageBuffer)) as Message;
}

export async function savePage(pageData: PageData, options: Options): Promise<void> {
	const savePath = resolve(BASE_PATH, options.savePath || DOWNLOADS_PATH);
	const targetPath = resolve(savePath, pageData.filename);
	// pageData.filename comes from the browser extension (ultimately derived
	// from the page's title/URL), not from anything this program controls.
	// Nothing upstream of this guarantees it can't contain "../" segments,
	// and this process runs with unsandboxed --allow-read --allow-write, so
	// refuse to write anywhere that resolves outside the configured
	// savePath rather than trusting the filename as-is.
	const relativeToSavePath = relative(savePath, targetPath);
	if (relativeToSavePath.startsWith("..") || isAbsolute(relativeToSavePath)) {
		throw new Error(`Refusing to save "${pageData.filename}": it resolves outside of the configured save path`);
	}
	const fileDirectory = parse(targetPath).dir;
	// Deno.mkdir({ recursive: true }) does not throw if the directory already
	// exists, so there is nothing benign left to swallow here - any error
	// (permission denied, a path segment that's too long, an invalid
	// character, etc.) is real and must propagate to handleError() instead
	// of being silently discarded, otherwise the save just does nothing with
	// no feedback (see #6: long filenames failing silently).
	await Deno.mkdir(fileDirectory, { recursive: true });
	await Deno.writeTextFile(targetPath, pageData.content);
}

export async function handleError(error: Error, options: Options, output: Writer = Deno.stdout): Promise<void> {
	if (options.errorFilePath) {
		const message = error.message + "\n" + error.stack + "\n";
		await Deno.writeTextFile(resolve(BASE_PATH, options.errorFilePath), message, { append: true });
	} else {
		// No errorFilePath is configured by default. Without this, a failed
		// save has zero visible trace anywhere on disk - write to stderr as a
		// fallback so at least a terminal/log capturing the process's output
		// has a chance of showing what went wrong.
		console.error(error.message + "\n" + error.stack);
	}
	await writeResponse({ error: error.toString() }, output);
}

// output.write() may write fewer bytes than it's given, same as
// reader.read() may read fewer than requested (see readExact() above) - the
// Writer contract makes no stronger guarantee. Loop until everything is
// actually written instead of assuming one call flushes the whole buffer.
async function writeExact(output: Writer, data: Uint8Array): Promise<void> {
	let bytesWritten = 0;
	while (bytesWritten < data.length) {
		bytesWritten += await output.write(data.subarray(bytesWritten));
	}
}

// Shared native-messaging response writer: 4-byte little-endian length
// header followed by the JSON body, used for both the success ack and the
// error response so the wire format can't drift between the two paths.
export async function writeResponse(payload: Record<string, unknown>, output: Writer): Promise<void> {
	const bytes = new TextEncoder().encode(JSON.stringify(payload));
	await writeExact(output, new Uint8Array(new Uint32Array([bytes.length]).buffer));
	await writeExact(output, bytes);
}
