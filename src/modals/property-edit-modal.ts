import { App, Modal, Notice, Setting } from "obsidian";
import { PROPERTY_ITEM_COUNT_MAX, PROPERTY_ITEM_COUNT_MIN } from "../settings";
import { PropertyDefinition, PropertyType } from "../types";

export class PropertyEditModal extends Modal {
	private draft: PropertyDefinition;
	private existing: PropertyDefinition[];
	private onSave: (value: PropertyDefinition) => Promise<void>;
	private isNew: boolean;

	constructor(
		app: App,
		source: PropertyDefinition,
		existing: PropertyDefinition[],
		onSave: (value: PropertyDefinition) => Promise<void>
	) {
		super(app);
		this.draft = { ...source };
		this.existing = existing;
		this.onSave = onSave;
		this.isNew = !existing.some((p) => p.id === source.id);
	}

	onOpen() {
		this.modalEl.addClass("digest-property-modal");
		this.render();
	}

	private render() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl("h2", { text: this.isNew ? "Add output field" : `Edit "${this.draft.name}"` });

		new Setting(contentEl)
			.setName("Field name")
			.setDesc("Written as this key in the note's YAML frontmatter.")
			.addText((text) => {
				text.setValue(this.draft.name);
				text.onChange((value) => (this.draft.name = value.trim()));
			});

		new Setting(contentEl)
			.setName("Type")
			.setDesc("Text = a single value. List of text = an array of values (like Keywords).")
			.addDropdown((dropdown) => {
				dropdown.addOption("string", "Text");
				dropdown.addOption("string[]", "List of text");
				dropdown.setValue(this.draft.type);
				dropdown.onChange((value) => {
					this.draft.type = value as PropertyType;
					if (this.draft.type === "string[]") {
						this.draft.minItems ??= PROPERTY_ITEM_COUNT_MIN;
						this.draft.maxItems ??= 10;
					}
					this.render();
				});
			});

		new Setting(contentEl)
			.setName("Description")
			.setDesc("Short summary of the field (sent to the model as schema metadata).")
			.addText((text) => {
				text.setValue(this.draft.description);
				text.onChange((value) => (this.draft.description = value));
			});

		const instructionsSetting = new Setting(contentEl)
			.setName("Instructions")
			.setDesc("How to generate this field - sent to the model together with the note content.");
		const textarea = instructionsSetting.controlEl.createEl("textarea");
		textarea.value = this.draft.instructions;
		textarea.rows = 5;
		textarea.addEventListener("input", () => (this.draft.instructions = textarea.value));

		if (this.draft.type === "string[]") {
			new Setting(contentEl)
				.setName("Minimum items")
				.setDesc(`Between ${PROPERTY_ITEM_COUNT_MIN} and ${PROPERTY_ITEM_COUNT_MAX}.`)
				.addText((text) => {
					text.setValue(String(this.draft.minItems ?? PROPERTY_ITEM_COUNT_MIN));
					text.inputEl.type = "number";
					text.inputEl.min = String(PROPERTY_ITEM_COUNT_MIN);
					text.inputEl.max = String(PROPERTY_ITEM_COUNT_MAX);
					text.onChange((value) => {
						const n = parseInt(value, 10);
						if (!Number.isNaN(n)) this.draft.minItems = n;
					});
				});
			new Setting(contentEl)
				.setName("Maximum items")
				.setDesc(
					`Between ${PROPERTY_ITEM_COUNT_MIN} and ${PROPERTY_ITEM_COUNT_MAX} - kept bounded so a single field can't overload the model.`
				)
				.addText((text) => {
					text.setValue(String(this.draft.maxItems ?? PROPERTY_ITEM_COUNT_MAX));
					text.inputEl.type = "number";
					text.inputEl.min = String(PROPERTY_ITEM_COUNT_MIN);
					text.inputEl.max = String(PROPERTY_ITEM_COUNT_MAX);
					text.onChange((value) => {
						const n = parseInt(value, 10);
						if (!Number.isNaN(n)) this.draft.maxItems = n;
					});
				});
		}

		const buttonRow = contentEl.createDiv({ cls: "modal-button-container" });
		const cancelBtn = buttonRow.createEl("button", { text: "Cancel" });
		cancelBtn.addEventListener("click", () => this.close());
		const saveBtn = buttonRow.createEl("button", { text: "Save", cls: "mod-cta" });
		saveBtn.addEventListener("click", async () => {
			const error = this.validate();
			if (error) {
				new Notice(error);
				return;
			}
			this.clampCounts();
			saveBtn.disabled = true;
			await this.onSave(this.draft);
			this.close();
		});
	}

	private validate(): string | null {
		if (!this.draft.name) return "Field name can't be empty.";
		if (!/^[A-Za-z_][A-Za-z0-9_ -]*$/.test(this.draft.name)) {
			return "Field name can only contain letters, numbers, spaces, - and _, and can't start with a number.";
		}
		const duplicate = this.existing.some(
			(p) => p.id !== this.draft.id && p.name.toLowerCase() === this.draft.name.toLowerCase()
		);
		if (duplicate) return "A field with this name already exists.";
		return null;
	}

	private clampCounts() {
		if (this.draft.type !== "string[]") {
			delete this.draft.minItems;
			delete this.draft.maxItems;
			return;
		}
		const clamp = (n: number) => Math.min(PROPERTY_ITEM_COUNT_MAX, Math.max(PROPERTY_ITEM_COUNT_MIN, n));
		this.draft.minItems = clamp(this.draft.minItems ?? PROPERTY_ITEM_COUNT_MIN);
		this.draft.maxItems = clamp(this.draft.maxItems ?? PROPERTY_ITEM_COUNT_MAX);
		if (this.draft.minItems > this.draft.maxItems) {
			[this.draft.minItems, this.draft.maxItems] = [this.draft.maxItems, this.draft.minItems];
		}
	}

	onClose() {
		this.contentEl.empty();
	}
}
