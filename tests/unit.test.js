#!/usr/bin/env node
/* Unit tests for the ChronoNumbers logic (no browser needed): node tests/unit.test.js */
'use strict';
const path = require('path');
const assert = require('assert');

for (const f of ['version', 'encoding', 'totp', 'vaultcrypto', 'accounts', 'vault'])
    require(path.join(__dirname, '..', 'assets', 'js', f + '.js'));
const CN = globalThis.CN;

let passed = 0, failed = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

// ---------- encoding ----------
test('base32 decode/encode round trip and RFC 4648 vectors', () => {
    const vec = { '': '', f: 'MY', fo: 'MZXQ', foo: 'MZXW6', foob: 'MZXW6YQ', fooba: 'MZXW6YTB', foobar: 'MZXW6YTBOI' };
    for (const [plain, b32] of Object.entries(vec)) {
        assert.strictEqual(Buffer.from(CN.encoding.base32ToBytes(b32)).toString(), plain);
        assert.strictEqual(CN.encoding.bytesToBase32(Buffer.from(plain)), b32);
    }
});
test('base32 accepts lower case, spaces, dashes and padding; rejects other characters', () => {
    assert.strictEqual(CN.encoding.normalizeBase32(' mzxw 6ytb-oi== '), 'MZXW6YTBOI');
    assert.ok(CN.encoding.isValidBase32('jbsw y3dp ehpk 3pxp'));
    assert.ok(!CN.encoding.isValidBase32('JBSW1Y3DP'));
    assert.ok(!CN.encoding.isValidBase32(''));
    assert.throws(() => CN.encoding.base32ToBytes('ABC!'), /Invalid character/);
});
test('base64 round trip of large buffers', () => {
    const b = new Uint8Array(200000).map((_, i) => i * 7);
    assert.deepStrictEqual(CN.encoding.base64ToBytes(CN.encoding.bytesToBase64(b)), b);
});

// ---------- TOTP: RFC 6238 appendix B ----------
const RFC_SECRETS = {
    SHA1: CN.encoding.bytesToBase32(Buffer.from('12345678901234567890')),
    SHA256: CN.encoding.bytesToBase32(Buffer.from('12345678901234567890123456789012')),
    SHA512: CN.encoding.bytesToBase32(Buffer.from('1234567890123456789012345678901234567890123456789012345678901234')),
};
const RFC = [
    [59, '94287082', '46119246', '90693936'],
    [1111111109, '07081804', '68084774', '25091201'],
    [1111111111, '14050471', '67062674', '99943326'],
    [1234567890, '89005924', '91819424', '93441116'],
    [2000000000, '69279037', '90698825', '38618901'],
    [20000000000, '65353130', '77737706', '47863826'],
];
test('TOTP matches RFC 6238 test vectors (SHA1/256/512, 8 digits, incl. times past 2038)', async () => {
    for (const [t, s1, s256, s512] of RFC) {
        assert.strictEqual(await CN.totp.totp({ secret: RFC_SECRETS.SHA1, algo: 'SHA1', digits: 8, period: 30 }, t * 1000), s1);
        assert.strictEqual(await CN.totp.totp({ secret: RFC_SECRETS.SHA256, algo: 'SHA256', digits: 8, period: 30 }, t * 1000), s256);
        assert.strictEqual(await CN.totp.totp({ secret: RFC_SECRETS.SHA512, algo: 'SHA512', digits: 8, period: 30 }, t * 1000), s512);
    }
});
test('TOTP 6 digits = last 6 of the 8-digit value; algorithm names are tolerant', async () => {
    assert.strictEqual(await CN.totp.totp({ secret: RFC_SECRETS.SHA1, algo: 'sha-1', digits: 6, period: 30 }, 59000), '287082');
    assert.strictEqual(CN.totp.normalizeAlgo('sha256'), 'SHA256');
    assert.throws(() => CN.totp.normalizeAlgo('MD5'), /Unsupported/);
});
test('HOTP matches RFC 4226 appendix D', async () => {
    const want = ['755224', '287082', '359152', '969429', '338314', '254676', '287922', '162583', '399871', '520489'];
    for (let c = 0; c < want.length; c++) assert.strictEqual(await CN.totp.hotp(RFC_SECRETS.SHA1, c), want[c]);
});
test('TOTP of an invalid secret rejects (shown as "Error", never a wrong code)', async () => {
    await assert.rejects(CN.totp.totp({ secret: 'NOT-BASE32-!!', algo: 'SHA1', digits: 6, period: 30 }));
});

