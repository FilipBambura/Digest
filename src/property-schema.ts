// Turns the user-configured output field definitions (DigestSettings.
// outputProperties) into what the Gemini API actually needs: a JSON schema
// for structured output, and the per-field instructions appended to the
// user prompt. Kept separate from gemini-client.ts so the
// "settings shape -> API shape" mapping stays in one small, obvious place.

import { PropertyDefinition, PropertyType } from "./types";

export function enabledProperties(properties: PropertyDefinition[]): PropertyDefinition[] {
	return properties.filter((p) => p.enabled);
}

export function buildJsonSchema(properties: PropertyDefinition[]): Record<string, unknown> {
	const props: Record<string, unknown> = {};
	const required: string[] = [];
	for (const p of properties) {
		if (p.type === "string[]") {
			props[p.name] = {
				type: "array",
				items: { type: "string" },
				...(p.minItems !== undefined ? { minItems: p.minItems } : {}),
				...(p.maxItems !== undefined ? { maxItems: p.maxItems } : {}),
				...(p.description ? { description: p.description } : {}),
			};
		} else {
			props[p.name] = {
				type: "string",
				...(p.description ? { description: p.description } : {}),
			};
		}
		required.push(p.name);
	}
	return { type: "object", properties: props, required, additionalProperties: false };
}

export function buildUserPrompt(properties: PropertyDefinition[], noteContent: string): string {
	const fieldLines = properties
		.map((p) => `- ${p.name}: ${p.instructions || p.description || "Generate an appropriate value based on the note."}`)
		.join("\n");
	return `Generate the following fields. Follow each field's own instructions exactly:\n${fieldLines}\n\n--- Note content ---\n${noteContent}`;
}

export function emptyValueFor(type: PropertyType): string | string[] {
	return type === "string[]" ? [] : "";
}
