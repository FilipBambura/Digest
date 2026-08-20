import { EncryptedBlob } from "./crypto";
import { DEFAULT_SYSTEM_PROMPT } from "./system-prompt";

export type ModelInputMode = "preset" | "manual";
export type TierMode = "auto" | "freeOnly" | "paidOnly";

export interface DigestSettings {
	systemPrompt: string;
	model: string;
	modelInputMode: ModelInputMode;
	tierMode: TierMode;
	requestTimeoutSeconds: number;
	encryptKeys: boolean;
	freeApiKey: string;
	paidApiKey: string;
	encryptedFreeKey: EncryptedBlob | null;
	encryptedPaidKey: EncryptedBlob | null;
	encryptionCheck: EncryptedBlob | null;
	freeRequestCount: number;
	paidRequestCount: number;
}

export const DEFAULT_SETTINGS: DigestSettings = {
	systemPrompt: DEFAULT_SYSTEM_PROMPT,
	model: "gemini-flash-lite-latest",
	modelInputMode: "preset",
	tierMode: "auto",
	requestTimeoutSeconds: 30,
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
