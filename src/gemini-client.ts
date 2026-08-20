// Owns the free/paid tier duality end-to-end: key selection, the
// free-then-paid-on-rate-limit fallback, request-count bookkeeping, and
// per-run logging. Callers just call generateMetadata() - they never see
// which tier was used or that there are two keys at all.

import type DigestPlugin from "./plugin";
import { RateLimitError, callModelOnce } from "./gemini-api";
import { logEvent } from "./logging";
import { NoteMetadata, Tier } from "./types";

export class GeminiClient {
	constructor(private plugin: DigestPlugin) {}

	isConfigured(): boolean {
		return !!(this.plugin.getFreeKey() || this.plugin.getPaidKey());
	}

	async generateMetadata(notePath: string, noteContent: string): Promise<NoteMetadata> {
		try {
			const { data, tier } = await this.requestWithFallback(noteContent);
			if (tier === "free") {
				this.plugin.settings.freeRequestCount++;
			} else {
				this.plugin.settings.paidRequestCount++;
			}
			await this.plugin.saveSettings();
			await this.log(notePath, tier, "success");
			return data;
		} catch (e: any) {
			console.error("Digest:", e);
			await this.log(notePath, null, "error", e.message);
			throw e;
		}
	}

	private async requestWithFallback(noteContent: string): Promise<{ data: NoteMetadata; tier: Tier }> {
		const settings = this.plugin.settings;
		const freeKey = this.plugin.getFreeKey();
		const paidKey = this.plugin.getPaidKey();
		const timeoutMs = Math.max(1, settings.requestTimeoutSeconds || 30) * 1000;

		if (settings.tierMode === "paidOnly") {
			if (!paidKey) throw new Error("Missing paid tier API key.");
			const data = await callModelOnce(paidKey, settings.model, settings.systemPrompt, noteContent, timeoutMs);
			return { data, tier: "paid" };
		}

		if (settings.tierMode === "freeOnly") {
			if (!freeKey) throw new Error("Missing free tier API key.");
			const data = await callModelOnce(freeKey, settings.model, settings.systemPrompt, noteContent, timeoutMs);
			return { data, tier: "free" };
		}

		if (freeKey) {
			try {
				const data = await callModelOnce(freeKey, settings.model, settings.systemPrompt, noteContent, timeoutMs);
				return { data, tier: "free" };
			} catch (e) {
				if (!(e instanceof RateLimitError)) throw e;
			}
		}

		if (!paidKey) {
			throw new Error("Free tier limit reached (or the free key is missing) and no paid tier key is configured.");
		}
		const data = await callModelOnce(paidKey, settings.model, settings.systemPrompt, noteContent, timeoutMs);
		return { data, tier: "paid" };
	}

	private async log(notePath: string, tier: Tier | null, status: "success" | "error", error?: string) {
		await logEvent(this.plugin.app, this.plugin.manifest, this.plugin.deviceId, notePath, tier, status, error);
	}
}
