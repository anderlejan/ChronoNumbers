/* ChronoNumbers – master-password encryption of the vault.
 * Scheme (unchanged since 1.x, so older vaults keep opening): PBKDF2-SHA-256, 250 000 iterations, 16-byte salt →
 * AES-GCM-256 key; each save encrypts JSON {accounts:[…]} with a fresh 12-byte IV. Stored as Base64 {salt, iv, ciphertext}.
 * Copyright (C) 2026 anderlejan. GPL-3.0-or-later. */
(function (root) {
    'use strict';
    const CN = root.CN = root.CN || {};
    const { bytesToBase64, base64ToBytes } = CN.encoding;

    const ITERATIONS = 250000;
    const MIN_PASSWORD_LENGTH = 8;

    async function deriveKey(password, salt) {
        const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), { name: 'PBKDF2' }, false, ['deriveKey']);
        return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: ITERATIONS, hash: 'SHA-256' },
            base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    }

    function newSalt() {
        return crypto.getRandomValues(new Uint8Array(16));
    }

    async function encryptJSON(key, data) {
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const c = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(data)));
        return { iv: bytesToBase64(iv), ciphertext: bytesToBase64(c) };
    }

    /** Decrypted JSON, or null when the password is wrong or the data is damaged. */
    async function decryptJSON(key, { iv, ciphertext }) {
        try {
            const d = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: base64ToBytes(iv) }, key, base64ToBytes(ciphertext));
            return JSON.parse(new TextDecoder().decode(d));
        } catch (e) {
            return null;
        }
    }

    /** Opens an encrypted vault {salt, iv, ciphertext} with a password → {key, data} or null. */
    async function openVault(vault, password) {
        if (!vault || !vault.salt || !vault.iv || !vault.ciphertext) return null;
        const key = await deriveKey(password, base64ToBytes(vault.salt));
        const data = await decryptJSON(key, vault);
        return data && Array.isArray(data.accounts) ? { key, data } : null;
    }

    CN.vaultCrypto = { deriveKey, newSalt, encryptJSON, decryptJSON, openVault, ITERATIONS, MIN_PASSWORD_LENGTH };
})(typeof globalThis !== 'undefined' ? globalThis : this);
