import { NoteMetadata } from "../types";

function renderChipDiff(container: HTMLElement, before: string[] | undefined, after: string[] | undefined) {
	const wrap = container.createDiv({ cls: "digest-chip-row" });
	const beforeSet = new Set(before ?? []);
	const afterSet = new Set(after ?? []);
	for (const item of before ?? []) {
		if (!afterSet.has(item)) {
			wrap.createSpan({ cls: "digest-chip digest-removed", text: item });
		}
	}
	for (const item of after ?? []) {
		const cls = beforeSet.has(item) ? "digest-chip digest-unchanged" : "digest-chip digest-added";
		wrap.createSpan({ cls, text: item });
	}
}

export function renderMetadataDiff(container: HTMLElement, oldData: NoteMetadata, proposed: NoteMetadata) {
	container.createEl("h3", { text: "Summary" });
	if (oldData.Summary) {
		container.createDiv({ cls: "digest-block digest-old", text: oldData.Summary });
	}
	container.createDiv({ cls: "digest-block digest-new", text: proposed.Summary });
	container.createEl("h3", { text: "Keywords" });
	renderChipDiff(container, oldData.Keywords, proposed.Keywords);
	container.createEl("h3", { text: "Aliases" });
	renderChipDiff(container, oldData.Aliases, proposed.Aliases);
}
