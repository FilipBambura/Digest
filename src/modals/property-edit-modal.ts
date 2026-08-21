import { App, Modal, Notice, Setting } from "obsidian";
import type DigestPlugin from "../plugin";
import { PROPERTY_ITEM_COUNT_MAX, PROPERTY_ITEM_COUNT_MIN } from "../settings";
import { PropertyDefinition, PropertyType } from "../types";
import { autosizeClamped, bindScrollableHeight } from "../views/textarea-autosize";
import { openInstructionsEditor } from "../views/instructions-edit-view";

export class PropertyEditModal extends Modal {
	private plugin: DigestPlugin;
	private propertyId: string;
	private cleanupScroll: (() => void) | null = null;

	constructor(app: App, plugin: DigestPlugin, propertyId: string) {
		super(app);
		this.plugin = plugin;
		this.propertyId = propertyId;
	}

	private get property(): PropertyDefinition | undefined {
		return this.plugin.settings.outputProperties.find((p) => p.id === this.propertyId);
	}

	onOpen() {
		this.modalEl.addClass("digest-property-modal");
		this.cleanupScroll = bindScrollableHeight(this.contentEl);
		this.render();
	}

	private render() {
		const prop = this.property;
		const { contentEl } = this;
		contentEl.empty();

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
			.setDesc("Short summary of the field (sent to the model as schema metadata).");
		const descTextarea = contentEl.createEl("textarea", { cls: "digest-description-textarea" });
		descTextarea.value = prop.description;
		descTextarea.addEventListener("input", () => {
			prop.description = descTextarea.value;
		});
		descTextarea.addEventListener("blur", async () => {
			await this.plugin.saveSettings();
		});
		autosizeClamped(descTextarea, 3, 10);

		new Setting(contentEl)
			.setName("Instructions")
			.setDesc("How to generate this field - sent to the model together with the note content.")
			.addExtraButton((btn) => {
				btn.setIcon("pencil")
					.setTooltip("Edit instructions")
					.onClick(() => {
						openInstructionsEditor(this.plugin, prop.id);
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
		this.cleanupScroll?.();
		this.cleanupScroll = null;
		await this.plugin.saveSettings();
		this.contentEl.empty();
	}
}
