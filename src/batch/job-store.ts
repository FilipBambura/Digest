// --- Batch jobs --------------------------------------------------------
// A folder batch (many notes) can easily outlive the app session: mobile
// suspends/kills the JS runtime when backgrounded, and quitting Obsidian
// on desktop stops it outright. So batches are checkpointed to disk after
// every single note, one job file per device (same non-sync-conflict
// reasoning as the logs), and can be resumed from Settings on next launch.

import { App, PluginManifest, TFile, TFolder } from "obsidian";
import { NoteMetadata } from "../types";

export type BatchFileStatus = "pending" | "success" | "error";

export interface BatchFileEntry {
	path: string;
	status: BatchFileStatus;
	old?: NoteMetadata;
	proposed?: NoteMetadata;
	error?: string;
}

export interface BatchJob {
	id: string;
	createdAt: string;
	status: "running";
	files: BatchFileEntry[];
}

export function collectMarkdownFiles(folder: TFolder, recursive: boolean): TFile[] {
	const files: TFile[] = [];
	for (const child of folder.children) {
		if (child instanceof TFile) {
			if (child.extension === "md") files.push(child);
		} else if (child instanceof TFolder) {
			if (recursive) files.push(...collectMarkdownFiles(child, recursive));
		}
	}
	return files;
}

function batchJobPath(app: App, manifest: PluginManifest, deviceId: string): string {
	return `${app.vault.configDir}/plugins/${manifest.id}/jobs/job-${deviceId}.json`;
}

export async function saveBatchJob(
	app: App,
	manifest: PluginManifest,
	deviceId: string,
	job: BatchJob
): Promise<void> {
	const path = batchJobPath(app, manifest, deviceId);
	const dir = path.substring(0, path.lastIndexOf("/"));
	if (!(await app.vault.adapter.exists(dir))) {
		await app.vault.adapter.mkdir(dir);
	}
	await app.vault.adapter.write(path, JSON.stringify(job));
}

export async function loadBatchJob(
	app: App,
	manifest: PluginManifest,
	deviceId: string
): Promise<BatchJob | null> {
	const path = batchJobPath(app, manifest, deviceId);
	if (!(await app.vault.adapter.exists(path))) return null;
	try {
		return JSON.parse(await app.vault.adapter.read(path));
	} catch (e) {
		return null;
	}
}

export async function deleteBatchJob(app: App, manifest: PluginManifest, deviceId: string): Promise<void> {
	const path = batchJobPath(app, manifest, deviceId);
	if (await app.vault.adapter.exists(path)) {
		await app.vault.adapter.remove(path);
	}
}
