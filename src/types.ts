// Domain types shared across the API layer, logging, and batch processing.
// Kept dependency-free so every other module can import from here without
// risking a circular import.

export type PropertyType = "string" | "string[]";

// User-configurable definition of one output field. The set of these
// (DigestSettings.outputProperties) fully determines the JSON schema sent
// to Gemini and the frontmatter keys written back to the note - nothing
// else in the plugin hardcodes field names anymore.
export interface PropertyDefinition {
	id: string;
	name: string;
	type: PropertyType;
	enabled: boolean;
	// Short, schema-level summary - sent to Gemini as the JSON schema
	// property's own "description".
	description: string;
	// Longer, per-field guidance - assembled into the user prompt alongside
	// the note content (never into the system prompt, which stays static).
	instructions: string;
	// Only meaningful when type is "string[]". Clamped in the settings UI to
	// [PROPERTY_ITEM_COUNT_MIN, PROPERTY_ITEM_COUNT_MAX] so a single field
	// can't balloon the response.
	minItems?: number;
	maxItems?: number;
}

// Field name -> generated value. Shape is only known at runtime, from the
// current outputProperties, so callers can't assume specific keys exist.
export type NoteMetadata = Record<string, string | string[]>;

export type Tier = "free" | "paid";

export interface MetadataResult {
	data: NoteMetadata;
	tier: Tier;
}
