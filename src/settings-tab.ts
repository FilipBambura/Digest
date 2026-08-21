import { App, Notice, Platform, PluginSettingTab, Setting, normalizePath } from "obsidian";
import type DigestPlugin from "./plugin";
import { MODEL_PRESETS, TierMode } from "./settings";
import { PropertyDefinition } from "./types";
import { ENCRYPTION_CHECK_VALUE, encryptString } from "./crypto";
import { LOG_RETENTION_DAYS, buildLogExportMarkdown, logsDir, readAllLogEntries } from "./logging";
import { loadBatchJob } from "./batch/job-store";
import { promptForPassword } from "./modals/password-prompt-modal";
import { confirmDialog } from "./modals/confirm-modal";
import { openPropertyEditor } from "./views/property-edit-view";

// Local (not UTC) YYYY-MM-DD, so the date picker's default matches the
// user's own calendar day instead of shifting near midnight in some timezones.
function formatDateInput(date: Date): string {
	const year = date.getFullYear();
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	return `${year}-${month}-${day}`;
}

export class DigestSettingTab extends PluginSettingTab {
	plugin: DigestPlugin;

	constructor(app: App, plugin: DigestPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		const s = this.plugin.settings;

		if (Platform.isDesktopApp) {
			const batchSection = containerEl.createDiv();
			this.renderBatchJobSection(batchSection);
		}

		containerEl.createEl("h3", { text: "Output fields" });
		containerEl.createEl("p", {
			text: "Fields Digest fills in a note's frontmatter. Disable, edit or remove any of them, or add your own.",
			cls: "setting-item-description",
		});

		new Setting(containerEl)
			.setName("Force-add missing properties")
			.setDesc(
				"Off (default): only properties that already exist in a note's frontmatter are updated - new keys are never created. On: every enabled field is always written, even to notes that don't have it yet."
			)
			.addToggle((toggle) =>
				toggle.setValue(s.forceAddMissingProperties).onChange(async (value) => {
					s.forceAddMissingProperties = value;
					await this.plugin.saveSettings();
				})
			);

		this.renderOutputPropertiesSection(containerEl);

		new Setting(containerEl)
			.setName("Manual model entry")
			.setDesc("Type an exact model id instead of choosing a preset below.")
			.addToggle((toggle) =>
				toggle.setValue(s.modelInputMode === "manual").onChange(async (value) => {
					s.modelInputMode = value ? "manual" : "preset";
					await this.plugin.saveSettings();
					this.display();
				})
			);

		if (s.modelInputMode === "manual") {
			new Setting(containerEl).setName("Model").addText((text) => {
				text.setValue(s.model);
				text.onChange((value) => {
					s.model = value.trim();
				});
				text.inputEl.addEventListener("blur", async () => {
					await this.plugin.saveSettings();
				});
			});
		} else {
			const currentPreset = MODEL_PRESETS.find((p) => p.value === s.model);
			if (!currentPreset) {
				s.model = MODEL_PRESETS[0].value;
				this.plugin.saveSettings();
			}
			new Setting(containerEl).setName("Model").addDropdown((dropdown) => {
				for (const preset of MODEL_PRESETS) {
					dropdown.addOption(preset.id, preset.label);
				}
				dropdown.setValue(currentPreset ? currentPreset.id : MODEL_PRESETS[0].id);
				dropdown.onChange(async (value) => {
					const preset = MODEL_PRESETS.find((p) => p.id === value);
					if (preset) {
						s.model = preset.value;
						await this.plugin.saveSettings();
					}
				});
			});
		}

		new Setting(containerEl)
			.setName("Request timeout")
			.setDesc("Maximum seconds to wait for a single API response before treating it as failed.")
			.addText((text) => {
				text.setValue(String(s.requestTimeoutSeconds));
				text.inputEl.type = "number";
				text.inputEl.min = "1";
				text.onChange((value) => {
					const n = parseInt(value, 10);
					if (!Number.isNaN(n) && n > 0) {
						s.requestTimeoutSeconds = n;
					}
				});
				text.inputEl.addEventListener("blur", async () => {
					await this.plugin.saveSettings();
				});
			});

		if (Platform.isDesktopApp) {
			// Folder batches are desktop-only (see the file-menu gating in
			// plugin.ts), so this setting would be meaningless - and confusing -
			// on a platform where it can never be used.
			new Setting(containerEl)
				.setName("Parallel requests")
				.setDesc("Number of notes for which metadata is generated in parallel during a folder batch.")
				.addText((text) => {
					text.setValue(String(s.parallelRequests));
					text.inputEl.type = "number";
					text.inputEl.min = "1";
					text.onChange((value) => {
						const n = parseInt(value, 10);
						if (!Number.isNaN(n) && n > 0) {
							s.parallelRequests = n;
						}
					});
					text.inputEl.addEventListener("blur", async () => {
						await this.plugin.saveSettings();
					});
				});
		}

		containerEl.createEl("h3", { text: "API keys" });

		new Setting(containerEl)
			.setName("Encrypt API keys with a password")
			.setDesc(
				"Keys are stored only as AES-GCM encrypted text. The password itself is never stored - you'll need to re-enter it after every Obsidian restart, otherwise the keys stay locked."
			)
			.addToggle((toggle) =>
				toggle.setValue(s.encryptKeys).onChange(async (value) => {
					await this.handleEncryptionToggle(value);
					this.display();
				})
			);

		if (s.encryptKeys) {
			this.renderEncryptedKeySection(containerEl);
		} else {
			this.renderPlainKeySection(containerEl);
		}

		containerEl.createEl("h3", { text: "Free / paid tier" });
		new Setting(containerEl)
			.setName("Tier mode")
			.setDesc("Which API tier to use for requests.")
			.addDropdown((dropdown) => {
				dropdown.addOption("auto", "Automatic (free, then paid fallback)");
				dropdown.addOption("freeOnly", "Free tier only");
				dropdown.addOption("paidOnly", "Paid tier only");
				dropdown.setValue(s.tierMode);
				dropdown.onChange(async (value) => {
					s.tierMode = value as TierMode;
					await this.plugin.saveSettings();
				});
			});

		containerEl.createEl("h3", { text: "Statistics" });
		new Setting(containerEl).setName("Free tier requests").setDesc(String(s.freeRequestCount));
		new Setting(containerEl).setName("Paid tier requests").setDesc(String(s.paidRequestCount));
		new Setting(containerEl).setName("Reset statistics").addButton((btn) =>
			btn.setButtonText("Reset").onClick(async () => {
				const confirmed = await confirmDialog(
					this.app,
					"Reset statistics?",
					"This resets the free tier and paid tier request counters to zero. This cannot be undone.",
					"Reset"
				);
				if (!confirmed) return;
				s.freeRequestCount = 0;
				s.paidRequestCount = 0;
				await this.plugin.saveSettings();
				this.display();
			})
		);

		containerEl.createEl("h3", { text: "Logs" });
		containerEl.createEl("p", {
			text: `Every run is logged locally per device and auto-pruned after ${LOG_RETENTION_DAYS} days.`,
			cls: "setting-item-description",
		});

		const today = new Date();
		const yesterday = new Date(today);
		yesterday.setDate(yesterday.getDate() - 1);
		const tomorrow = new Date(today);
		tomorrow.setDate(tomorrow.getDate() + 1);

		let exportFrom = formatDateInput(yesterday);
		let exportTo = formatDateInput(tomorrow);
		const exportSetting = new Setting(containerEl)
			.setName("Export logs")
			.setDesc("Pick a date range, then export matching entries to a note. Defaults to the last day.");
		const fromInput = exportSetting.controlEl.createEl("input", { type: "date" });
		fromInput.style.marginRight = "6px";
		fromInput.value = exportFrom;
		fromInput.addEventListener("change", (e) => {
			exportFrom = (e.target as HTMLInputElement).value;
		});
		const toInput = exportSetting.controlEl.createEl("input", { type: "date" });
		toInput.style.marginRight = "6px";
		toInput.value = exportTo;
		toInput.addEventListener("change", (e) => {
			exportTo = (e.target as HTMLInputElement).value;
		});
		exportSetting.addButton((btn) =>
			btn.setButtonText("Export").onClick(async () => {
				btn.setDisabled(true);
				try {
					const all = await readAllLogEntries(this.app, this.plugin.manifest);
					const fromMs = exportFrom ? Date.parse(exportFrom) : null;
					const toMs = exportTo ? Date.parse(exportTo) + 86399999 : null;
					const filtered = all.filter((e) => {
						const t = Date.parse(e.ts);
						if (fromMs !== null && t < fromMs) return false;
						if (toMs !== null && t > toMs) return false;
						return true;
					});
					const content = buildLogExportMarkdown(filtered, exportFrom, exportTo);
					const stamp = `${exportFrom || "start"}_${exportTo || "end"}`.replace(/[^0-9a-zA-Z_-]/g, "");
					const filename = `Digest-log-export_${stamp}_${Date.now()}.md`;
					const folder = this.app.fileManager.getNewFileParent(
						this.app.workspace.getActiveFile()?.path ?? "",
						filename
					);
					const path = normalizePath(folder.path ? `${folder.path}/${filename}` : filename);
					const file = await this.app.vault.create(path, content);
					await this.app.workspace.getLeaf(true).openFile(file);
					new Notice(`Exported ${filtered.length} log entries.`);
				} catch (e) {
					console.error("Digest: failed to export logs", e);
					new Notice("Couldn't export logs - see console for details.");
				} finally {
					btn.setDisabled(false);
				}
			})
		);

		new Setting(containerEl)
			.setName("Delete logs")
			.setDesc("Permanently deletes the entire log history, from every device.")
			.addButton((btn) =>
				btn
					.setButtonText("Delete")
					.setWarning()
					.onClick(async () => {
						const confirmed = await confirmDialog(
							this.app,
							"Delete all logs?",
							"This permanently deletes the logged history for every device. This cannot be undone.",
							"Delete"
						);
						if (!confirmed) return;
						try {
							const dir = logsDir(this.app, this.plugin.manifest);
							if (await this.app.vault.adapter.exists(dir)) {
								await this.app.vault.adapter.rmdir(dir, true);
							}
							new Notice("Logs deleted.");
						} catch (e) {
							console.error("Digest: failed to delete logs", e);
							new Notice("Couldn't delete logs - see console for details.");
						}
					})
			);
	}

