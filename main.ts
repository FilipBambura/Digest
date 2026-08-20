import {
	App,
	Modal,
	Notice,
	Plugin,
	PluginSettingTab,
	PluginManifest,
	Setting,
	TFile,
	TFolder,
	normalizePath,
	requestUrl,
} from "obsidian";

const DEFAULT_SYSTEM_PROMPT = `You are an assistant that fills in metadata fields in the YAML frontmatter of
a note in an Obsidian vault. You receive the full text of the note (YAML
frontmatter + body). You return ONLY JSON matching the provided schema - no
surrounding text.

You generate three fields: Summary, Keywords, Aliases.

## Summary
- Formula: [Goal/Problem] + [Key technology/method] + [Result/condition].
- Maximum 1-2 sentences, 30-40 words.
- Forbidden phrases: "This note covers...", "The author describes...",
  "Guide to...". State facts directly, no filler.
- If specific technical conditions (version, platform, technology, language)
  are essential to the content, they must be mentioned in the Summary.

## Language Rule
- IMPORTANT: The generated content (Summary, Keywords, Aliases) must ALWAYS be in the same language as the primary language of the input note. If the note is in Slovak, the output must be in Slovak. If the note is in English, the output must be in English.

## Keywords
- Roughly 5-10 items.
- Lemmatization and synonyms (e.g. "books" -> "book").
- Cross-language variants where relevant (e.g. a term in the note's own
  language alongside its English equivalent, since notes may mix languages).
- Common abbreviations and slang.
- Phrases expressing search intent (e.g. a specific error message, the name
  of the problem the note solves).
- Forbidden generic words with no search value: "guide", "howto", "tutorial",
  "important".

## Aliases
One list contains both types at once:
1. The question the note answers (if it can be phrased naturally; skip it
   for project notes that aren't typically referenced as "how to...").
2. 4 grammatical forms, so a [[link]] fits naturally into a sentence written
   in the note's own language:
   - noun form (subject form)
   - verb form (infinitive)
   - inflected form (e.g. in Slovak, typically the locative case)
   - English form

## Rules
- Base everything strictly on the content of the note you were sent. Do not
  invent or add facts that aren't in it.
- Respect existing YAML fields (tags, Autors, dates) - don't change them,
  just use them as context.`;

type ModelInputMode = "preset" | "manual";
type TierMode = "auto" | "freeOnly" | "paidOnly";

interface EncryptedBlob {
	salt: string;
	iv: string;
	ciphertext: string;
}

interface DigestSettings {
	systemPrompt: string;
	model: string;
	modelInputMode: ModelInputMode;
	tierMode: TierMode;
	requestTimeoutSeconds: number;
	encryptKeys: boolean;
	freeApiKey: string;
	paidApiKey: string;
	encryptedFreeKey: EncryptedBlob | null;
	encryptedPaidKey: EncryptedBlob | null;
	encryptionCheck: EncryptedBlob | null;
	freeRequestCount: number;
	paidRequestCount: number;
}

const DEFAULT_SETTINGS: DigestSettings = {
	systemPrompt: DEFAULT_SYSTEM_PROMPT,
	model: "gemini-flash-lite-latest",
	modelInputMode: "preset",
	tierMode: "auto",
	requestTimeoutSeconds: 30,
	encryptKeys: false,
	freeApiKey: "",
	paidApiKey: "",
	encryptedFreeKey: null,
	encryptedPaidKey: null,
	encryptionCheck: null,
	freeRequestCount: 0,
	paidRequestCount: 0,
};

interface ModelPreset {
	id: string;
	label: string;
	value: string;
}

const MODEL_PRESETS: ModelPreset[] = [
	{ id: "lite", label: "Lite (fastest, cheapest)", value: "gemini-flash-lite-latest" },
	{ id: "flash", label: "Flash (balanced)", value: "gemini-flash-latest" },
	{ id: "pro", label: "Pro (most capable)", value: "gemini-pro-latest" },
];

// --- Encryption --------------------------------------------------------
// API keys can optionally be encrypted at rest with a user-chosen password.
// The password itself is never persisted - only kept in memory for the
// current Obsidian session (see DigestPlugin.sessionPassword).

const PBKDF2_ITERATIONS = 250_000;
const ENCRYPTION_CHECK_VALUE = "digest-encryption-check";

async function deriveAesKey(password: string, salt: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
	const enc = new TextEncoder();
	const baseKey = await crypto.subtle.importKey(
		"raw",
		enc.encode(password),
		"PBKDF2",
		false,
		["deriveKey"]
	);
	return crypto.subtle.deriveKey(
		{
			name: "PBKDF2",
			salt,
			iterations: PBKDF2_ITERATIONS,
			hash: "SHA-256",
		},
		baseKey,
		{ name: "AES-GCM", length: 256 },
		false,
		["encrypt", "decrypt"]
	);
}

function toBase64(buf: ArrayBuffer | Uint8Array): string {
	const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
	let binary = "";
	for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
	return btoa(binary);
}

