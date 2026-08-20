import { App, Modal } from "obsidian";

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

export function confirmDialog(
	app: App,
	title: string,
	message: string,
	confirmLabel = "Confirm"
): Promise<boolean> {
	return new Promise((resolve) => {
		new ConfirmModal(app, title, message, confirmLabel, resolve).open();
	});
}