	private async renderBatchJobSection(container: HTMLElement) {
		const job = await loadBatchJob(this.app, this.plugin.manifest, this.plugin.deviceId);
		if (!job || !job.files.some((f) => f.status === "pending")) return;

		container.empty();
		const done = job.files.filter((f) => f.status !== "pending").length;
		container.createEl("h3", { text: "Unfinished batch" });
		new Setting(container)
			.setName("Batch in progress")
			.setDesc(`${done} of ${job.files.length} notes processed so far. Progress shows in the status bar while it runs.`)
			.addButton((btn) =>
				btn
					.setButtonText("Resume")
					.setCta()
					.onClick(async () => {
						btn.setDisabled(true);
						await this.plugin.resumeBatchJob();
						this.display();
					})
			)
			.addButton((btn) =>
				btn
					.setButtonText("Discard")
					.setWarning()
					.onClick(async () => {
						await this.plugin.discardBatchJob();
						this.display();
					})
			);
	}

	private renderOutputPropertiesSection(containerEl: HTMLElement) {
		const s = this.plugin.settings;

		for (const prop of s.outputProperties) {
			const row = new Setting(containerEl)
				.setName(prop.name || "(unnamed)")
				.setDesc(prop.description || (prop.type === "string[]" ? "List of text" : "Text"));
			row.addToggle((toggle) =>
				toggle.setValue(prop.enabled).onChange(async (value) => {
					prop.enabled = value;
					await this.plugin.saveSettings();
				})
			);
			row.addExtraButton((btn) =>
				btn
					.setIcon("pencil")
					.setTooltip("Edit field")
					.onClick(() => {
						openPropertyEditor(this.plugin, prop.id);
					})
			);
			row.addExtraButton((btn) =>
				btn
					.setIcon("trash")
					.setTooltip("Remove field")
					.onClick(async () => {
						const confirmed = await confirmDialog(
							this.app,
							"Remove field?",
							`"${prop.name}" will no longer be generated or offered here. Values already written to notes are not affected.`,
							"Remove"
						);
						if (!confirmed) return;
						s.outputProperties = s.outputProperties.filter((p) => p.id !== prop.id);
						await this.plugin.saveSettings();
						this.display();
					})
			);
		}

		new Setting(containerEl).addButton((btn) =>
			btn.setButtonText("Add field").onClick(async () => {
				const created: PropertyDefinition = {
					id: crypto.randomUUID(),
					name: "",
					type: "string",
					enabled: true,
					description: "",
					instructions: "",
				};
				s.outputProperties.push(created);
				await this.plugin.saveSettings();
				this.display();
				await openPropertyEditor(this.plugin, created.id);
			})
		);
	}

