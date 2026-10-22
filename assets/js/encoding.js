/* ChronoNumbers – byte/text encodings (Base64, Base32). Copyright (C) 2026 anderlejan. GPL-3.0-or-later. */
(function (root) {
    'use strict';
    const CN = root.CN = root.CN || {};

    const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

    /** Bytes (ArrayBuffer or Uint8Array) → Base64. Works for any size (no spread of huge arrays). */
    function bytesToBase64(buf) {
        const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
        let s = '';
        for (let i = 0; i < bytes.length; i += 0x8000)
            s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
        return btoa(s);
    }

    function base64ToBytes(b64) {
        const s = atob(String(b64));
        const out = new Uint8Array(s.length);
        for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
        return out;
    }

    /** Removes what people paste around a Base32 secret: spaces, dashes, padding; upper-cases it. */
    function normalizeBase32(secret) {
        return String(secret == null ? '' : secret).replace(/[\s-]/g, '').replace(/=+$/, '').toUpperCase();
    }

    function isValidBase32(secret) {
        const s = normalizeBase32(secret);
        return s.length > 0 && /^[A-Z2-7]+$/.test(s);
    }

    /** Base32 (RFC 4648) → bytes. Throws on characters outside the alphabet. */
    function base32ToBytes(secret) {
        const s = normalizeBase32(secret);
        const out = [];
        let bits = 0, value = 0;
        for (const ch of s) {
            const v = B32.indexOf(ch);
            if (v < 0) throw new Error('Invalid character in secret key: "' + ch + '"');
            value = (value << 5) | v;
            bits += 5;
            if (bits >= 8) {
                out.push((value >>> (bits - 8)) & 0xff);
                bits -= 8;
            }
        }
        return new Uint8Array(out);
    }

    function bytesToBase32(bytes) {
        let out = '', bits = 0, value = 0;
        for (const b of bytes) {
            value = (value << 8) | b;
            bits += 8;
            while (bits >= 5) {
                out += B32[(value >>> (bits - 5)) & 31];
                bits -= 5;
            }
        }
        if (bits > 0) out += B32[(value << (5 - bits)) & 31];
        return out;
    }

    CN.encoding = { bytesToBase64, base64ToBytes, normalizeBase32, isValidBase32, base32ToBytes, bytesToBase32 };
})(typeof globalThis !== 'undefined' ? globalThis : this);
