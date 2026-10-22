/* ChronoNumbers – the stored vault document (file format unchanged since 1.x).
 *   without master password: {settings, accounts: [...], vault: null}
 *   with master password:    {settings, vault: {salt, iv, ciphertext}}   (ciphertext = AES-GCM of {accounts: [...]})
 * Copyright (C) 2026 anderlejan. GPL-3.0-or-later. */
(function (root) {
    'use strict';
    const CN = root.CN = root.CN || {};

    const DEFAULT_SETTINGS = Object.freeze({
        fontSize: 16, layout: 'list', passwordEnabled: false,
        showIssuer: true, showName: true, showActions: true, maskCodes: true,
    });
    const FONT_MIN = 10, FONT_MAX = 24;

    function bool(v, def) {
        return typeof v === 'boolean' ? v : def;
    }

    /** Settings with every key present and valid; unknown keys are kept for newer versions. */
    function cleanSettings(s) {
        s = s && typeof s === 'object' ? s : {};
        const d = DEFAULT_SETTINGS;
        const font = parseInt(s.fontSize, 10);
        return {
            ...s,
            fontSize: Number.isFinite(font) ? Math.min(FONT_MAX, Math.max(FONT_MIN, font)) : d.fontSize,
            layout: s.layout === 'grid' ? 'grid' : 'list',
            passwordEnabled: bool(s.passwordEnabled, d.passwordEnabled),
            showIssuer: bool(s.showIssuer, d.showIssuer),
            showName: bool(s.showName, d.showName),
            showActions: bool(s.showActions, d.showActions),
            maskCodes: bool(s.maskCodes, d.maskCodes),
        };
    }

    function isEncryptedVault(v) {
        return !!(v && typeof v === 'object' && v.salt && v.iv && v.ciphertext);
    }

    /** Stored document → {settings, accounts (null while locked), encrypted (the {salt,iv,ciphertext} or null)}. */
    function parse(doc) {
        if (!doc) return { settings: cleanSettings(null), accounts: [], encrypted: null };
        if (typeof doc !== 'object') throw new Error('The vault file has an unknown format.');
        const settings = cleanSettings(doc.settings);
        if (isEncryptedVault(doc.vault)) {
            settings.passwordEnabled = true;
            return { settings, accounts: null, encrypted: { salt: doc.vault.salt, iv: doc.vault.iv, ciphertext: doc.vault.ciphertext } };
        }
        settings.passwordEnabled = false;
        return { settings, accounts: Array.isArray(doc.accounts) ? doc.accounts : [], encrypted: null };
    }

    /** The document to store. `key` + `salt` (Base64) when a master password is set. */
    async function serialize({ settings, accounts, key, salt }) {
        if (settings.passwordEnabled) {
            if (!key || !salt) throw new Error('Internal error: the vault is locked, it cannot be saved.');
            const { iv, ciphertext } = await CN.vaultCrypto.encryptJSON(key, { accounts });
            return { settings, vault: { salt, iv, ciphertext } };
        }
        return { settings, accounts, vault: null };
    }

    CN.vault = { DEFAULT_SETTINGS, FONT_MIN, FONT_MAX, cleanSettings, isEncryptedVault, parse, serialize };
})(typeof globalThis !== 'undefined' ? globalThis : this);