	private renderPlainKeySection(containerEl: HTMLElement) {
		const s = this.plugin.settings;
		new Setting(containerEl).setName("Free tier API key").addText((text) => {
			text.inputEl.type = "password";
			text.setValue(s.freeApiKey);
			text.onChange((value) => {
				s.freeApiKey = value.trim();
			});
			text.inputEl.addEventListener("blur", async () => {
				await this.plugin.saveSettings();
			});
		});
		new Setting(containerEl).setName("Paid tier API key").addText((text) => {
			text.inputEl.type = "password";
			text.setValue(s.paidApiKey);
			text.onChange((value) => {
				s.paidApiKey = value.trim();
			});
			text.inputEl.addEventListener("blur", async () => {
				await this.plugin.saveSettings();
			});
		});
	}

	private renderEncryptedKeySection(containerEl: HTMLElement) {
		const plugin = this.plugin;
		if (plugin.isLocked()) {
			let passwordValue = "";
			const unlock = async () => {
				const ok = await plugin.unlockWithPassword(passwordValue);
				if (!ok) {
					new Notice("Incorrect password.");
					return;
				}
				this.display();
			};
			new Setting(containerEl)
				.setName("Keys are locked")
				.setDesc("Enter your password to unlock them for this Obsidian session.")
				.addText((text) => {
					text.inputEl.type = "password";
					text.onChange((v) => (passwordValue = v));
					text.inputEl.addEventListener("keydown", (evt) => {
						if (evt.key === "Enter") unlock();
					});
				})
				.addButton((btn) => btn.setButtonText("Unlock").onClick(unlock));
			return;
		}

		new Setting(containerEl)
			.setName("Free tier API key")
			.setDesc("Encrypted - saved (re-encrypted) when you leave the field.")
			.addText((text) => {
				text.inputEl.type = "password";
				text.setValue(plugin.decryptedFreeKey);
				text.onChange((value) => {
					plugin.decryptedFreeKey = value;
				});
				text.inputEl.addEventListener("blur", async () => {
					if (plugin.sessionPassword) {
						plugin.settings.encryptedFreeKey = await encryptString(
							plugin.decryptedFreeKey,
							plugin.sessionPassword
						);
						await plugin.saveSettings();
					}
				});
			});

		new Setting(containerEl)
			.setName("Paid tier API key")
			.setDesc("Encrypted - saved (re-encrypted) when you leave the field.")
			.addText((text) => {
				text.inputEl.type = "password";
				text.setValue(plugin.decryptedPaidKey);
				text.onChange((value) => {
					plugin.decryptedPaidKey = value;
				});
				text.inputEl.addEventListener("blur", async () => {
					if (plugin.sessionPassword) {
						plugin.settings.encryptedPaidKey = await encryptString(
							plugin.decryptedPaidKey,
							plugin.sessionPassword
						);
						await plugin.saveSettings();
					}
				});
			});

		new Setting(containerEl)
			.setName("Lock keys now")
			.setDesc("Clears the decrypted keys from memory without restarting Obsidian.")
			.addButton((btn) =>
				btn.setButtonText("Lock").onClick(() => {
					plugin.lock();
					this.display();
				})
			);
	}

