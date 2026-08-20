import { App, Modal, TFolder } from "obsidian";

export type FolderScope = "shallow" | "recursive";

export class FolderScopeModal extends Modal {
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
