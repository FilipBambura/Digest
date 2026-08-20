import { App, TFile } from "obsidian";

export function stripFrontmatter(content: string): string {
	const lines = content.split(/\r\n|\r|\n/);
	let i = 0;
	while (i < lines.length && lines[i].length === 0) i++;
	if (i >= lines.length || lines[i] !== "---") return content;
	for (let j = i + 1; j < lines.length; j++) {
		if (lines[j] === "---") {
			const bodyLines = lines.slice(j + 1);
			if (bodyLines.length > 0 && bodyLines[0].length === 0) bodyLines.shift();
			return bodyLines.join("\n");
		}
	}
	return content;
}

export async function ensureFrontmatterAtFileStart(app: App, file: TFile): Promise<void> {
	await app.vault.process(file, (raw) => {
		const lines = raw.split(/\r\n|\r|\n/);
		let i = 0;
		while (i < lines.length && lines[i].length === 0) i++;
		if (i === 0 || i >= lines.length || lines[i] !== "---") return raw;
		return lines.slice(i).join("\n");
	});
}
