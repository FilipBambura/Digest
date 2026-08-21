import { ItemView, Platform, ViewStateResult, WorkspaceLeaf } from "obsidian";
import { InstructionsEditModal } from "../modals/instructions-edit-modal";
import type DigestPlugin from "../plugin";
import { autosizeFillAvailable } from "./textarea-autosize";
import { closeSettingsIfOpen } from "./workspace-utils";

export const VIEW_TYPE_INSTRUCTIONS_EDIT = "digest-instructions-edit";

interface InstructionsEditState {
	propertyId: string;
}

export class InstructionsEditView extends ItemView {
	private plugin: DigestPlugin;
	private propertyId = "";
	private cleanupAutosize: (() => void) | null = null;

	constructor(leaf: WorkspaceLeaf, plugin: DigestPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType() {
		return VIEW_TYPE_INSTRUCTIONS_EDIT;
	}

	getIcon() {
		return "pencil";
	}

	getDisplayText() {
		const prop = this.property;
		return prop ? `Instructions - ${prop.name || "unnamed"}` : "Field instructions";
	}

	private get property() {
		return this.plugin.settings.outputProperties.find((p) => p.id === this.propertyId);
	}

	async setState(state: unknown, result: ViewStateResult) {
		const typed = state as InstructionsEditState;
		if (typed?.propertyId) this.propertyId = typed.propertyId;
		this.render();
		await super.setState(state, result);
	}

	getState(): Record<string, unknown> {
		return { propertyId: this.propertyId };
	}

	async onOpen() {
		this.render();
	}

	private render() {
		this.cleanupAutosize?.();
		this.cleanupAutosize = null;

		const prop = this.property;
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("digest-instructions-view");

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
		this.cleanupAutosize = autosizeFillAvailable(textarea, 5);
		window.setTimeout(() => textarea.focus(), 0);
	}

	async onClose() {
		this.cleanupAutosize?.();
		this.cleanupAutosize = null;
		await this.plugin.saveSettings();
		this.contentEl.empty();
	}
}

export async function openInstructionsEditor(plugin: DigestPlugin, propertyId: string) {
	if (Platform.isMobile) {
		new InstructionsEditModal(plugin.app, plugin, propertyId).open();
		return;
	}
	closeSettingsIfOpen(plugin.app);
	const leaf = plugin.app.workspace.getLeaf("tab");
	await leaf.setViewState({ type: VIEW_TYPE_INSTRUCTIONS_EDIT, active: true, state: { propertyId } });
	plugin.app.workspace.revealLeaf(leaf);
}