function fromBase64(b64: string): Uint8Array<ArrayBuffer> {
	const binary = atob(b64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

async function encryptString(plaintext: string, password: string): Promise<EncryptedBlob> {
	const salt = crypto.getRandomValues(new Uint8Array(16));
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const key = await deriveAesKey(password, salt);
	const enc = new TextEncoder();
	const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(plaintext));
	return {
		salt: toBase64(salt),
		iv: toBase64(iv),
		ciphertext: toBase64(ciphertext),
	};
}

async function decryptString(blob: EncryptedBlob, password: string): Promise<string> {
	const salt = fromBase64(blob.salt);
	const iv = fromBase64(blob.iv);
	const key = await deriveAesKey(password, salt);
	const ciphertext = fromBase64(blob.ciphertext);
	const plainBuf = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
	return new TextDecoder().decode(plainBuf);
}

// --- Gemini API ----------------------------------------------------------

const API_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/interactions";
const API_REVISION = "2026-05-20";

const METADATA_SCHEMA = {
	type: "object",
	properties: {
		Summary: {
			type: "string",
			description: "1-2 sentences following the formula Goal/Problem + Technology/Method + Result/Condition.",
		},
		Keywords: {
			type: "array",
			items: { type: "string" },
			minItems: 5,
			maxItems: 10,
		},
		Aliases: {
			type: "array",
			items: { type: "string" },
			minItems: 1,
		},
	},
	required: ["Summary", "Keywords", "Aliases"],
	additionalProperties: false,
};

interface NoteMetadata {
	Summary: string;
	Keywords: string[];
	Aliases: string[];
}

type Tier = "free" | "paid";

interface MetadataResult {
	data: NoteMetadata;
	tier: Tier;
}

class RateLimitError extends Error {}
class TimeoutError extends Error {}

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

async function callModelOnce(
	apiKey: string,
	model: string,
	systemPrompt: string,
	noteContent: string,
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
				input: noteContent,
				response_format: {
					type: "text",
					mime_type: "application/json",
					schema: METADATA_SCHEMA,
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

function stripFrontmatter(content: string): string {
	const lines = content.split(/\r\n|\r|\n/);
	let i = 0;
	while (i < lines.length && lines[i].length === 0) i++;
	if (i >= lines.length || lines[i] !== "---") return content;
	for (let j = i + 1; j < lines.length; j++) {
		if (lines[j] === "---") {
			const bodyLines = lines.slice(j + 1);
			if (bodyLines.length > 0 && bodyLines[0].length === 0) bodyLines.shift();
			return bodyLines.join("\n");
		}
	}
	return content;
}

async function ensureFrontmatterAtFileStart(app: App, file: TFile): Promise<void> {
	await app.vault.process(file, (raw) => {
		const lines = raw.split(/\r\n|\r|\n/);
		let i = 0;
		while (i < lines.length && lines[i].length === 0) i++;
		if (i === 0 || i >= lines.length || lines[i] !== "---") return raw;
		return lines.slice(i).join("\n");
	});
}

async function requestMetadata(
	settings: DigestSettings,
	freeKey: string,
	paidKey: string,
	noteContent: string
): Promise<MetadataResult> {
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

// --- Logging ---------------------------------------------------------
// One JSONL log file per device, named after a random id that is stored
// in localStorage (app.loadLocalStorage/saveLocalStorage) instead of the
// synced settings file. localStorage lives outside the vault filesystem,
// so it never syncs - meaning two devices can never write to the same
// log file at the same time. Export/prune only ever read-then-rewrite a
// single device's own file, so there is no cross-device write conflict.

const LOG_RETENTION_DAYS = 30;
const DEVICE_ID_KEY = "digest-device-id";

interface LogEntry {
	ts: string;
	note: string;
	tier: Tier | null;
	status: "success" | "error";
	error?: string;
}

function getDeviceId(app: App): string {
	let id = app.loadLocalStorage(DEVICE_ID_KEY);
	if (!id) {
		id = crypto.randomUUID();
		app.saveLocalStorage(DEVICE_ID_KEY, id);
	}
	return id;
}

function logsDir(app: App, manifest: PluginManifest): string {
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

async function appendLogEntry(
	app: App,
	manifest: PluginManifest,
	deviceId: string,
	entry: LogEntry
): Promise<void> {
	const path = logFilePath(app, manifest, deviceId);
	await ensureLogFile(app, path);
	await app.vault.adapter.append(path, JSON.stringify(entry) + "\n");
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

async function pruneOwnLogs(
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

async function readAllLogEntries(app: App, manifest: PluginManifest): Promise<LogEntry[]> {
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

function buildLogExportMarkdown(entries: LogEntry[], from: string, to: string): string {
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

// --- Batch jobs --------------------------------------------------------
// A folder batch (many notes) can easily outlive the app session: mobile
// suspends/kills the JS runtime when backgrounded, and quitting Obsidian
// on desktop stops it outright. So batches are checkpointed to disk after
// every single note, one job file per device (same non-sync-conflict
// reasoning as the logs), and can be resumed from Settings on next launch.

type BatchFileStatus = "pending" | "success" | "error";

interface BatchFileEntry {
	path: string;
	status: BatchFileStatus;
	tier?: Tier;
	old?: NoteMetadata;
	proposed?: NoteMetadata;
	error?: string;
}

interface BatchJob {
	id: string;
	createdAt: string;
	status: "running";
	files: BatchFileEntry[];
}

function collectMarkdownFiles(folder: TFolder, recursive: boolean): TFile[] {
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

async function saveBatchJob(
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

async function loadBatchJob(
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

async function deleteBatchJob(app: App, manifest: PluginManifest, deviceId: string): Promise<void> {
	const path = batchJobPath(app, manifest, deviceId);
	if (await app.vault.adapter.exists(path)) {
		await app.vault.adapter.remove(path);
	}
}

// --- Modals --------------------------------------------------------------

class PasswordPromptModal extends Modal {
	private value = "";
	private resolved = false;
	private promptText: string;
	private resolvePromise: (value: string | null) => void;

	constructor(app: App, promptText: string, resolvePromise: (value: string | null) => void) {
		super(app);
		this.promptText = promptText;
		this.resolvePromise = resolvePromise;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl("h2", { text: this.promptText });
		const input = contentEl.createEl("input", { type: "password" });
		input.style.width = "100%";
		input.addEventListener("input", () => {
			this.value = input.value;
		});
		input.addEventListener("keydown", (evt) => {
			if (evt.key === "Enter") this.submit();
		});
		const buttonRow = contentEl.createDiv({ cls: "modal-button-container" });
		const cancelBtn = buttonRow.createEl("button", { text: "Cancel" });
		cancelBtn.addEventListener("click", () => {
			this.finish(null);
			this.close();
		});
		const okBtn = buttonRow.createEl("button", { text: "OK", cls: "mod-cta" });
		okBtn.addEventListener("click", () => this.submit());
		window.setTimeout(() => input.focus(), 0);
	}

	private submit() {
		this.finish(this.value);
		this.close();
	}

	private finish(value: string | null) {
		if (this.resolved) return;
		this.resolved = true;
		this.resolvePromise(value);
	}

	onClose() {
		this.contentEl.empty();
		this.finish(null);
	}
}

function promptForPassword(app: App, promptText: string): Promise<string | null> {
	return new Promise((resolve) => {
		new PasswordPromptModal(app, promptText, resolve).open();
	});
}

class ConfirmModal extends Modal {
	private resolved = false;
	private title: string;
	private message: string;
	private confirmLabel: string;
	private resolvePromise: (value: boolean) => void;

	constructor(
		app: App,
		title: string,
		message: string,
		confirmLabel: string,
		resolvePromise: (value: boolean) => void
	) {
		super(app);
		this.title = title;
		this.message = message;
		this.confirmLabel = confirmLabel;
		this.resolvePromise = resolvePromise;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl("h2", { text: this.title });
		contentEl.createEl("p", { text: this.message });
		const buttonRow = contentEl.createDiv({ cls: "modal-button-container" });
		const cancelBtn = buttonRow.createEl("button", { text: "Cancel" });
		cancelBtn.addEventListener("click", () => {
			this.finish(false);
			this.close();
		});
		const confirmBtn = buttonRow.createEl("button", { text: this.confirmLabel, cls: "mod-warning" });
		confirmBtn.addEventListener("click", () => {
			this.finish(true);
			this.close();
		});
	}

	private finish(value: boolean) {
		if (this.resolved) return;
		this.resolved = true;
		this.resolvePromise(value);
	}

	onClose() {
		this.contentEl.empty();
		this.finish(false);
	}
}

function confirmDialog(
	app: App,
	title: string,
	message: string,
	confirmLabel = "Confirm"
): Promise<boolean> {
	return new Promise((resolve) => {
		new ConfirmModal(app, title, message, confirmLabel, resolve).open();
	});
}

class SystemPromptModal extends Modal {
	private value: string;
	private onSave: (value: string) => Promise<void>;

	constructor(app: App, initialValue: string, onSave: (value: string) => Promise<void>) {
		super(app);
		this.value = initialValue;
		this.onSave = onSave;
	}

	onOpen() {
		this.modalEl.addClass("digest-prompt-modal");
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl("h2", { text: "System prompt" });
		const buttonRow = contentEl.createDiv({ cls: "modal-button-container" });
		const cancelBtn = buttonRow.createEl("button", { text: "Cancel" });
		cancelBtn.addEventListener("click", () => this.close());
		const saveBtn = buttonRow.createEl("button", { text: "Save", cls: "mod-cta" });
		saveBtn.addEventListener("click", async () => {
			await this.onSave(this.value);
			this.close();
		});
		const textarea = contentEl.createEl("textarea");
		textarea.value = this.value;
		textarea.addEventListener("input", () => {
			this.value = textarea.value;
		});
		window.setTimeout(() => textarea.focus(), 0);
	}

	onClose() {
		this.contentEl.empty();
	}
}

function renderChipDiff(container: HTMLElement, before: string[] | undefined, after: string[] | undefined) {
	const wrap = container.createDiv({ cls: "digest-chip-row" });
	const beforeSet = new Set(before ?? []);
	const afterSet = new Set(after ?? []);
	for (const item of before ?? []) {
		if (!afterSet.has(item)) {
			wrap.createSpan({ cls: "digest-chip digest-removed", text: item });
		}
	}
	for (const item of after ?? []) {
		const cls = beforeSet.has(item) ? "digest-chip digest-unchanged" : "digest-chip digest-added";
		wrap.createSpan({ cls, text: item });
	}
}

function renderMetadataDiff(container: HTMLElement, oldData: NoteMetadata, proposed: NoteMetadata) {
	container.createEl("h3", { text: "Summary" });
	if (oldData.Summary) {
		container.createDiv({ cls: "digest-block digest-old", text: oldData.Summary });
	}
	container.createDiv({ cls: "digest-block digest-new", text: proposed.Summary });
	container.createEl("h3", { text: "Keywords" });
	renderChipDiff(container, oldData.Keywords, proposed.Keywords);
	container.createEl("h3", { text: "Aliases" });
	renderChipDiff(container, oldData.Aliases, proposed.Aliases);
}

interface DiffModalOpts {
	old: NoteMetadata;
	proposed: NoteMetadata;
	onAccept: () => Promise<void>;
}

class DiffModal extends Modal {
	private opts: DiffModalOpts;

	constructor(app: App, opts: DiffModalOpts) {
		super(app);
		this.opts = opts;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("digest-diff-modal");
		contentEl.createEl("h2", { text: "Proposed metadata changes" });
		contentEl.createEl("p", {
			text: "Green = added, strikethrough = removed.",
			cls: "setting-item-description",
		});
		renderMetadataDiff(contentEl, this.opts.old, this.opts.proposed);
		const buttonRow = contentEl.createDiv({ cls: "modal-button-container" });
		const cancelBtn = buttonRow.createEl("button", { text: "Cancel" });
		cancelBtn.addEventListener("click", () => this.close());
		const acceptBtn = buttonRow.createEl("button", { text: "Accept changes", cls: "mod-cta" });
		acceptBtn.addEventListener("click", async () => {
			acceptBtn.disabled = true;
			try {
				await this.opts.onAccept();
			} catch (e) {
				console.error("Digest: failed to apply changes", e);
				new Notice("Couldn't write the changes to the note - see console for details.");
			} finally {
				this.close();
			}
		});
	}

	onClose() {
		this.contentEl.empty();
	}
}

type FolderScope = "shallow" | "recursive";

class FolderScopeModal extends Modal {
	private folder: TFolder;
	private onChoice: (scope: FolderScope) => void;

	constructor(app: App, folder: TFolder, onChoice: (scope: FolderScope) => void) {
		super(app);
		this.folder = folder;
		this.onChoice = onChoice;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl("h2", { text: "Generate metadata for folder" });
		contentEl.createEl("p", {
			text: `Choose which notes in "${this.folder.name}" to include.`,
			cls: "setting-item-description",
		});
		const buttonRow = contentEl.createDiv({ cls: "modal-button-container" });
		const cancelBtn = buttonRow.createEl("button", { text: "Cancel" });
		cancelBtn.addEventListener("click", () => this.close());
		const shallowBtn = buttonRow.createEl("button", { text: "Only this folder" });
		shallowBtn.addEventListener("click", () => {
			this.close();
			this.onChoice("shallow");
		});
		const recursiveBtn = buttonRow.createEl("button", {
			text: "Recursively (include subfolders)",
			cls: "mod-cta",
		});
		recursiveBtn.addEventListener("click", () => {
			this.close();
			this.onChoice("recursive");
		});
	}

	onClose() {
		this.contentEl.empty();
	}
}

interface BatchReviewEntry {
	file: TFile;
	status: BatchFileStatus;
	old?: NoteMetadata;
	proposed?: NoteMetadata;
	checked: boolean;
}

class BatchReviewModal extends Modal {
	private entries: BatchReviewEntry[];
	private onApply: (chosen: BatchReviewEntry[]) => Promise<void>;

	constructor(app: App, entries: BatchReviewEntry[], onApply: (chosen: BatchReviewEntry[]) => Promise<void>) {
		super(app);
		this.entries = entries;
		this.onApply = onApply;
	}

	onOpen() {
		this.modalEl.addClass("digest-batch-modal");
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl("h2", { text: "Review batch changes" });

		const readyCount = this.entries.filter((e) => e.status === "success").length;
		const failedCount = this.entries.length - readyCount;
		let summaryText = `${readyCount} note${readyCount === 1 ? "" : "s"} ready to apply.`;
		if (failedCount > 0) {
			summaryText += ` ${failedCount} failed and ${failedCount === 1 ? "is" : "are"} not included below.`;
		}
		contentEl.createEl("p", { text: summaryText, cls: "setting-item-description" });
		contentEl.createEl("p", {
			text: "Uncheck a note to skip it. Expand a row to see the diff.",
			cls: "setting-item-description",
		});

		const list = contentEl.createDiv({ cls: "digest-batch-list" });
		for (const entry of this.entries) {
			if (entry.status !== "success") continue;
			const details = list.createEl("details", { cls: "digest-batch-item" });
			const summary = details.createEl("summary");
			const checkbox = summary.createEl("input", { type: "checkbox" });
			checkbox.checked = entry.checked;
			checkbox.addEventListener("click", (evt) => evt.stopPropagation());
			checkbox.addEventListener("change", () => {
				entry.checked = checkbox.checked;
			});
			summary.createSpan({ text: entry.file.path });
			const body = details.createDiv({ cls: "digest-batch-body" });
			renderMetadataDiff(body, entry.old as NoteMetadata, entry.proposed as NoteMetadata);
		}

		const buttonRow = contentEl.createDiv({ cls: "modal-button-container" });
		const cancelBtn = buttonRow.createEl("button", { text: "Cancel" });
		cancelBtn.addEventListener("click", () => this.close());
		const applyBtn = buttonRow.createEl("button", { text: "Apply selected", cls: "mod-cta" });
		applyBtn.addEventListener("click", async () => {
			applyBtn.disabled = true;
			const chosen = this.entries.filter((e) => e.status === "success" && e.checked);
			try {
				await this.onApply(chosen);
			} finally {
				this.close();
			}
		});
	}

	onClose() {
		this.contentEl.empty();
	}
}

// --- Plugin ----------------------------------------------------------------

export default class DigestPlugin extends Plugin {
	settings!: DigestSettings;
	deviceId!: string;
	statusBarItem!: HTMLElement;

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

		pruneOwnLogs(this.app, this.manifest, this.deviceId, LOG_RETENTION_DAYS).catch((e) =>
			console.error("Digest: failed to prune old logs", e)
		);

		this.statusBarItem = this.addStatusBarItem();
		this.statusBarItem.addClass("digest-status-bar");
		this.statusBarItem.style.display = "none";
		this.statusBarItem.addEventListener("click", () => this.handleStatusBarClick());

		this.addSettingTab(new DigestSettingTab(this.app, this));

		this.registerEvent(
			this.app.workspace.on("file-menu", (menu, file) => {
				if (file instanceof TFile && file.extension === "md") {
					menu.addItem((item) => {
						item.setTitle("Generate metadata").setIcon("tags").onClick(() => this.processFile(file));
					});
				} else if (file instanceof TFolder) {
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
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
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

			const freeKey = this.getFreeKey();
			const paidKey = this.getPaidKey();
			if (!freeKey && !paidKey) {
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
			let result: MetadataResult;
			try {
				result = await requestMetadata(this.settings, freeKey, paidKey, noteContent);
			} catch (e: any) {
				notice.hide();
				console.error("Digest:", e);
				await this.logEvent(file.path, null, "error", e.message);
				new Notice(`Error: ${e.message}`);
				return;
			}
			notice.hide();

			if (result.tier === "free") {
				this.settings.freeRequestCount++;
			} else {
				this.settings.paidRequestCount++;
			}
			await this.saveSettings();
			await this.logEvent(file.path, result.tier, "success");

			const cache = this.app.metadataCache.getFileCache(file)?.frontmatter;
			const oldData: NoteMetadata = {
				Summary: cache?.Summary ?? "",
				Keywords: cache?.Keywords ?? [],
				Aliases: cache?.Aliases ?? [],
			};

			new DiffModal(this.app, {
				old: oldData,
				proposed: result.data,
				onAccept: async () => {
					await ensureFrontmatterAtFileStart(this.app, file);
					await this.app.fileManager.processFrontMatter(file, (fm) => {
						fm.Summary = result.data.Summary;
						fm.Keywords = result.data.Keywords;
						fm.Aliases = result.data.Aliases;
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

	private async logEvent(notePath: string, tier: Tier | null, status: "success" | "error", error?: string) {
		try {
			const entry: LogEntry = {
				ts: new Date().toISOString(),
				note: notePath,
				tier: tier ?? null,
				status,
			};
			if (error) entry.error = error;
			await appendLogEntry(this.app, this.manifest, this.deviceId, entry);
		} catch (e) {
			console.error("Digest: failed to write log entry", e);
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

		const freeKey = this.getFreeKey();
		const paidKey = this.getPaidKey();
		if (!freeKey && !paidKey) {
			new Notice("No API key is configured (Settings → Digest).");
			return;
		}

		this.batchRunning = true;
		this.batchCancelled = false;
		this.updateStatusBar(job);

		for (const entry of job.files) {
			if (entry.status !== "pending") continue;
			if (this.batchCancelled) break;

			const file = this.app.vault.getAbstractFileByPath(entry.path);
			if (!(file instanceof TFile)) {
				entry.status = "error";
				entry.error = "Note no longer exists.";
				await this.logEvent(entry.path, null, "error", entry.error);
				await saveBatchJob(this.app, this.manifest, this.deviceId, job);
				this.updateStatusBar(job);
				continue;
			}

			let noteContent: string;
			try {
				await ensureFrontmatterAtFileStart(this.app, file);
				noteContent = stripFrontmatter(await this.app.vault.cachedRead(file));
			} catch (e) {
				entry.status = "error";
				entry.error = "Couldn't read the note.";
				await this.logEvent(entry.path, null, "error", entry.error);
				await saveBatchJob(this.app, this.manifest, this.deviceId, job);
				this.updateStatusBar(job);
				continue;
			}

			const rawCache = this.app.metadataCache.getFileCache(file);
			const cache = rawCache ? rawCache.frontmatter : null;
			entry.old = {
				Summary: (cache && cache.Summary) || "",
				Keywords: (cache && cache.Keywords) || [],
				Aliases: (cache && cache.Aliases) || [],
			};

			try {
				const result = await requestMetadata(this.settings, freeKey, paidKey, noteContent);
				entry.status = "success";
				entry.tier = result.tier;
				entry.proposed = result.data;
				if (result.tier === "free") {
					this.settings.freeRequestCount++;
				} else {
					this.settings.paidRequestCount++;
				}
				await this.saveSettings();
				await this.logEvent(entry.path, result.tier, "success");
			} catch (e: any) {
				entry.status = "error";
				entry.error = e.message;
				await this.logEvent(entry.path, null, "error", e.message);
			}

			await saveBatchJob(this.app, this.manifest, this.deviceId, job);
			this.updateStatusBar(job);
		}

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

		new BatchReviewModal(this.app, successEntries, async (chosen) => {
			await this.applyBatchEntries(chosen);
		}).open();
	}

	private async applyBatchEntries(entries: BatchReviewEntry[]) {
		let applied = 0;
		let failed = 0;
		for (const entry of entries) {
			try {
				await ensureFrontmatterAtFileStart(this.app, entry.file);
				await this.app.fileManager.processFrontMatter(entry.file, (fm) => {
					fm.Summary = (entry.proposed as NoteMetadata).Summary;
					fm.Keywords = (entry.proposed as NoteMetadata).Keywords;
					fm.Aliases = (entry.proposed as NoteMetadata).Aliases;
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

// --- Settings tab ----------------------------------------------------------

class DigestSettingTab extends PluginSettingTab {
	plugin: DigestPlugin;

	constructor(app: App, plugin: DigestPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		const s = this.plugin.settings;

		const batchSection = containerEl.createDiv();
		this.renderBatchJobSection(batchSection);

		new Setting(containerEl)
			.setName("System prompt")
			.setDesc("Instructions sent together with the note's body when generating metadata.")
			.addExtraButton((btn) => {
				btn.setIcon("pencil")
					.setTooltip("Edit system prompt")
					.onClick(() => {
						new SystemPromptModal(this.app, s.systemPrompt, async (value) => {
							s.systemPrompt = value;
							await this.plugin.saveSettings();
						}).open();
					});
			});

		new Setting(containerEl)
			.setName("Manual model entry")
			.setDesc("Type an exact model id instead of choosing a preset below.")
			.addToggle((toggle) =>
				toggle.setValue(s.modelInputMode === "manual").onChange(async (value) => {
					s.modelInputMode = value ? "manual" : "preset";
					await this.plugin.saveSettings();
					this.display();
				})
			);

		if (s.modelInputMode === "manual") {
			new Setting(containerEl).setName("Model").addText((text) => {
				text.setValue(s.model);
				text.onChange((value) => {
					s.model = value.trim();
				});
				text.inputEl.addEventListener("blur", async () => {
					await this.plugin.saveSettings();
				});
			});
		} else {
			const currentPreset = MODEL_PRESETS.find((p) => p.value === s.model);
			if (!currentPreset) {
				s.model = MODEL_PRESETS[0].value;
				this.plugin.saveSettings();
			}
			new Setting(containerEl).setName("Model").addDropdown((dropdown) => {
				for (const preset of MODEL_PRESETS) {
					dropdown.addOption(preset.id, preset.label);
				}
				dropdown.setValue(currentPreset ? currentPreset.id : MODEL_PRESETS[0].id);
				dropdown.onChange(async (value) => {
					const preset = MODEL_PRESETS.find((p) => p.id === value);
					if (preset) {
						s.model = preset.value;
						await this.plugin.saveSettings();
					}
				});
			});
		}

		new Setting(containerEl)
			.setName("Request timeout")
			.setDesc("Maximum seconds to wait for a single API response before treating it as failed.")
			.addText((text) => {
				text.setValue(String(s.requestTimeoutSeconds));
				text.inputEl.type = "number";
				text.inputEl.min = "1";
				text.onChange((value) => {
					const n = parseInt(value, 10);
					if (!Number.isNaN(n) && n > 0) {
						s.requestTimeoutSeconds = n;
					}
				});
				text.inputEl.addEventListener("blur", async () => {
					await this.plugin.saveSettings();
				});
			});

		containerEl.createEl("h3", { text: "API keys" });

		new Setting(containerEl)
			.setName("Encrypt API keys with a password")
			.setDesc(
				"Keys are stored only as AES-GCM encrypted text. The password itself is never stored - you'll need to re-enter it after every Obsidian restart, otherwise the keys stay locked."
			)
			.addToggle((toggle) =>
				toggle.setValue(s.encryptKeys).onChange(async (value) => {
					await this.handleEncryptionToggle(value);
					this.display();
				})
			);

		if (s.encryptKeys) {
			this.renderEncryptedKeySection(containerEl);
		} else {
			this.renderPlainKeySection(containerEl);
		}

		containerEl.createEl("h3", { text: "Free / paid tier" });
		new Setting(containerEl)
			.setName("Tier mode")
			.setDesc("Which API tier to use for requests.")
			.addDropdown((dropdown) => {
				dropdown.addOption("auto", "Automatic (free, then paid fallback)");
				dropdown.addOption("freeOnly", "Free tier only");
				dropdown.addOption("paidOnly", "Paid tier only");
				dropdown.setValue(s.tierMode);
				dropdown.onChange(async (value) => {
					s.tierMode = value as TierMode;
					await this.plugin.saveSettings();
				});
			});

		containerEl.createEl("h3", { text: "Statistics" });
		new Setting(containerEl).setName("Free tier requests").setDesc(String(s.freeRequestCount));
		new Setting(containerEl).setName("Paid tier requests").setDesc(String(s.paidRequestCount));
		new Setting(containerEl).setName("Reset statistics").addButton((btn) =>
			btn.setButtonText("Reset").onClick(async () => {
				const confirmed = await confirmDialog(
					this.app,
					"Reset statistics?",
					"This resets the free tier and paid tier request counters to zero. This cannot be undone.",
					"Reset"
				);
				if (!confirmed) return;
				s.freeRequestCount = 0;
				s.paidRequestCount = 0;
				await this.plugin.saveSettings();
				this.display();
			})
		);

		containerEl.createEl("h3", { text: "Logs" });
		containerEl.createEl("p", {
			text: `Every run is logged locally per device and auto-pruned after ${LOG_RETENTION_DAYS} days.`,
			cls: "setting-item-description",
		});

		let exportFrom = "";
		let exportTo = "";
		const exportSetting = new Setting(containerEl)
			.setName("Export logs")
			.setDesc("Pick a date range, then export matching entries to a note.");
		const fromInput = exportSetting.controlEl.createEl("input", { type: "date" });
		fromInput.style.marginRight = "6px";
		fromInput.addEventListener("change", (e) => {
			exportFrom = (e.target as HTMLInputElement).value;
		});
		const toInput = exportSetting.controlEl.createEl("input", { type: "date" });
		toInput.style.marginRight = "6px";
		toInput.addEventListener("change", (e) => {
			exportTo = (e.target as HTMLInputElement).value;
		});
		exportSetting.addButton((btn) =>
			btn.setButtonText("Export").onClick(async () => {
				btn.setDisabled(true);
				try {
					const all = await readAllLogEntries(this.app, this.plugin.manifest);
					const fromMs = exportFrom ? Date.parse(exportFrom) : null;
					const toMs = exportTo ? Date.parse(exportTo) + 86399999 : null;
					const filtered = all.filter((e) => {
						const t = Date.parse(e.ts);
						if (fromMs !== null && t < fromMs) return false;
						if (toMs !== null && t > toMs) return false;
						return true;
					});
					const content = buildLogExportMarkdown(filtered, exportFrom, exportTo);
					const stamp = `${exportFrom || "start"}_${exportTo || "end"}`.replace(/[^0-9a-zA-Z_-]/g, "");
					const path = normalizePath(`Digest-log-export_${stamp}_${Date.now()}.md`);
					const file = await this.app.vault.create(path, content);
					await this.app.workspace.getLeaf(true).openFile(file);
					new Notice(`Exported ${filtered.length} log entries.`);
				} catch (e) {
					console.error("Digest: failed to export logs", e);
					new Notice("Couldn't export logs - see console for details.");
				} finally {
					btn.setDisabled(false);
				}
			})
		);

		new Setting(containerEl)
			.setName("Delete logs")
			.setDesc("Permanently deletes the entire log history, from every device.")
			.addButton((btn) =>
				btn
					.setButtonText("Delete")
					.setWarning()
					.onClick(async () => {
						const confirmed = await confirmDialog(
							this.app,
							"Delete all logs?",
							"This permanently deletes the logged history for every device. This cannot be undone.",
							"Delete"
						);
						if (!confirmed) return;
						try {
							const dir = logsDir(this.app, this.plugin.manifest);
							if (await this.app.vault.adapter.exists(dir)) {
								await this.app.vault.adapter.rmdir(dir, true);
							}
							new Notice("Logs deleted.");
						} catch (e) {
							console.error("Digest: failed to delete logs", e);
							new Notice("Couldn't delete logs - see console for details.");
						}
					})
			);
	}

	private async renderBatchJobSection(container: HTMLElement) {
		const job = await loadBatchJob(this.app, this.plugin.manifest, this.plugin.deviceId);
		if (!job || !job.files.some((f) => f.status === "pending")) return;

		container.empty();
		const done = job.files.filter((f) => f.status !== "pending").length;
		container.createEl("h3", { text: "Unfinished batch" });
		new Setting(container)
			.setName("Batch in progress")
			.setDesc(`${done} of ${job.files.length} notes processed so far. Progress shows in the status bar while it runs.`)
			.addButton((btn) =>
				btn
					.setButtonText("Resume")
					.setCta()
					.onClick(async () => {
						btn.setDisabled(true);
						await this.plugin.resumeBatchJob();
						this.display();
					})
			)
			.addButton((btn) =>
				btn
					.setButtonText("Discard")
					.setWarning()
					.onClick(async () => {
						await this.plugin.discardBatchJob();
						this.display();
					})
			);
	}

	private renderPlainKeySection(containerEl: HTMLElement) {
		const s = this.plugin.settings;
		new Setting(containerEl).setName("Free tier API key").addText((text) => {
			text.inputEl.type = "password";
			text.setValue(s.freeApiKey);
			text.onChange((value) => {
				s.freeApiKey = value.trim();
			});
			text.inputEl.addEventListener("blur", async () => {
				await this.plugin.saveSettings();
			});
		});
		new Setting(containerEl).setName("Paid tier API key").addText((text) => {
			text.inputEl.type = "password";
			text.setValue(s.paidApiKey);
			text.onChange((value) => {
				s.paidApiKey = value.trim();
			});
			text.inputEl.addEventListener("blur", async () => {
				await this.plugin.saveSettings();
			});
		});
	}

	private renderEncryptedKeySection(containerEl: HTMLElement) {
		const plugin = this.plugin;
		if (plugin.isLocked()) {
			let passwordValue = "";
			const unlock = async () => {
				const ok = await plugin.unlockWithPassword(passwordValue);
				if (!ok) {
					new Notice("Incorrect password.");
					return;
				}
				this.display();
			};
			new Setting(containerEl)
				.setName("Keys are locked")
				.setDesc("Enter your password to unlock them for this Obsidian session.")
				.addText((text) => {
					text.inputEl.type = "password";
					text.onChange((v) => (passwordValue = v));
					text.inputEl.addEventListener("keydown", (evt) => {
						if (evt.key === "Enter") unlock();
					});
				})
				.addButton((btn) => btn.setButtonText("Unlock").onClick(unlock));
			return;
		}

		new Setting(containerEl)
			.setName("Free tier API key")
			.setDesc("Encrypted - saved (re-encrypted) when you leave the field.")
			.addText((text) => {
				text.inputEl.type = "password";
				text.setValue(plugin.decryptedFreeKey);
				text.onChange((value) => {
					plugin.decryptedFreeKey = value;
				});
				text.inputEl.addEventListener("blur", async () => {
					if (plugin.sessionPassword) {
						plugin.settings.encryptedFreeKey = await encryptString(
							plugin.decryptedFreeKey,
							plugin.sessionPassword
						);
						await plugin.saveSettings();
					}
				});
			});

		new Setting(containerEl)
			.setName("Paid tier API key")
			.setDesc("Encrypted - saved (re-encrypted) when you leave the field.")
			.addText((text) => {
				text.inputEl.type = "password";
				text.setValue(plugin.decryptedPaidKey);
				text.onChange((value) => {
					plugin.decryptedPaidKey = value;
				});
				text.inputEl.addEventListener("blur", async () => {
					if (plugin.sessionPassword) {
						plugin.settings.encryptedPaidKey = await encryptString(
							plugin.decryptedPaidKey,
							plugin.sessionPassword
						);
						await plugin.saveSettings();
					}
				});
			});

		new Setting(containerEl)
			.setName("Lock keys now")
			.setDesc("Clears the decrypted keys from memory without restarting Obsidian.")
			.addButton((btn) =>
				btn.setButtonText("Lock").onClick(() => {
					plugin.lock();
					this.display();
				})
			);
	}

	private async handleEncryptionToggle(enable: boolean) {
		const plugin = this.plugin;
		const s = plugin.settings;
		if (enable) {
			if (!window.crypto?.subtle) {
				new Notice("Encryption isn't available in this environment (Web Crypto API is missing).");
				return;
			}
			const password = await promptForPassword(this.app, "Set a password to encrypt your API keys");
			if (password === null) return;
			s.encryptedFreeKey = s.freeApiKey ? await encryptString(s.freeApiKey, password) : null;
			s.encryptedPaidKey = s.paidApiKey ? await encryptString(s.paidApiKey, password) : null;
			s.encryptionCheck = await encryptString(ENCRYPTION_CHECK_VALUE, password);
			plugin.sessionPassword = password;
			plugin.decryptedFreeKey = s.freeApiKey;
			plugin.decryptedPaidKey = s.paidApiKey;
			s.freeApiKey = "";
			s.paidApiKey = "";
			s.encryptKeys = true;
			await plugin.saveSettings();
		} else {
			if (plugin.isLocked()) {
				new Notice("Unlock the keys with your password first, then you can turn off encryption.");
				return;
			}
			s.freeApiKey = plugin.decryptedFreeKey;
			s.paidApiKey = plugin.decryptedPaidKey;
			s.encryptedFreeKey = null;
			s.encryptedPaidKey = null;
			s.encryptionCheck = null;
			s.encryptKeys = false;
			plugin.lock();
			await plugin.saveSettings();
		}
	}
}
