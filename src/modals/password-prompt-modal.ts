import { App, Modal } from "obsidian";

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

export function promptForPassword(app: App, promptText: string): Promise<string | null> {
	return new Promise((resolve) => {
		new PasswordPromptModal(app, promptText, resolve).open();
	});
}