// ---------- accounts / otpauth ----------
test('otpauth parse: issuer from parameter wins, path issuer as fallback, name with colons', () => {
    let a = CN.accounts.fromOtpauth('otpauth://totp/ACME%20Co:john@example.com?secret=JBSWY3DPEHPK3PXP&issuer=ACME%20Co&algorithm=SHA256&digits=8&period=60');
    assert.strictEqual(a.issuer, 'ACME Co'); assert.strictEqual(a.name, 'john@example.com');
    assert.deepStrictEqual([a.info.algo, a.info.digits, a.info.period], ['SHA256', 8, 60]);
    a = CN.accounts.fromOtpauth('otpauth://totp/Example:alice:work?secret=jbswy3dpehpk3pxp');
    assert.strictEqual(a.issuer, 'Example'); assert.strictEqual(a.name, 'alice:work'); assert.strictEqual(a.info.secret, 'JBSWY3DPEHPK3PXP');
    a = CN.accounts.fromOtpauth('otpauth://totp/justname?secret=JBSWY3DPEHPK3PXP');
    assert.strictEqual(a.issuer, ''); assert.strictEqual(a.name, 'justname');
    assert.deepStrictEqual([a.info.algo, a.info.digits, a.info.period], ['SHA1', 6, 30]);
});
test('otpauth parse rejects HOTP, migration codes, missing or bad secrets, other links', () => {
    assert.throws(() => CN.accounts.fromOtpauth('otpauth://hotp/x?secret=JBSWY3DPEHPK3PXP&counter=1'), /TOTP/);
    assert.throws(() => CN.accounts.fromOtpauth('otpauth-migration://offline?data=abc'), /Google Authenticator/);
    assert.throws(() => CN.accounts.fromOtpauth('otpauth://totp/x?issuer=a'), /no secret/);
    assert.throws(() => CN.accounts.fromOtpauth('otpauth://totp/x?secret=0189'), /Base32/);
    assert.throws(() => CN.accounts.fromOtpauth('https://example.com'), /otpauth/);
    assert.throws(() => CN.accounts.fromOtpauth('hello'), /account link/);
});
test('otpauth build → parse keeps every field incl. group and note', () => {
    const a = CN.accounts.create({ issuer: 'Gröup & Co', name: 'me:you?', group: 'Work/Ops', note: 'line 1\nline&2=3',
        info: { secret: 'JBSWY3DPEHPK3PXP', algo: 'SHA512', digits: 7, period: 45 } });
    const b = CN.accounts.fromOtpauth(CN.accounts.toOtpauth(a));
    for (const k of ['issuer', 'name', 'group', 'note']) assert.strictEqual(b[k], a[k], k);
    assert.deepStrictEqual(b.info, a.info);
});
test('merge skips duplicates by secret (normalized), counts invalid ones, fixes uuid clashes', () => {
    const list = [CN.accounts.create({ issuer: 'A', info: { secret: 'JBSWY3DPEHPK3PXP' } })];
    const r = CN.accounts.merge(list, [
        { uuid: list[0].uuid, issuer: 'B', info: { secret: 'MZXW6YTBOI' } },
        { issuer: 'dup', info: { secret: 'jbsw y3dp ehpk 3pxp' } },
        { issuer: 'bad', info: { secret: '1111' } },
    ]);
    assert.deepStrictEqual(r, { added: 1, skipped: 1, invalid: 1 });
    assert.strictEqual(list.length, 2);
    assert.notStrictEqual(list[1].uuid, list[0].uuid);
});

