/* ChronoNumbers – TOTP codes (RFC 6238 / RFC 4226) with WebCrypto. Copyright (C) 2026 anderlejan. GPL-3.0-or-later. */
(function (root) {
    'use strict';
    const CN = root.CN = root.CN || {};

    const ALGOS = { SHA1: 'SHA-1', SHA256: 'SHA-256', SHA512: 'SHA-512' };
    const keyCache = new Map(); // "ALGO:secret" → CryptoKey (importKey once per account, not every second)

    function normalizeAlgo(algo) {
        const a = String(algo || 'SHA1').toUpperCase().replace(/[^A-Z0-9]/g, '');
        if (!ALGOS[a]) throw new Error('Unsupported algorithm: ' + algo);
        return a;
    }

    async function hmacKey(secret, algo) {
        const id = algo + ':' + secret;
        let key = keyCache.get(id);
        if (!key) {
            const raw = CN.encoding.base32ToBytes(secret);
            if (raw.length === 0) throw new Error('Empty secret key');
            key = await crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: { name: ALGOS[algo] } }, false, ['sign']);
            if (keyCache.size > 500) keyCache.clear();
            keyCache.set(id, key);
        }
        return key;
    }

    /** RFC 4226 HOTP value for an integer counter. */
    async function hotp(secret, counter, algo = 'SHA1', digits = 6) {
        const a = normalizeAlgo(algo);
        const msg = new ArrayBuffer(8);
        const view = new DataView(msg);
        view.setUint32(0, Math.floor(counter / 0x100000000), false);
        view.setUint32(4, counter >>> 0, false);
        const h = new Uint8Array(await crypto.subtle.sign('HMAC', await hmacKey(CN.encoding.normalizeBase32(secret), a), msg));
        const o = h[h.length - 1] & 15;
        const bin = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
        return String(bin % 10 ** digits).padStart(digits, '0');
    }

    function counterAt(period, timeMs = Date.now()) {
        return Math.floor(timeMs / 1000 / period);
    }

    /** The TOTP code of an account's `info` ({secret, algo, digits, period}) at a time (ms). */
    function totp(info, timeMs = Date.now()) {
        const period = info.period || 30;
        return hotp(info.secret, counterAt(period, timeMs), info.algo || 'SHA1', info.digits || 6);
    }

    CN.totp = { totp, hotp, counterAt, normalizeAlgo, ALGOS: Object.keys(ALGOS) };
})(typeof globalThis !== 'undefined' ? globalThis : this);
