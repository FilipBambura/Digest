import { NoteMetadata, PropertyDefinition } from "../types";

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

export function renderMetadataDiff(
	container: HTMLElement,
	properties: PropertyDefinition[],
	oldData: NoteMetadata,
	proposed: NoteMetadata
) {
	for (const p of properties) {
		container.createEl("h3", { text: p.name });
		if (p.type === "string[]") {
			renderChipDiff(container, oldData[p.name] as string[] | undefined, proposed[p.name] as string[] | undefined);
		} else {
			const oldVal = oldData[p.name] as string | undefined;
			if (oldVal) {
				container.createDiv({ cls: "digest-block digest-old", text: oldVal });
			}
			container.createDiv({ cls: "digest-block digest-new", text: (proposed[p.name] as string) ?? "" });
		}
	}
}