// ---------- Aegis ----------
const AEGIS_V3 = {
    version: 1, header: { slots: null, params: null },
    db: { version: 3, groups: [{ uuid: 'g1', name: 'Personal' }], entries: [
        { type: 'totp', uuid: 'u1', name: 'a@b.c', issuer: 'Mail', note: 'n', icon: null, favorite: true, groups: ['g1'],
            info: { secret: 'JBSWY3DPEHPK3PXP', algo: 'SHA1', digits: 6, period: 30 } },
        { type: 'hotp', uuid: 'u2', name: 'x', issuer: 'H', info: { secret: 'MZXW6YTBOI', algo: 'SHA1', digits: 6, counter: 3 } },
        { type: 'steam', uuid: 'u3', name: 'y', issuer: 'Steam', info: { secret: 'MZXW6YQ', algo: 'SHA1', digits: 5, period: 30 } },
    ] },
};
test('Aegis import: TOTP only, db v3 groups resolved to names', () => {
    const { accounts, ignored } = CN.accounts.fromAegis(JSON.stringify(AEGIS_V3));
    assert.strictEqual(accounts.length, 1); assert.strictEqual(ignored, 2);
    assert.strictEqual(accounts[0].group, 'Personal'); assert.strictEqual(accounts[0].favorite, true);
});
test('Aegis import refuses encrypted exports with a clear message', () => {
    assert.throws(() => CN.accounts.fromAegis({ version: 1, header: { slots: [{}] }, db: 'base64…' }), /encrypted/);
    assert.throws(() => CN.accounts.fromAegis('{nope'), /valid JSON/);
    assert.throws(() => CN.accounts.fromAegis('{}'), /db.entries/);
});
test('export → import round trip (Aegis format), also of exports made by ChronoNumbers 1.6.1', () => {
    const list = [CN.accounts.create({ issuer: 'I', name: 'N', group: 'G', note: 'note', info: { secret: 'JBSWY3DPEHPK3PXP', algo: 'SHA256', digits: 8, period: 60 } })];
    const exported = CN.accounts.toAegis(list);
    assert.strictEqual(exported.db.entries[0].type, 'totp');
    const back = CN.accounts.fromAegis(JSON.stringify(exported)).accounts;
    const target = [];
    assert.deepStrictEqual(CN.accounts.merge(target, back), { added: 1, skipped: 0, invalid: 0 });
    for (const k of ['uuid', 'issuer', 'name', 'group', 'note']) assert.strictEqual(target[0][k], list[0][k]);
    assert.deepStrictEqual(target[0].info, list[0].info);
    // 1.6.1 wrote {version:1, db:{header:{unlocked:false}, entries:<its own accounts without "type">}}
    const old = { version: 1, db: { header: { unlocked: false }, entries: [{ uuid: 'x', issuer: 'Old', name: '', group: null, note: '', favorite: false, thumbnail: null, info: { secret: 'MZXW6YTBOI', algo: 'SHA1', digits: 6, period: 30 } }] } };
    assert.strictEqual(CN.accounts.fromAegis(JSON.stringify(old)).accounts.length, 1);
});

