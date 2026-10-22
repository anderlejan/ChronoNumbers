/* ChronoNumbers – the account model, otpauth:// URIs and Aegis import/export.
 * Account: {uuid, issuer, name, group, note, favorite, thumbnail, info: {secret, algo, digits, period}}
 * (Aegis entries imported earlier may carry more Aegis fields, e.g. icon; they are kept as they are.)
 * Copyright (C) 2026 anderlejan. GPL-3.0-or-later. */
(function (root) {
    'use strict';
    const CN = root.CN = root.CN || {};
    const { normalizeBase32, isValidBase32 } = CN.encoding;

    const DIGITS_MIN = 6, DIGITS_MAX = 8, PERIOD_MIN = 1, PERIOD_MAX = 3600;

    function uuid() {
        if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
        const b = crypto.getRandomValues(new Uint8Array(16));
        b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
        const h = [...b].map(x => x.toString(16).padStart(2, '0')).join('');
        return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
    }

    function intIn(v, min, max, def) {
        const n = parseInt(v, 10);
        return Number.isFinite(n) && n >= min && n <= max ? n : def;
    }

    function str(v) {
        return v == null ? '' : String(v);
    }

    /** A clean copy of an account; throws when the secret is not usable. Unknown fields are kept. */
    function normalize(a) {
        const info = a.info || {};
        const secret = normalizeBase32(info.secret);
        if (!isValidBase32(secret)) throw new Error('The secret key is not valid Base32 (letters A–Z and digits 2–7).');
        return {
            ...a,
            uuid: a.uuid ? String(a.uuid) : uuid(),
            issuer: str(a.issuer).trim(),
            name: str(a.name).trim(),
            group: a.group ? String(a.group).trim() || null : null,
            note: str(a.note),
            favorite: !!a.favorite,
            thumbnail: a.thumbnail == null ? null : a.thumbnail,
            info: {
                ...info,
                secret,
                algo: CN.totp.normalizeAlgo(info.algo),
                digits: intIn(info.digits, DIGITS_MIN, DIGITS_MAX, 6),
                period: intIn(info.period, PERIOD_MIN, PERIOD_MAX, 30),
            },
        };
    }

    function create(fields) {
        return normalize({ uuid: uuid(), issuer: '', name: '', group: null, note: '', favorite: false, thumbnail: null, ...fields,
            info: { secret: '', algo: 'SHA1', digits: 6, period: 30, ...(fields.info || {}) } });
    }

    function sameSecret(a, b) {
        return normalizeBase32(a.info && a.info.secret) === normalizeBase32(b.info && b.info.secret);
    }

    /** Adds accounts that are not there yet (same secret = duplicate) → {added, skipped, invalid}. */
    function merge(list, incoming) {
        let added = 0, skipped = 0, invalid = 0;
        for (const raw of incoming) {
            let a;
            try { a = normalize(raw); } catch (e) { invalid++; continue; }
            if (list.some(c => sameSecret(c, a))) { skipped++; continue; }
            if (list.some(c => c.uuid === a.uuid)) a.uuid = uuid();
            list.push(a);
            added++;
        }
        return { added, skipped, invalid };
    }

    function label(a) {
        return a.issuer ? `${a.issuer} (${a.name || ''})` : (a.name || 'Account');
    }

    // ---- otpauth:// (Google Authenticator key URI format) ----

    /** otpauth://totp/Issuer:Name?secret=…&issuer=…&algorithm=…&digits=…&period=… → a new account.
     *  ChronoNumbers also writes &group= and &note= so its own QR codes keep those. */
    function fromOtpauth(text) {
        let u;
        try { u = new URL(String(text).trim()); } catch (e) { throw new Error('This QR code does not contain an account link.'); }
        if (u.protocol === 'otpauth-migration:')
            throw new Error('This is a Google Authenticator export code. Export the accounts one by one (or via Aegis) instead.');
        if (u.protocol !== 'otpauth:') throw new Error('This QR code does not contain an otpauth:// account link.');
        // new URL('otpauth://totp/x') puts "totp" in host (or in pathname for some engines)
        let type = u.host, path = u.pathname;
        if (!type) { const m = path.match(/^\/*([^/]+)\/?(.*)$/); type = m ? m[1] : ''; path = m ? m[2] : ''; }
        if (type.toLowerCase() !== 'totp') throw new Error('Only time-based (TOTP) accounts are supported, this one is "' + type + '".');
        path = decodeURIComponent(path.replace(/^\/+/, ''));
        const colon = path.indexOf(':');
        const pathIssuer = colon >= 0 ? path.slice(0, colon).trim() : '';
        const name = (colon >= 0 ? path.slice(colon + 1) : path).trim();
        const p = u.searchParams;
        const secret = p.get('secret');
        if (!secret) throw new Error('The account link has no secret key.');
        return create({
            issuer: p.get('issuer') || pathIssuer,
            name,
            group: p.get('group') || null,
            note: p.get('note') || '',
            info: { secret, algo: p.get('algorithm') || 'SHA1', digits: p.get('digits') || 6, period: p.get('period') || 30 },
        });
    }

    function toOtpauth(a) {
        const i = a.info;
        const lbl = a.issuer ? `${a.issuer}:${a.name || ''}` : (a.name || 'ChronoNumbers');
        let r = `otpauth://totp/${encodeURIComponent(lbl)}?secret=${encodeURIComponent(i.secret)}` +
            `&issuer=${encodeURIComponent(a.issuer || '')}&algorithm=${i.algo}&digits=${i.digits}&period=${i.period}`;
        if (a.group) r += `&group=${encodeURIComponent(a.group)}`;
        if (a.note) r += `&note=${encodeURIComponent(a.note)}`;
        return r;
    }

    // ---- Aegis (https://getaegis.app) plain-text vault export ----

    /** Accounts from an UNENCRYPTED Aegis export (db version 1–3), or from ChronoNumbers' own exports. */
    function fromAegis(jsonText) {
        let v;
        try { v = typeof jsonText === 'string' ? JSON.parse(jsonText) : jsonText; } catch (e) { throw new Error('This is not valid JSON.'); }
        if (!v || typeof v !== 'object') throw new Error('Invalid format');
        if (typeof v.db === 'string')
            throw new Error('This Aegis export is encrypted. In Aegis choose Export → without encryption, then paste that.');
        if (!v.db || !Array.isArray(v.db.entries)) throw new Error('Invalid format: no db.entries list found.');
        const groupNames = new Map((Array.isArray(v.db.groups) ? v.db.groups : []).map(g => [g.uuid, g.name]));
        const out = [];
        let ignored = 0;
        for (const e of v.db.entries) {
            // ChronoNumbers ≤ 1.6.1 exported its own accounts without "type"
            const isTotp = e && e.info && e.info.secret && (e.type == null || String(e.type).toLowerCase() === 'totp');
            if (!isTotp) { ignored++; continue; }
            let group = e.group || null;
            if (!group && Array.isArray(e.groups) && e.groups.length) group = groupNames.get(e.groups[0]) || null;
            const a = { ...e, group, info: { ...e.info } };
            delete a.groups;
            out.push(a);
        }
        return { accounts: out, ignored };
    }

    /** An unencrypted export in Aegis' own format (db version 2), which Aegis and ChronoNumbers can import. */
    function toAegis(accounts) {
        const entries = accounts.map(a => {
            const e = { type: 'totp', uuid: a.uuid, name: a.name || '', issuer: a.issuer || '', note: a.note || '',
                favorite: !!a.favorite, icon: a.icon == null ? null : a.icon,
                info: { secret: a.info.secret, algo: a.info.algo, digits: a.info.digits, period: a.info.period } };
            if (a.icon_mime) e.icon_mime = a.icon_mime;
            e.group = a.group || null;
            return e;
        });
        return { version: 1, header: { slots: null, params: null }, db: { version: 2, entries } };
    }

    CN.accounts = { uuid, normalize, create, merge, sameSecret, label, fromOtpauth, toOtpauth, fromAegis, toAegis,
        DIGITS_MIN, DIGITS_MAX, PERIOD_MIN, PERIOD_MAX };
})(typeof globalThis !== 'undefined' ? globalThis : this);
