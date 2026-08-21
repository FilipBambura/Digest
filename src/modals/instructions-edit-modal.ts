import { App, Modal } from "obsidian";

export class InstructionsEditModal extends Modal {
	private value: string;
	private onSave: (value: string) => void;

	constructor(app: App, value: string, onSave: (value: string) => void) {
		super(app);
		this.value = value;
		this.onSave = onSave;
	}

	onOpen() {
		this.modalEl.addClass("digest-instructions-modal");
		const { contentEl } = this;
		contentEl.empty();

		const buttonRow = contentEl.createDiv({ cls: "digest-modal-header-buttons" });
		const cancelBtn = buttonRow.createEl("button", { text: "Cancel" });
		cancelBtn.addEventListener("click", () => this.close());
		const saveBtn = buttonRow.createEl("button", { text: "Save", cls: "mod-cta" });
		saveBtn.addEventListener("click", () => {
			this.onSave(this.value);
			this.close();
		});

		contentEl.createEl("h2", { text: "Edit instructions" });

		const textarea = contentEl.createEl("textarea");
		textarea.value = this.value;
		textarea.addEventListener("input", () => (this.value = textarea.value));
		window.setTimeout(() => textarea.focus(), 0);
	}

	onClose() {
		this.contentEl.empty();
	}
}