// ---------- vault file format and encryption ----------
test('settings are cleaned: types fixed, ranges clamped, defaults filled, unknown keys kept', () => {
    const s = CN.vault.cleanSettings({ fontSize: '30', layout: 'weird', maskCodes: 'yes', future: 1 });
    assert.strictEqual(s.fontSize, 24); assert.strictEqual(s.layout, 'list'); assert.strictEqual(s.maskCodes, true); assert.strictEqual(s.future, 1);
    assert.strictEqual(CN.vault.cleanSettings({ fontSize: '12' }).fontSize, 12);
});
test('parse: first start (no file), plain vault, encrypted vault', () => {
    assert.deepStrictEqual(CN.vault.parse(null).accounts, []);
    const plain = CN.vault.parse({ settings: { layout: 'grid' }, accounts: [{ uuid: '1' }], vault: null });
    assert.strictEqual(plain.settings.layout, 'grid'); assert.strictEqual(plain.accounts.length, 1); assert.strictEqual(plain.encrypted, null);
    const enc = CN.vault.parse({ settings: { passwordEnabled: false }, vault: { salt: 's', iv: 'i', ciphertext: 'c' } });
    assert.strictEqual(enc.accounts, null); assert.ok(enc.encrypted); assert.strictEqual(enc.settings.passwordEnabled, true);
    assert.strictEqual(CN.vault.parse({ settings: { passwordEnabled: true }, accounts: [] }).settings.passwordEnabled, false);
});
test('encrypted serialize → open round trip; wrong password → null', async () => {
    const salt = CN.vaultCrypto.newSalt();
    const key = await CN.vaultCrypto.deriveKey('correct horse', salt);
    const accounts = [CN.accounts.create({ issuer: 'X', info: { secret: 'JBSWY3DPEHPK3PXP' } })];
    const doc = await CN.vault.serialize({ settings: CN.vault.cleanSettings({ passwordEnabled: true }), accounts, key, salt: CN.encoding.bytesToBase64(salt) });
    assert.ok(!('accounts' in doc));
    assert.ok(!JSON.stringify(doc).includes('JBSWY3DPEHPK3PXP'));
    const opened = await CN.vaultCrypto.openVault(doc.vault, 'correct horse');
    assert.deepStrictEqual(opened.data.accounts, accounts);
    assert.strictEqual(await CN.vaultCrypto.openVault(doc.vault, 'wrong'), null);
    await assert.rejects(CN.vault.serialize({ settings: { passwordEnabled: true }, accounts }), /locked/);
});
test('a vault encrypted by ChronoNumbers 1.6.1 opens unchanged (same KDF and cipher)', async () => {
    // the 1.6.1 code, verbatim in function (minified there): PBKDF2 250000 SHA-256 → AES-GCM 256, btoa of the bytes
    const b2a = b => btoa(String.fromCharCode(...new Uint8Array(b)));
    const s = crypto.getRandomValues(new Uint8Array(16));
    const k0 = await crypto.subtle.importKey('raw', new TextEncoder().encode('old password!'), { name: 'PBKDF2' }, false, ['deriveKey']);
    const k = await crypto.subtle.deriveKey({ name: 'PBKDF2', salt: s, iterations: 25e4, hash: 'SHA-256' }, k0, { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const accounts = [{ uuid: 'u', issuer: 'Legacy', name: 'n', group: null, note: '', favorite: false, thumbnail: null, info: { secret: 'JBSWY3DPEHPK3PXP', algo: 'SHA1', digits: 6, period: 30 } }];
    const c = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, k, new TextEncoder().encode(JSON.stringify({ accounts })));
    const legacyDoc = { settings: { fontSize: 16, layout: 'list', passwordEnabled: true, showIssuer: true, showName: true, showActions: true, maskCodes: true }, vault: { salt: b2a(s), iv: b2a(iv), ciphertext: b2a(c) } };
    const parsed = CN.vault.parse(JSON.parse(JSON.stringify(legacyDoc)));
    const opened = await CN.vaultCrypto.openVault(parsed.encrypted, 'old password!');
    assert.deepStrictEqual(opened.data.accounts, accounts);
});

(async () => {
    for (const [name, fn] of tests) {
        try { await fn(); passed++; console.log('  ok   ' + name); }
        catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e && e.stack || e)); }
    }
    console.log(`${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
})();
