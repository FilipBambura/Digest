// --- Logging ---------------------------------------------------------
// One JSONL log file per device, named after a random id that is stored
// in localStorage (app.loadLocalStorage/saveLocalStorage) instead of the
// synced settings file. localStorage lives outside the vault filesystem,
// so it never syncs - meaning two devices can never write to the same
// log file at the same time. Export/prune only ever read-then-rewrite a
// single device's own file, so there is no cross-device write conflict.

import { App, PluginManifest } from "obsidian";
import { Tier } from "./types";

export const LOG_RETENTION_DAYS = 30;
const DEVICE_ID_KEY = "digest-device-id";

export interface LogEntry {
	ts: string;
	note: string;
	tier: Tier | null;
	status: "success" | "error";
	error?: string;
}

export function getDeviceId(app: App): string {
	let id = app.loadLocalStorage(DEVICE_ID_KEY);
	if (!id) {
		id = crypto.randomUUID();
		app.saveLocalStorage(DEVICE_ID_KEY, id);
	}
	return id;
}

export function logsDir(app: App, manifest: PluginManifest): string {
	return `${app.vault.configDir}/plugins/${manifest.id}/logs`;
}

function logFilePath(app: App, manifest: PluginManifest, deviceId: string): string {
	return `${logsDir(app, manifest)}/log-${deviceId}.jsonl`;
}

async function ensureLogFile(app: App, path: string): Promise<void> {
	const dir = path.substring(0, path.lastIndexOf("/"));
	if (!(await app.vault.adapter.exists(dir))) {
		await app.vault.adapter.mkdir(dir);
	}
	if (!(await app.vault.adapter.exists(path))) {
		await app.vault.adapter.write(path, "");
	}
}

export async function appendLogEntry(
	app: App,
	manifest: PluginManifest,
	deviceId: string,
	entry: LogEntry
): Promise<void> {
	const path = logFilePath(app, manifest, deviceId);
	await ensureLogFile(app, path);
	await app.vault.adapter.append(path, JSON.stringify(entry) + "\n");
}

export async function logEvent(
	app: App,
	manifest: PluginManifest,
	deviceId: string,
	notePath: string,
	tier: Tier | null,
	status: "success" | "error",
	error?: string
): Promise<void> {
	try {
		const entry: LogEntry = {
			ts: new Date().toISOString(),
			note: notePath,
			tier: tier ?? null,
			status,
		};
		if (error) entry.error = error;
		await appendLogEntry(app, manifest, deviceId, entry);
	} catch (e) {
		console.error("Digest: failed to write log entry", e);
	}
}

function parseLogLines(raw: string): LogEntry[] {
	const out: LogEntry[] = [];
	for (const line of raw.split("\n")) {
		if (!line.trim()) continue;
		try {
			out.push(JSON.parse(line));
		} catch (e) {
			// skip malformed lines (e.g. a partial write interrupted by a crash)
		}
	}
	return out;
}

export async function pruneOwnLogs(
	app: App,
	manifest: PluginManifest,
	deviceId: string,
	retentionDays: number
): Promise<void> {
	const path = logFilePath(app, manifest, deviceId);
	if (!(await app.vault.adapter.exists(path))) return;
	const raw = await app.vault.adapter.read(path);
	const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
	const kept = parseLogLines(raw).filter((e) => {
		const t = Date.parse(e.ts);
		return Number.isNaN(t) ? true : t >= cutoff;
	});
	const body = kept.map((e) => JSON.stringify(e)).join("\n");
	await app.vault.adapter.write(path, body ? body + "\n" : "");
}

export async function readAllLogEntries(app: App, manifest: PluginManifest): Promise<LogEntry[]> {
	const dir = logsDir(app, manifest);
	if (!(await app.vault.adapter.exists(dir))) return [];
	const listing = await app.vault.adapter.list(dir);
	const entries: LogEntry[] = [];
	for (const filePath of listing.files) {
		if (!filePath.endsWith(".jsonl")) continue;
		const raw = await app.vault.adapter.read(filePath);
		entries.push(...parseLogLines(raw));
	}
	entries.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
	return entries;
}

export function buildLogExportMarkdown(entries: LogEntry[], from: string, to: string): string {
	const lines = [
		"# Digest log export",
		"",
		`Range: ${from || "(start)"} – ${to || "(end)"}`,
		`Generated: ${new Date().toISOString()}`,
		"",
		"| Time | Note | Tier | Status | Message |",
		"|---|---|---|---|---|",
	];
	for (const e of entries) {
		const msg = (e.error || "").replace(/\|/g, "\\|").replace(/\n/g, " ");
		lines.push(`| ${e.ts} | ${e.note} | ${e.tier || "-"} | ${e.status} | ${msg} |`);
	}
	return lines.join("\n") + "\n";
}
