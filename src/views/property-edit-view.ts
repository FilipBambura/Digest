import { ItemView, Notice, Setting, ViewStateResult, WorkspaceLeaf } from "obsidian";
import type DigestPlugin from "../plugin";
import { PROPERTY_ITEM_COUNT_MAX, PROPERTY_ITEM_COUNT_MIN } from "../settings";
import { PropertyDefinition, PropertyType } from "../types";
import { openInstructionsEditView } from "./instructions-edit-view";
import { closeSettingsIfOpen } from "./workspace-utils";

export const VIEW_TYPE_PROPERTY_EDIT = "digest-property-edit";

interface PropertyEditState {
	propertyId: string;
}

export class PropertyEditView extends ItemView {
	private plugin: DigestPlugin;
	private propertyId = "";

	constructor(leaf: WorkspaceLeaf, plugin: DigestPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType() {
		return VIEW_TYPE_PROPERTY_EDIT;
	}

	getIcon() {
		return "pencil";
	}

	getDisplayText() {
		const prop = this.property;
		return prop ? `Edit "${prop.name || "unnamed"}"` : "Edit output field";
	}

	private get property(): PropertyDefinition | undefined {
		return this.plugin.settings.outputProperties.find((p) => p.id === this.propertyId);
	}

	async setState(state: unknown, result: ViewStateResult) {
		const typed = state as PropertyEditState;
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
		const prop = this.property;
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("digest-property-view");

		if (!prop) {
			contentEl.createEl("p", { text: "This field no longer exists." });
			return;
		}

		contentEl.createEl("h2", { text: `Edit "${prop.name || "unnamed"}"` });

		let lastValidName = prop.name;
		new Setting(contentEl)
			.setName("Field name")
			.setDesc("Written as this key in the note's YAML frontmatter.")
			.addText((text) => {
				text.setValue(prop.name);
				text.onChange((value) => {
					prop.name = value.trim();
				});
				text.inputEl.addEventListener("blur", async () => {
					const error = this.validateName(prop);
					if (error) {
						new Notice(error);
						prop.name = lastValidName;
						text.setValue(lastValidName);
						return;
					}
					lastValidName = prop.name;
					await this.plugin.saveSettings();
				});
			});

		new Setting(contentEl)
			.setName("Type")
			.setDesc("Text = a single value. List of text = an array of values (like Keywords).")
			.addDropdown((dropdown) => {
				dropdown.addOption("string", "Text");
				dropdown.addOption("string[]", "List of text");
				dropdown.setValue(prop.type);
				dropdown.onChange(async (value) => {
					prop.type = value as PropertyType;
					if (prop.type === "string[]") {
						prop.minItems ??= PROPERTY_ITEM_COUNT_MIN;
						prop.maxItems ??= 10;
					} else {
						delete prop.minItems;
						delete prop.maxItems;
					}
					await this.plugin.saveSettings();
					this.render();
				});
			});

		new Setting(contentEl)
			.setName("Description")
			.setDesc("Short summary of the field (sent to the model as schema metadata).")
			.addText((text) => {
				text.setValue(prop.description);
				text.onChange((value) => {
					prop.description = value;
				});
				text.inputEl.addEventListener("blur", async () => {
					await this.plugin.saveSettings();
				});
			});

		new Setting(contentEl)
			.setName("Instructions")
			.setDesc("How to generate this field - sent to the model together with the note content.")
			.addExtraButton((btn) => {
				btn.setIcon("pencil")
					.setTooltip("Edit instructions")
					.onClick(() => {
						openInstructionsEditView(this.plugin, prop.id);
					});
			});

		if (prop.type === "string[]") {
			new Setting(contentEl)
				.setName("Minimum items")
				.setDesc(`Between ${PROPERTY_ITEM_COUNT_MIN} and ${PROPERTY_ITEM_COUNT_MAX}.`)
				.addText((text) => {
					text.setValue(String(prop.minItems ?? PROPERTY_ITEM_COUNT_MIN));
					text.inputEl.type = "number";
					text.inputEl.min = String(PROPERTY_ITEM_COUNT_MIN);
					text.inputEl.max = String(PROPERTY_ITEM_COUNT_MAX);
					text.onChange((value) => {
						const n = parseInt(value, 10);
						if (!Number.isNaN(n)) prop.minItems = n;
					});
					text.inputEl.addEventListener("blur", async () => {
						this.clampCounts(prop);
						await this.plugin.saveSettings();
						this.render();
					});
				});
			new Setting(contentEl)
				.setName("Maximum items")
				.setDesc(
					`Between ${PROPERTY_ITEM_COUNT_MIN} and ${PROPERTY_ITEM_COUNT_MAX} - kept bounded so a single field can't overload the model.`
				)
				.addText((text) => {
					text.setValue(String(prop.maxItems ?? PROPERTY_ITEM_COUNT_MAX));
					text.inputEl.type = "number";
					text.inputEl.min = String(PROPERTY_ITEM_COUNT_MIN);
					text.inputEl.max = String(PROPERTY_ITEM_COUNT_MAX);
					text.onChange((value) => {
						const n = parseInt(value, 10);
						if (!Number.isNaN(n)) prop.maxItems = n;
					});
					text.inputEl.addEventListener("blur", async () => {
						this.clampCounts(prop);
						await this.plugin.saveSettings();
						this.render();
					});
				});
		}
	}

	private validateName(prop: PropertyDefinition): string | null {
		if (!prop.name) return "Field name can't be empty.";
		if (!/^[A-Za-z_][A-Za-z0-9_ -]*$/.test(prop.name)) {
			return "Field name can only contain letters, numbers, spaces, - and _, and can't start with a number.";
		}
		const duplicate = this.plugin.settings.outputProperties.some(
			(p) => p.id !== prop.id && p.name.toLowerCase() === prop.name.toLowerCase()
		);
		if (duplicate) return "A field with this name already exists.";
		return null;
	}

	private clampCounts(prop: PropertyDefinition) {
		const clamp = (n: number) => Math.min(PROPERTY_ITEM_COUNT_MAX, Math.max(PROPERTY_ITEM_COUNT_MIN, n));
		prop.minItems = clamp(prop.minItems ?? PROPERTY_ITEM_COUNT_MIN);
		prop.maxItems = clamp(prop.maxItems ?? PROPERTY_ITEM_COUNT_MAX);
		if (prop.minItems > prop.maxItems) {
			[prop.minItems, prop.maxItems] = [prop.maxItems, prop.minItems];
		}
	}

	async onClose() {
		await this.plugin.saveSettings();
		this.contentEl.empty();
	}
}

export async function openPropertyEditView(plugin: DigestPlugin, propertyId: string) {
	closeSettingsIfOpen(plugin.app);
	const leaf = plugin.app.workspace.getLeaf("tab");
	await leaf.setViewState({ type: VIEW_TYPE_PROPERTY_EDIT, active: true, state: { propertyId } });
	plugin.app.workspace.revealLeaf(leaf);
}
