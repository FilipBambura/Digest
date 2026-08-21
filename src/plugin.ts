import { Notice, Platform, Plugin, TFile, TFolder } from "obsidian";
import { DEFAULT_OUTPUT_PROPERTIES, DEFAULT_SETTINGS, DigestSettings } from "./settings";
import { ENCRYPTION_CHECK_VALUE, decryptString } from "./crypto";
import { NoteMetadata } from "./types";
import { GeminiClient } from "./gemini-client";
import { emptyValueFor, enabledProperties } from "./property-schema";
import { ensureFrontmatterAtFileStart, stripFrontmatter } from "./frontmatter";
import { LOG_RETENTION_DAYS, getDeviceId, logEvent, pruneOwnLogs } from "./logging";
import {
	BatchFileEntry,
	BatchFileStatus,
	BatchJob,
	collectMarkdownFiles,
	deleteBatchJob,
	loadBatchJob,
	saveBatchJob,
} from "./batch/job-store";
import { promptForPassword } from "./modals/password-prompt-modal";
import { confirmDialog } from "./modals/confirm-modal";
import { DiffModal } from "./modals/diff-modal";
import { FolderScopeModal } from "./modals/folder-scope-modal";
import { BatchReviewEntry, BatchReviewModal } from "./modals/batch-review-modal";
import { DigestSettingTab } from "./settings-tab";
import { PropertyEditView, VIEW_TYPE_PROPERTY_EDIT } from "./views/property-edit-view";
import { InstructionsEditView, VIEW_TYPE_INSTRUCTIONS_EDIT } from "./views/instructions-edit-view";

export default class DigestPlugin extends Plugin {
	settings!: DigestSettings;
	deviceId!: string;
	statusBarItem!: HTMLElement;
	geminiClient!: GeminiClient;

	// Session-only state for encryption - NEVER persisted via saveData().
	// After an Obsidian restart these are always null/"" and the password
	// has to be entered again.
	sessionPassword: string | null = null;
	decryptedFreeKey = "";
	decryptedPaidKey = "";

	// Guards against firing a second request for a file that's already being
	// processed (e.g. a double click on the menu item before the first
	// response comes back).
	private processingFiles: Set<string> = new Set();

	// Set to true while a folder batch is running, checked between files
	// so the "Cancel" affordance on the status bar item can stop cleanly.
	private batchCancelled = false;
	private batchRunning = false;

	async onload() {
		await this.loadSettings();
		this.deviceId = getDeviceId(this.app);
		this.geminiClient = new GeminiClient(this);

		pruneOwnLogs(this.app, this.manifest, this.deviceId, LOG_RETENTION_DAYS).catch((e) =>
			console.error("Digest: failed to prune old logs", e)
		);

		this.statusBarItem = this.addStatusBarItem();
		this.statusBarItem.addClass("digest-status-bar");
		this.statusBarItem.style.display = "none";
		this.statusBarItem.addEventListener("click", () => this.handleStatusBarClick());

		this.addSettingTab(new DigestSettingTab(this.app, this));

		this.registerView(VIEW_TYPE_PROPERTY_EDIT, (leaf) => new PropertyEditView(leaf, this));
		this.registerView(VIEW_TYPE_INSTRUCTIONS_EDIT, (leaf) => new InstructionsEditView(leaf, this));

		this.registerEvent(
			this.app.workspace.on("file-menu", (menu, file) => {
				if (file instanceof TFile && file.extension === "md") {
					menu.addItem((item) => {
						item.setTitle("Generate metadata").setIcon("tags").onClick(() => this.processFile(file));
					});
				} else if (file instanceof TFolder && Platform.isDesktopApp) {
					// Folder batches are checkpointed to survive an app restart, but
					// iOS/Android can suspend or kill the JS runtime while backgrounded,
					// which breaks a batch mid-run. Desktop doesn't have that problem,
					// so batch generation is only offered there.
					menu.addItem((item) => {
						item.setTitle("Generate metadata").setIcon("tags").onClick(() => this.processFolder(file));
					});
				}
			})
		);

		const unfinishedJob = await loadBatchJob(this.app, this.manifest, this.deviceId);
		if (unfinishedJob && unfinishedJob.status === "running") {
			const done = unfinishedJob.files.filter((f) => f.status !== "pending").length;
			new Notice(
				`Digest: found an unfinished batch (${done}/${unfinishedJob.files.length}). Resume it from Settings → Digest.`,
				0
			);
		}
	}

