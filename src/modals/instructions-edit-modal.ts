import { App, Modal } from "obsidian";
import type DigestPlugin from "../plugin";
import { autosizeClamped, bindScrollableHeight } from "../views/textarea-autosize";

export class InstructionsEditModal extends Modal {
	private plugin: DigestPlugin;
	private propertyId: string;
	private cleanupAutosize: (() => void) | null = null;
	private cleanupScroll: (() => void) | null = null;

	constructor(app: App, plugin: DigestPlugin, propertyId: string) {
		super(app);
		this.plugin = plugin;
		this.propertyId = propertyId;
	}

	private get property() {
		return this.plugin.settings.outputProperties.find((p) => p.id === this.propertyId);
	}

	onOpen() {
		this.modalEl.addClass("digest-instructions-modal");
		this.cleanupScroll = bindScrollableHeight(this.contentEl);
		const prop = this.property;
		const { contentEl } = this;
		contentEl.empty();

		if (!prop) {
			contentEl.createEl("p", { text: "This field no longer exists." });
			return;
		}

		contentEl.createEl("h2", { text: `Instructions for "${prop.name || "unnamed"}"` });
		contentEl.createEl("p", {
			text: "How to generate this field - sent to the model together with the note content.",
			cls: "setting-item-description",
		});

		const textarea = contentEl.createEl("textarea", { cls: "digest-instructions-textarea" });
		textarea.value = prop.instructions;
		textarea.addEventListener("input", () => {
			prop.instructions = textarea.value;
		});
		textarea.addEventListener("blur", async () => {
			await this.plugin.saveSettings();
		});
		this.cleanupAutosize = autosizeClamped(textarea, 5, 16);
		window.setTimeout(() => textarea.focus(), 0);
	}

	async onClose() {
		this.cleanupAutosize?.();
		this.cleanupAutosize = null;
		this.cleanupScroll?.();
		this.cleanupScroll = null;
		await this.plugin.saveSettings();
		this.contentEl.empty();
	}
}
