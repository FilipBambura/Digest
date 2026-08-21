import { App } from "obsidian";

// `App.setting` isn't part of the public API surface (obsidian.d.ts has no
// declaration for it), but the settings dialog is a plain modal overlaying
// the workspace - if we don't close it, a newly opened editor tab underneath
// is invisible until the user closes settings themselves.
export function closeSettingsIfOpen(app: App) {
	const withSetting = app as unknown as { setting?: { close?: () => void } };
	withSetting.setting?.close?.();
}