	onunload() {
		this.lock();
		this.app.workspace.detachLeavesOfType(VIEW_TYPE_PROPERTY_EDIT);
		this.app.workspace.detachLeavesOfType(VIEW_TYPE_INSTRUCTIONS_EDIT);
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
		// Object.assign only shallow-copies, so without this an install with no
		// saved outputProperties would end up with this.settings.outputProperties
		// pointing at the very same array/objects as DEFAULT_OUTPUT_PROPERTIES -
		// any later in-place edit (add/remove/toggle a field) would then mutate
		// the shared default for the rest of the session.
		const source = this.settings.outputProperties?.length ? this.settings.outputProperties : DEFAULT_OUTPUT_PROPERTIES;
		this.settings.outputProperties = source.map((p) => ({ ...p }));
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	isLocked(): boolean {
		return this.settings.encryptKeys && this.sessionPassword === null;
	}

	async unlockWithPassword(password: string): Promise<boolean> {
		if (this.settings.encryptionCheck) {
			try {
				const check = await decryptString(this.settings.encryptionCheck, password);
				if (check !== ENCRYPTION_CHECK_VALUE) return false;
			} catch (e) {
				return false;
			}
		}
		try {
			const free = this.settings.encryptedFreeKey
				? await decryptString(this.settings.encryptedFreeKey, password)
				: "";
			const paid = this.settings.encryptedPaidKey
				? await decryptString(this.settings.encryptedPaidKey, password)
				: "";
			this.sessionPassword = password;
			this.decryptedFreeKey = free;
			this.decryptedPaidKey = paid;
			return true;
		} catch (e) {
			return false;
		}
	}

	lock() {
		this.sessionPassword = null;
		this.decryptedFreeKey = "";
		this.decryptedPaidKey = "";
	}

	getFreeKey(): string {
		return this.settings.encryptKeys ? this.decryptedFreeKey : this.settings.freeApiKey;
	}

	getPaidKey(): string {
		return this.settings.encryptKeys ? this.decryptedPaidKey : this.settings.paidApiKey;
	}

	async processFile(file: TFile) {
		if (this.processingFiles.has(file.path)) {
			new Notice("This note is already being processed.");
			return;
		}
		this.processingFiles.add(file.path);
		try {
			if (this.isLocked()) {
				const password = await promptForPassword(this.app, "Enter your password to unlock the API keys");
				if (password === null) return;
				const ok = await this.unlockWithPassword(password);
				if (!ok) {
					new Notice("Incorrect password.");
					return;
				}
			}

			if (!this.geminiClient.isConfigured()) {
				new Notice("No API key is configured (Settings → Digest).");
				return;
			}

			let noteContent: string;
			try {
				await ensureFrontmatterAtFileStart(this.app, file);
				noteContent = stripFrontmatter(await this.app.vault.cachedRead(file));
			} catch (e) {
				console.error("Digest: failed to read note", e);
				new Notice("Couldn't read the note (it may have been moved or deleted).");
				return;
			}

			const notice = new Notice("Generating metadata...", 0);
			let proposed: NoteMetadata;
			try {
				proposed = await this.geminiClient.generateMetadata(file.path, noteContent);
			} catch (e: any) {
				notice.hide();
				new Notice(`Error: ${e.message}`);
				return;
			}
			notice.hide();

			const cache = this.app.metadataCache.getFileCache(file)?.frontmatter;
			const properties = enabledProperties(this.settings.outputProperties);
			const oldData: NoteMetadata = {};
			for (const p of properties) {
				oldData[p.name] = cache?.[p.name] ?? emptyValueFor(p.type);
			}

			new DiffModal(this.app, {
				properties,
				old: oldData,
				proposed,
				onAccept: async () => {
					await ensureFrontmatterAtFileStart(this.app, file);
					await this.app.fileManager.processFrontMatter(file, (fm) => {
						for (const p of properties) {
							fm[p.name] = proposed[p.name];
						}
					});
					new Notice("Metadata updated.");
				},
			}).open();
		} catch (e) {
			console.error("Digest: unexpected error", e);
			new Notice("Something went wrong - see the developer console for details.");
		} finally {
			this.processingFiles.delete(file.path);
		}
	}

	private updateStatusBar(job: BatchJob) {
		const done = job.files.filter((f) => f.status !== "pending").length;
		this.statusBarItem.style.display = "";
		this.statusBarItem.setText(`Digest: ${done}/${job.files.length}`);
	}

	private async handleStatusBarClick() {
		if (!this.batchRunning) return;
		const confirmed = await confirmDialog(
			this.app,
			"Cancel batch?",
			"Stop processing the remaining notes in this batch. Notes already generated will still be offered for review.",
			"Cancel batch"
		);
		if (confirmed) this.batchCancelled = true;
	}

	async processFolder(folder: TFolder) {
		if (this.batchRunning) {
			new Notice("A batch is already running.");
			return;
		}

		const existing = await loadBatchJob(this.app, this.manifest, this.deviceId);
		if (existing && existing.files.some((f) => f.status === "pending")) {
			const proceed = await confirmDialog(
				this.app,
				"Unfinished batch exists",
				"A previous batch is still unfinished. Starting a new one will discard it. Continue?",
				"Discard and continue"
			);
			if (!proceed) return;
		}

		new FolderScopeModal(this.app, folder, async (scope) => {
			const files = collectMarkdownFiles(folder, scope === "recursive");
			if (files.length === 0) {
				new Notice("No markdown notes found in this folder.");
				return;
			}
			const confirmed = await confirmDialog(
				this.app,
				"Generate metadata?",
				`${files.length} note${files.length === 1 ? "" : "s"} will be processed. Continue?`,
				"Continue"
			);
			if (!confirmed) return;

			const job: BatchJob = {
				id: crypto.randomUUID(),
				createdAt: new Date().toISOString(),
				status: "running",
				files: files.map((f) => ({ path: f.path, status: "pending" as BatchFileStatus })),
			};
			await saveBatchJob(this.app, this.manifest, this.deviceId, job);
			await this.executeBatchJob(job);
		}).open();
	}

	async resumeBatchJob() {
		const job = await loadBatchJob(this.app, this.manifest, this.deviceId);
		if (!job) {
			new Notice("No unfinished batch found.");
			return;
		}
		await this.executeBatchJob(job);
	}

	async discardBatchJob() {
		await deleteBatchJob(this.app, this.manifest, this.deviceId);
		new Notice("Batch job discarded.");
	}

	private async processBatchEntry(job: BatchJob, entry: BatchFileEntry) {
		const file = this.app.vault.getAbstractFileByPath(entry.path);
		if (!(file instanceof TFile)) {
			entry.status = "error";
			entry.error = "Note no longer exists.";
			await logEvent(this.app, this.manifest, this.deviceId, entry.path, null, "error", entry.error);
			await saveBatchJob(this.app, this.manifest, this.deviceId, job);
			this.updateStatusBar(job);
			return;
		}

		let noteContent: string;
		try {
			await ensureFrontmatterAtFileStart(this.app, file);
			noteContent = stripFrontmatter(await this.app.vault.cachedRead(file));
		} catch (e) {
			entry.status = "error";
			entry.error = "Couldn't read the note.";
			await logEvent(this.app, this.manifest, this.deviceId, entry.path, null, "error", entry.error);
			await saveBatchJob(this.app, this.manifest, this.deviceId, job);
			this.updateStatusBar(job);
			return;
		}

		const rawCache = this.app.metadataCache.getFileCache(file);
		const cache = rawCache ? rawCache.frontmatter : null;
		const properties = enabledProperties(this.settings.outputProperties);
		entry.old = {};
		for (const p of properties) {
			entry.old[p.name] = (cache && cache[p.name]) || emptyValueFor(p.type);
		}

		try {
			entry.proposed = await this.geminiClient.generateMetadata(entry.path, noteContent);
			entry.status = "success";
		} catch (e: any) {
			entry.status = "error";
			entry.error = e.message;
		}

		await saveBatchJob(this.app, this.manifest, this.deviceId, job);
		this.updateStatusBar(job);
	}

	private async executeBatchJob(job: BatchJob) {
		if (this.batchRunning) {
			new Notice("A batch is already running.");
			return;
		}

		if (this.isLocked()) {
			const password = await promptForPassword(this.app, "Enter your password to unlock the API keys");
			if (password === null) return;
			const ok = await this.unlockWithPassword(password);
			if (!ok) {
				new Notice("Incorrect password.");
				return;
			}
		}

		if (!this.geminiClient.isConfigured()) {
			new Notice("No API key is configured (Settings → Digest).");
			return;
		}

		this.batchRunning = true;
		this.batchCancelled = false;
		this.updateStatusBar(job);

		// Bounded-concurrency worker pool: each worker keeps pulling the next
		// pending file off the shared cursor until none are left or the batch
		// is cancelled. JS is single-threaded, so incrementing `cursor` and
		// mutating each entry's status is race-free between `await` points -
		// only the network/disk I/O actually overlaps.
		const pendingCount = job.files.filter((f) => f.status === "pending").length;
		const concurrency = Math.max(1, Math.min(this.settings.parallelRequests || 3, pendingCount));
		let cursor = 0;
		const runWorker = async () => {
			while (!this.batchCancelled) {
				const index = cursor++;
				if (index >= job.files.length) return;
				const entry = job.files[index];
				if (entry.status !== "pending") continue;
				await this.processBatchEntry(job, entry);
			}
		};
		await Promise.all(Array.from({ length: concurrency }, () => runWorker()));

		this.batchRunning = false;
		this.batchCancelled = false;
		this.statusBarItem.style.display = "none";

		const successEntries: BatchReviewEntry[] = [];
		for (const f of job.files) {
			if (f.status !== "success") continue;
			const file = this.app.vault.getAbstractFileByPath(f.path);
			if (!(file instanceof TFile)) continue;
			successEntries.push({
				file,
				status: f.status,
				old: f.old,
				proposed: f.proposed,
				checked: true,
			});
		}

		const errorCount = job.files.filter((f) => f.status === "error").length;
		await deleteBatchJob(this.app, this.manifest, this.deviceId);

		if (successEntries.length === 0) {
			new Notice(
				errorCount > 0
					? `Batch finished - all ${errorCount} note(s) failed. Check the log for details.`
					: "Batch cancelled - no notes were processed."
			);
			return;
		}

		new BatchReviewModal(this.app, enabledProperties(this.settings.outputProperties), successEntries, async (chosen) => {
			await this.applyBatchEntries(chosen);
		}).open();
	}

	private async applyBatchEntries(entries: BatchReviewEntry[]) {
		const properties = enabledProperties(this.settings.outputProperties);
		let applied = 0;
		let failed = 0;
		for (const entry of entries) {
			try {
				await ensureFrontmatterAtFileStart(this.app, entry.file);
				await this.app.fileManager.processFrontMatter(entry.file, (fm) => {
					for (const p of properties) {
						fm[p.name] = (entry.proposed as NoteMetadata)[p.name];
					}
				});
				applied++;
			} catch (e) {
				console.error("Digest: failed to apply batch changes", entry.file.path, e);
				failed++;
			}
		}
		new Notice(`Updated ${applied} note${applied === 1 ? "" : "s"}.${failed ? ` ${failed} failed to write.` : ""}`);
	}
}
