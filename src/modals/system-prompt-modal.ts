import { App, Modal } from "obsidian";

export class SystemPromptModal extends Modal {
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