	private async handleEncryptionToggle(enable: boolean) {
		const plugin = this.plugin;
		const s = plugin.settings;
		if (enable) {
			if (!window.crypto?.subtle) {
				new Notice("Encryption isn't available in this environment (Web Crypto API is missing).");
				return;
			}
			const password = await promptForPassword(this.app, "Set a password to encrypt your API keys");
			if (password === null) return;
			s.encryptedFreeKey = s.freeApiKey ? await encryptString(s.freeApiKey, password) : null;
			s.encryptedPaidKey = s.paidApiKey ? await encryptString(s.paidApiKey, password) : null;
			s.encryptionCheck = await encryptString(ENCRYPTION_CHECK_VALUE, password);
			plugin.sessionPassword = password;
			plugin.decryptedFreeKey = s.freeApiKey;
			plugin.decryptedPaidKey = s.paidApiKey;
			s.freeApiKey = "";
			s.paidApiKey = "";
			s.encryptKeys = true;
			await plugin.saveSettings();
		} else {
			if (plugin.isLocked()) {
				new Notice("Unlock the keys with your password first, then you can turn off encryption.");
				return;
			}
			s.freeApiKey = plugin.decryptedFreeKey;
			s.paidApiKey = plugin.decryptedPaidKey;
			s.encryptedFreeKey = null;
			s.encryptedPaidKey = null;
			s.encryptionCheck = null;
			s.encryptKeys = false;
			plugin.lock();
			await plugin.saveSettings();
		}
	}
}
