import { requestUrl } from "obsidian";
import { NoteMetadata } from "./types";

const API_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/interactions";
const API_REVISION = "2026-05-20";

export class RateLimitError extends Error {}
export class TimeoutError extends Error {}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			reject(new TimeoutError(`Request timed out after ${ms / 1000}s.`));
		}, ms);
		promise.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(err) => {
				clearTimeout(timer);
				reject(err);
			}
		);
	});
}

// Pure single-key HTTP layer: knows nothing about settings, tiers, keys, or
// which fields exist - it just sends one system prompt + one user prompt
// against one schema, with one key. All of that composition happens in
// gemini-client.ts / property-schema.ts.
export async function callModelOnce(
	apiKey: string,
	model: string,
	systemPrompt: string,
	userPrompt: string,
	schema: Record<string, unknown>,
	timeoutMs: number
): Promise<NoteMetadata> {
	const res = await withTimeout(
		requestUrl({
			url: API_ENDPOINT,
			method: "POST",
			throw: false,
			headers: {
				"Content-Type": "application/json",
				"x-goog-api-key": apiKey,
				"Api-Revision": API_REVISION,
			},
			body: JSON.stringify({
				model,
				system_instruction: systemPrompt,
				input: userPrompt,
				response_format: {
					type: "text",
					mime_type: "application/json",
					schema,
				},
			}),
		}),
		timeoutMs
	);

	if (res.status < 200 || res.status >= 300) {
		let code = "unknown";
		let message = `HTTP ${res.status}`;
		try {
			const body = res.json;
			if (body?.error) {
				code = body.error.code ?? code;
				message = body.error.message ?? message;
			}
		} catch (e) {
			// response body wasn't JSON - fall back to the generic HTTP message above
		}
		if (res.status === 429 && (code === "rate_limit_exceeded" || code === "quota_exceeded")) {
			throw new RateLimitError(`${code}: ${message}`);
		}
		throw new Error(`API error (${code}): ${message}`);
	}

	let body: any;
	try {
		body = res.json;
	} catch (e) {
		console.error("Digest: response body wasn't valid JSON", res.text);
		throw new Error("Response wasn't valid JSON (see console for details).");
	}

	const modelOutputSteps = (body?.steps ?? []).filter((s: any) => s?.type === "model_output");
	const textParts: string[] = [];
	for (const step of modelOutputSteps) {
		for (const block of step.content ?? []) {
			if (block?.type === "text" && typeof block.text === "string") {
				textParts.push(block.text);
			}
		}
	}
	const rawText = textParts.join("");
	if (!rawText) {
		console.error("Digest: empty response", body);
		throw new Error("Received an empty response (see console for details).");
	}
	try {
		return JSON.parse(rawText);
	} catch (e) {
		console.error("Digest: invalid JSON in response", rawText);
		throw new Error("Response wasn't valid JSON (see console for details).");
	}
}
