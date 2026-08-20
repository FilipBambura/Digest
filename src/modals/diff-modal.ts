import { App, Modal, Notice } from "obsidian";
import { NoteMetadata } from "../types";
import { renderMetadataDiff } from "./metadata-diff-view";

interface DiffModalOpts {
	old: NoteMetadata;
	proposed: NoteMetadata;
	onAccept: () => Promise<void>;
}

export class DiffModal extends Modal {
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
