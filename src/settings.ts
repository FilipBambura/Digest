import { EncryptedBlob } from "./crypto";
import { PropertyDefinition } from "./types";

export type ModelInputMode = "preset" | "manual";
export type TierMode = "auto" | "freeOnly" | "paidOnly";

// Ceiling for a single list-type field's item count (minItems/maxItems),
// enforced by the settings UI - so one field can't blow up the response
// even though there's no cap on how many output fields you can define.
export const PROPERTY_ITEM_COUNT_MIN = 1;
export const PROPERTY_ITEM_COUNT_MAX = 20;

export interface DigestSettings {
	model: string;
	modelInputMode: ModelInputMode;
	tierMode: TierMode;
	requestTimeoutSeconds: number;
	parallelRequests: number;
	outputProperties: PropertyDefinition[];
	forceAddMissingProperties: boolean;
	encryptKeys: boolean;
	freeApiKey: string;
	paidApiKey: string;
	encryptedFreeKey: EncryptedBlob | null;
	encryptedPaidKey: EncryptedBlob | null;
	encryptionCheck: EncryptedBlob | null;
	freeRequestCount: number;
	paidRequestCount: number;
}

export const DEFAULT_OUTPUT_PROPERTIES: PropertyDefinition[] = [
	{
		id: "summary",
		name: "Summary",
		type: "string",
		enabled: true,
		description: "1-2 sentences summarizing the note.",
		instructions:
			'Formula: [Goal/Problem] + [Key technology/method] + [Result/condition]. Maximum 1-2 sentences, 30-40 words. Forbidden phrases: "This note covers...", "The author describes...", "Guide to...". State facts directly, no filler. If specific technical conditions (version, platform, technology, language) are essential to the content, they must be mentioned.',
	},
	{
		id: "keywords",
		name: "Keywords",
		type: "string[]",
		enabled: true,
		minItems: 5,
		maxItems: 10,
		description: "Search keywords for the note.",
		instructions:
			'Lemmatization and synonyms (e.g. "books" -> "book"). Cross-language variants where relevant (e.g. a term in the note\'s own language alongside its English equivalent, since notes may mix languages). Common abbreviations and slang. Phrases expressing search intent (e.g. a specific error message, the name of the problem the note solves). Forbidden generic words with no search value: "guide", "howto", "tutorial", "important".',
	},
	{
		id: "aliases",
		name: "Aliases",
		type: "string[]",
		enabled: true,
		minItems: 1,
		maxItems: 10,
		description: "Alternate names/questions this note answers, used for [[links]].",
		instructions:
			'One list containing both types at once: 1. The question the note answers (if it can be phrased naturally; skip it for project notes that aren\'t typically referenced as "how to..."). 2. 4 grammatical forms, so a [[link]] fits naturally into a sentence written in the note\'s own language: noun form (subject form), verb form (infinitive), inflected form (e.g. in Slovak, typically the locative case), English form.',
	},
];

export const DEFAULT_SETTINGS: DigestSettings = {
	model: "gemini-flash-lite-latest",
	modelInputMode: "preset",
	tierMode: "auto",
	requestTimeoutSeconds: 30,
	parallelRequests: 3,
	outputProperties: DEFAULT_OUTPUT_PROPERTIES,
	forceAddMissingProperties: false,
	encryptKeys: false,
	freeApiKey: "",
	paidApiKey: "",
	encryptedFreeKey: null,
	encryptedPaidKey: null,
	encryptionCheck: null,
	freeRequestCount: 0,
	paidRequestCount: 0,
};

export interface ModelPreset {
	id: string;
	label: string;
	value: string;
}

export const MODEL_PRESETS: ModelPreset[] = [
	{ id: "lite", label: "Lite (fastest, cheapest)", value: "gemini-flash-lite-latest" },
	{ id: "flash", label: "Flash (balanced)", value: "gemini-flash-latest" },
	{ id: "pro", label: "Pro (most capable)", value: "gemini-pro-latest" },
];
