import { App, Modal, TFile } from "obsidian";
import { BatchFileStatus } from "../batch/job-store";
import { NoteMetadata, PropertyDefinition } from "../types";
import { renderMetadataDiff } from "./metadata-diff-view";

export interface BatchReviewEntry {
	file: TFile;
	status: BatchFileStatus;
	old?: NoteMetadata;
	proposed?: NoteMetadata;
	checked: boolean;
}

export class BatchReviewModal extends Modal {
	private properties: PropertyDefinition[];
	private entries: BatchReviewEntry[];
	private onApply: (chosen: BatchReviewEntry[]) => Promise<void>;

	constructor(
		app: App,
		properties: PropertyDefinition[],
		entries: BatchReviewEntry[],
		onApply: (chosen: BatchReviewEntry[]) => Promise<void>
	) {
		super(app);
		this.properties = properties;
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
			renderMetadataDiff(body, this.properties, entry.old as NoteMetadata, entry.proposed as NoteMetadata);
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
