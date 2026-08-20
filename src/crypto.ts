// --- Encryption --------------------------------------------------------
// API keys can optionally be encrypted at rest with a user-chosen password.
// The password itself is never persisted - only kept in memory for the
// current Obsidian session (see DigestPlugin.sessionPassword).

export interface EncryptedBlob {
	salt: string;
	iv: string;
	ciphertext: string;
}

export const PBKDF2_ITERATIONS = 250_000;
export const ENCRYPTION_CHECK_VALUE = "digest-encryption-check";

async function deriveAesKey(password: string, salt: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
	const enc = new TextEncoder();
	const baseKey = await crypto.subtle.importKey(
		"raw",
		enc.encode(password),
		"PBKDF2",
		false,
		["deriveKey"]
	);
	return crypto.subtle.deriveKey(
		{
			name: "PBKDF2",
			salt,
			iterations: PBKDF2_ITERATIONS,
			hash: "SHA-256",
		},
		baseKey,
		{ name: "AES-GCM", length: 256 },
		false,
		["encrypt", "decrypt"]
	);
}

function toBase64(buf: ArrayBuffer | Uint8Array): string {
	const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
	let binary = "";
	for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
	return btoa(binary);
}

function fromBase64(b64: string): Uint8Array<ArrayBuffer> {
	const binary = atob(b64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

export async function encryptString(plaintext: string, password: string): Promise<EncryptedBlob> {
	const salt = crypto.getRandomValues(new Uint8Array(16));
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const key = await deriveAesKey(password, salt);
	const enc = new TextEncoder();
	const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(plaintext));
	return {
		salt: toBase64(salt),
		iv: toBase64(iv),
		ciphertext: toBase64(ciphertext),
	};
}

export async function decryptString(blob: EncryptedBlob, password: string): Promise<string> {
	const salt = fromBase64(blob.salt);
	const iv = fromBase64(blob.iv);
	const key = await deriveAesKey(password, salt);
	const ciphertext = fromBase64(blob.ciphertext);
	const plainBuf = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
	return new TextDecoder().decode(plainBuf);
}
