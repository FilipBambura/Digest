// Domain types shared across the API layer, logging, and batch processing.
// Kept dependency-free so every other module can import from here without
// risking a circular import.

export interface NoteMetadata {
	Summary: string;
	Keywords: string[];
	Aliases: string[];
}

export type Tier = "free" | "paid";

export interface MetadataResult {
	data: NoteMetadata;
	tier: Tier;
}
