/* ChronoNumbers – the user interface. Copyright (C) 2026 anderlejan. GPL-3.0-or-later. */
(function (root) {
    'use strict';
    const CN = root.CN = root.CN || {};
    const { accounts: Acc, vault: Vault, vaultCrypto: VC, store: Store, encoding: Enc } = CN;

    const $ = id => document.getElementById(id);
    const COPIED = 'Copied!';
    const COPIED_MS = 800;

    const state = {
        ready: false,        // vault loaded (and unlocked) → saving allowed
        settings: Vault.cleanSettings(null),
        accounts: null,      // null until loaded, and while locked
        encrypted: null,     // the stored {salt, iv, ciphertext} until it is unlocked
        key: null,           // AES key from the master password (memory only)
        salt: null,          // Base64 salt of that key
        verifier: null,      // something encrypted with `key`, to check "current password"
    };
    // per account: {counter, code, token} – codes are recomputed only when their time step changes
    const codeCache = new Map();
    const copiedUntil = new Map();
    let ticker = null;

    const ui = {};
    function bindUi() {
        for (const id of ['app-container', 'codes-container', 'settings-toggle', 'settings-panel', 'settings-close',
            'font-size-slider', 'add-account-btn', 'add-account-modal', 'cancel-add-account', 'save-manual-account',
            'manual-issuer', 'manual-secret', 'add-error', 'import-aegis-btn', 'aegis-import-modal', 'cancel-aegis-import',
            'confirm-aegis-import', 'aegis-json-input', 'aegis-error', 'password-enabled-checkbox', 'change-password-btn',
            'delete-all-btn', 'cancel-password-change', 'export-vault-btn', 'export-vault-modal', 'export-unencrypted-btn',
            'export-encrypted-btn', 'export-data-textarea', 'copy-export-btn', 'close-export-btn', 'scan-qr-button',
            'qr-file-input', 'edit-account-modal', 'edit-issuer', 'edit-name', 'edit-group', 'edit-secret', 'edit-uuid',
            'edit-note', 'edit-digits', 'edit-period', 'edit-algo', 'edit-error', 'cancel-edit-account',
            'update-edit-account', 'login-modal', 'login-title', 'login-prompt', 'password-input-old', 'password-input',
            'password-confirm', 'password-error', 'login-button', 'search-bar', 'show-issuer-check', 'show-name-check',
            'show-actions-check', 'mask-codes-check', 'footer-version', 'show-qr-modal', 'show-qr-canvas', 'show-qr-label',
            'close-qr-modal-btn', 'import-encrypted-vault-btn', 'encrypted-import-modal', 'encrypted-vault-input',
            'import-password', 'import-error', 'cancel-encrypted-import', 'confirm-encrypted-import', 'toast',
            'save-status', 'load-error', 'load-error-text', 'load-retry-btn']) {
            ui[id.replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = $(id);
        }
        ui.layoutButtons = document.querySelectorAll('.layout-btn');
        ui.headerTitle = document.querySelector('.header-main h1');
    }

    // ---------- small helpers ----------
    const show = (el, on = true) => el.classList.toggle('hidden', !on);
    const hide = el => el.classList.add('hidden');

    function setError(el, msg) {
        el.textContent = msg || '';
        show(el, !!msg);
    }

    let toastTimer = null;
    function toast(msg, { sticky = false, onClick = null } = {}) {
        clearTimeout(toastTimer);
        ui.toast.textContent = msg;
        ui.toast.onclick = () => { hide(ui.toast); if (onClick) onClick(); };
        show(ui.toast);
        if (!sticky) toastTimer = setTimeout(() => hide(ui.toast), 4000);
    }

    async function copyText(text) {
        try {
            if (navigator.clipboard && navigator.clipboard.writeText) {
                await navigator.clipboard.writeText(text);
                return true;
            }
        } catch (e) { /* not allowed in this frame – fall back */ }
        const t = document.createElement('textarea');
        t.value = text;
        t.setAttribute('readonly', '');
        t.style.position = 'fixed';
        t.style.top = '-9999px';
        document.body.appendChild(t);
        t.select();
        try { return document.execCommand('copy'); } catch (e) { return false; } finally { t.remove(); }
    }

    function openModal(modal) {
        show(modal);
        const first = modal.querySelector('input:not([type=hidden]):not(.hidden), textarea, button');
        if (first) setTimeout(() => first.focus(), 0);
    }

    function resetSecretToggles(scope) {
        scope.querySelectorAll('.secret-input-wrapper input').forEach(i => { i.type = 'password'; });
        scope.querySelectorAll('.toggle-password').forEach(b => { b.textContent = '👁️'; });
    }

    // ---------- saving ----------
    function save() {
        if (!state.ready || state.accounts == null) return Promise.resolve();
        return Store.save(async () => {
            const doc = await Vault.serialize({ settings: state.settings, accounts: state.accounts, key: state.key, salt: state.salt });
            if (doc.vault) state.encrypted = doc.vault;
            return doc;
        }).catch(e => {
            console.error('ChronoNumbers save error:', e);
            toast('Could not save to Peergos: ' + e.message + ' – click to try again.', { sticky: true, onClick: save });
        });
    }

    function onSaveStatus(status) {
        ui.saveStatus.textContent = status === 'saving' ? 'Saving…' : status === 'saved' ? 'Saved' : status === 'error' ? 'Not saved' : '';
        if (status === 'saved' && ui.toast.textContent.startsWith('Could not save')) hide(ui.toast);
    }

    // ---------- settings ----------
    function applyDisplaySettings() {
        const s = state.settings, c = ui.codesContainer;
        c.classList.toggle('hide-issuer', !s.showIssuer);
        c.classList.toggle('hide-name', !s.showName);
        c.classList.toggle('hide-actions', !s.showActions);
        ui.showIssuerCheck.checked = s.showIssuer;
        ui.showNameCheck.checked = s.showName;
        ui.showActionsCheck.checked = s.showActions;
        ui.maskCodesCheck.checked = s.maskCodes;
    }

    function applySettings() {
        const s = state.settings;
        ui.codesContainer.style.fontSize = `${s.fontSize}px`;
        ui.fontSizeSlider.value = s.fontSize;
        ui.headerTitle.style.fontSize = `${Math.min(1.3 * s.fontSize / 16, 1.8)}em`;
        ui.codesContainer.classList.toggle('grid', s.layout === 'grid');
        ui.codesContainer.classList.toggle('list', s.layout !== 'grid');
        ui.layoutButtons.forEach(b => b.classList.toggle('active', b.dataset.layout === s.layout));
        ui.passwordEnabledCheckbox.checked = s.passwordEnabled;
        show(ui.changePasswordBtn, s.passwordEnabled);
        applyDisplaySettings();
    }

    // ---------- the code list ----------
    function isUnknownIssuer(issuer) {
        return !issuer || String(issuer).toLowerCase() === 'unknown';
    }

    function el(tag, cls, text) {
        const e = document.createElement(tag);
        if (cls) e.className = cls;
        if (text != null) e.textContent = text;
        return e;
    }

    function renderCodes() {
        const c = ui.codesContainer;
        c.replaceChildren();
        if (!state.accounts) return;
        if (state.accounts.length === 0) {
            const p = el('div', 'code-item-placeholder');
            p.appendChild(el('p', null, 'Add your first account.'));
            c.appendChild(p);
            return;
        }
        for (const a of state.accounts) {
            const item = el('div', 'code-item');
            item.dataset.uuid = a.uuid;
            const actions = el('div', 'item-actions');
            for (const [cls, title, icon] of [['qr-btn', 'Show QR Code', '◪'], ['edit-btn', 'Edit', '✏️'], ['delete-btn', 'Delete', '🗑️']]) {
                const b = el('button', cls, icon);
                b.type = 'button';
                b.title = title;
                b.setAttribute('aria-label', title);
                actions.appendChild(b);
            }
            const info = el('div', 'issuer-info');
            const issuer = el('div', 'issuer' + (isUnknownIssuer(a.issuer) ? ' hidden' : ''), a.issuer || '');
            info.append(issuer, el('div', 'name', a.name || ''));
            const code = el('div', 'code', '------');
            code.title = 'Click to copy';
            const bar = el('div', 'progress-bar');
            bar.appendChild(el('div', 'progress-bar-inner'));
            item.append(actions, info, code, bar);
            c.appendChild(item);
        }
        applyDisplaySettings();
        filterCodes();
        updateCodes(true);
    }

    function accountInfo(a) {
        const i = a.info || {};
        return { secret: i.secret, algo: i.algo || 'SHA1', digits: parseInt(i.digits, 10) || 6, period: parseInt(i.period, 10) || 30 };
    }

    function showCode(item, a) {
        const codeEl = item.querySelector('.code');
        const entry = codeCache.get(a.uuid);
        if ((copiedUntil.get(a.uuid) || 0) > Date.now()) {
            codeEl.textContent = COPIED;
            return;
        }
        if (!entry || entry.code == null) { codeEl.textContent = entry && entry.pendingSince ? '......' : '------'; return; }
        if (entry.error) { codeEl.textContent = 'Error'; codeEl.title = entry.error; return; }
        codeEl.textContent = state.settings.maskCodes ? '*'.repeat(accountInfo(a).digits) : entry.code;
    }

    /** Refreshes progress bars every second and recomputes codes whose time step changed. */
    function updateCodes(force = false) {
        if (!state.accounts) return;
        const now = Date.now();
        for (const a of state.accounts) {
            const item = ui.codesContainer.querySelector(`.code-item[data-uuid="${CSS.escape(a.uuid)}"]`);
            if (!item) continue;
            const info = accountInfo(a);
            const counter = Math.floor(now / 1000 / info.period);
            const elapsed = (now / 1000) % info.period;
            item.querySelector('.progress-bar-inner').style.width = `${(elapsed / info.period) * 100}%`;
            let entry = codeCache.get(a.uuid);
            const fingerprint = `${info.secret}|${info.algo}|${info.digits}|${info.period}`;
            if (force || !entry || entry.counter !== counter || entry.fingerprint !== fingerprint) {
                const token = {};
                entry = { counter, fingerprint, token, pendingSince: now,
                    code: !force && entry && entry.fingerprint === fingerprint && entry.counter === counter ? entry.code : null };
                codeCache.set(a.uuid, entry);
                CN.totp.totp(info, now).then(code => {
                    const e = codeCache.get(a.uuid);
                    if (!e || e.token !== token) return; // a newer computation started
                    e.code = code; e.error = null; e.pendingSince = 0;
                    const it = ui.codesContainer.querySelector(`.code-item[data-uuid="${CSS.escape(a.uuid)}"]`);
                    if (it) showCode(it, a);
                }, err => {
                    const e = codeCache.get(a.uuid);
                    if (!e || e.token !== token) return;
                    console.error('TOTP error:', err);
                    e.code = ''; e.error = err.message || String(err); e.pendingSince = 0;
                    const it = ui.codesContainer.querySelector(`.code-item[data-uuid="${CSS.escape(a.uuid)}"]`);
                    if (it) showCode(it, a);
                });
            }
            showCode(item, a);
        }
    }

    function filterCodes() {
        const t = ui.searchBar.value.trim().toLowerCase();
        ui.codesContainer.querySelectorAll('.code-item').forEach(item => {
            const s = (item.querySelector('.issuer')?.textContent || '').toLowerCase();
            const n = (item.querySelector('.name')?.textContent || '').toLowerCase();
            item.style.display = !t || s.includes(t) || n.includes(t) ? '' : 'none';
        });
    }

    function findAccount(uuid) {
        return state.accounts ? state.accounts.find(a => a.uuid === uuid) : null;
    }

    async function onCodeClick(item) {
        const a = findAccount(item.dataset.uuid);
        const entry = a && codeCache.get(a.uuid);
        if (!entry || !entry.code || entry.error) return;
        if ((copiedUntil.get(a.uuid) || 0) > Date.now()) return;
        if (await copyText(entry.code)) {
            copiedUntil.set(a.uuid, Date.now() + COPIED_MS);
            showCode(item, a);
            setTimeout(() => showCode(item, a), COPIED_MS + 20);
        } else {
            alert('Copy failed.');
        }
    }

    // ---------- accounts ----------
    /** Adds one account; false (with a message) when it exists already. */
    function addAccount(a) {
        if (!state.accounts) return false;
        if (state.accounts.some(c => Acc.sameSecret(c, a))) {
            alert('Account already exists.');
            return false;
        }
        state.accounts.push(a);
        save();
        renderCodes();
        return true;
    }

    function handleDelete(uuid) {
        const a = findAccount(uuid);
        if (!a) return;
        if (!confirm(`Are you sure you want to delete "${Acc.label(a)}"?`)) return;
        state.accounts = state.accounts.filter(c => c.uuid !== uuid);
        codeCache.delete(uuid);
        save();
        renderCodes();
    }

    function handleEdit(uuid) {
        const a = findAccount(uuid);
        if (!a) return;
        const i = accountInfo(a);
        ui.editUuid.value = uuid;
        ui.editIssuer.value = a.issuer || '';
        ui.editName.value = a.name || '';
        ui.editGroup.value = a.group || '';
        ui.editSecret.value = i.secret || '';
        ui.editNote.value = a.note || '';
        ui.editDigits.value = i.digits;
        ui.editPeriod.value = i.period;
        ui.editAlgo.value = CN.totp.ALGOS.includes(String(i.algo).toUpperCase()) ? String(i.algo).toUpperCase() : 'SHA1';
        resetSecretToggles(ui.editAccountModal);
        setError(ui.editError, '');
        openModal(ui.editAccountModal);
    }

    function handleUpdate() {
        const a = findAccount(ui.editUuid.value);
        if (!a) return alert('Error: Account not found.');
        const secret = Enc.normalizeBase32(ui.editSecret.value);
        const digits = parseInt(ui.editDigits.value, 10), period = parseInt(ui.editPeriod.value, 10);
        if (!Enc.isValidBase32(secret)) return setError(ui.editError, 'The secret key is not valid Base32 (letters A–Z and digits 2–7).');
        if (!(digits >= Acc.DIGITS_MIN && digits <= Acc.DIGITS_MAX)) return setError(ui.editError, 'Digits must be 6, 7 or 8.');
        if (!(period >= Acc.PERIOD_MIN && period <= Acc.PERIOD_MAX)) return setError(ui.editError, 'The period must be between 1 and 3600 seconds.');
        if (secret !== Enc.normalizeBase32(a.info.secret) &&
            !confirm('WARNING: Changing the secret key will permanently break code generation unless the new key is correct. Are you absolutely sure?')) return;
        if (state.accounts.some(c => c !== a && Enc.normalizeBase32(c.info.secret) === secret))
            return setError(ui.editError, 'Another account already uses this secret key.');
        a.issuer = ui.editIssuer.value.trim();
        a.name = ui.editName.value.trim();
        a.group = ui.editGroup.value.trim() || null;
        a.note = ui.editNote.value.trim();
        a.info = { ...a.info, secret, digits, period, algo: ui.editAlgo.value };
        codeCache.delete(a.uuid);
        save();
        renderCodes();
        hide(ui.editAccountModal);
    }

    function handleShowQr(uuid) {
        const a = findAccount(uuid);
        if (!a) return;
        try {
            const canvas = CN.qr.toCanvas(Acc.toOtpauth(a));
            ui.showQrLabel.textContent = Acc.label(a);
            ui.showQrCanvas.replaceChildren(canvas);
            openModal(ui.showQrModal);
        } catch (e) {
            console.error(e);
            alert('Error rendering QR code: ' + e.message);
        }
    }

    function handleManualAdd() {
        const issuer = ui.manualIssuer.value.trim();
        const secret = ui.manualSecret.value;
        if (!issuer || !Enc.normalizeBase32(secret)) return setError(ui.addError, 'Issuer and Secret required.');
        let a;
        try {
            a = Acc.create({ issuer, info: { secret } });
        } catch (e) {
            return setError(ui.addError, e.message);
        }
        if (addAccount(a)) closeAddModal();
    }

    function closeAddModal() {
        hide(ui.addAccountModal);
        ui.manualIssuer.value = '';
        ui.manualSecret.value = '';
        setError(ui.addError, '');
    }

    async function handleQrFile(file) {
        setError(ui.addError, '');
        try {
            const text = await CN.qr.scanFile(file);
            if (!text) return setError(ui.addError, 'No QR code found in the selected image. Please try another image.');
            const a = Acc.fromOtpauth(text);
            if (addAccount(a)) closeAddModal();
        } catch (e) {
            console.error(e);
            setError(ui.addError, 'Invalid QR code: ' + e.message);
        }
    }

    // ---------- import / export ----------
    function handleAegisImport() {
        const text = ui.aegisJsonInput.value.trim();
        if (!text || !state.accounts) return;
        try {
            const { accounts } = Acc.fromAegis(text);
            const r = Acc.merge(state.accounts, accounts);
            save();
            renderCodes();
            hide(ui.aegisImportModal);
            ui.aegisJsonInput.value = '';
            alert(`Imported ${r.added} accounts. Skipped ${r.skipped} duplicates.` + (r.invalid ? ` ${r.invalid} entries had an invalid secret key.` : ''));
        } catch (e) {
            setError(ui.aegisError, 'Import failed: ' + e.message);
        }
    }

    async function handleEncryptedImport() {
        setError(ui.importError, '');
        const text = ui.encryptedVaultInput.value.trim();
        const password = ui.importPassword.value;
        if (!state.accounts) return;
        if (!text) return setError(ui.importError, 'Please paste vault data.');
        if (!password) return setError(ui.importError, 'Password is required.');
        ui.confirmEncryptedImport.disabled = true;
        try {
            let doc;
            try { doc = JSON.parse(text); } catch (e) { throw new Error('This is not valid JSON.'); }
            if (!doc || !Vault.isEncryptedVault(doc.vault))
                throw new Error('Invalid encrypted vault format. Missing required fields (salt, iv, ciphertext).');
            const opened = await VC.openVault(doc.vault, password);
            if (!opened) throw new Error('Decryption failed. Incorrect password or corrupted vault.');
            const r = Acc.merge(state.accounts, opened.data.accounts);
            if (doc.settings && confirm('Import settings from vault? (Font size, layout, display options)\n\nClick OK to import settings, Cancel to keep current settings.')) {
                // never the password switch: it belongs to THIS vault and its key
                const { passwordEnabled, ...rest } = doc.settings;
                state.settings = Vault.cleanSettings({ ...state.settings, ...rest, passwordEnabled: state.settings.passwordEnabled });
                applySettings();
            }
            await save();
            renderCodes();
            hide(ui.encryptedImportModal);
            ui.encryptedVaultInput.value = '';
            ui.importPassword.value = '';
            alert(`Import successful!\n\nImported: ${r.added} accounts\nSkipped (duplicates): ${r.skipped}` + (r.invalid ? `\nInvalid secret key: ${r.invalid}` : ''));
        } catch (e) {
            console.error('Encrypted import error:', e);
            setError(ui.importError, e.message || 'Import failed. Check vault format and password.');
        } finally {
            ui.confirmEncryptedImport.disabled = false;
        }
    }

    async function exportEncrypted() {
        if (!state.settings.passwordEnabled || !state.key) return;
        const doc = await Vault.serialize({ settings: state.settings, accounts: state.accounts, key: state.key, salt: state.salt });
        ui.exportDataTextarea.value = JSON.stringify(doc, null, 2);
    }

    // ---------- master password ----------
    function setupPasswordModal({ title, prompt, fields, buttonText, cancel, action }) {
        ui.loginModal.querySelectorAll('.secret-input-wrapper input').forEach(i => { i.value = ''; hide(i); });
        ui.loginModal.querySelectorAll('.toggle-password').forEach(b => hide(b));
        resetSecretToggles(ui.loginModal);
        setError(ui.passwordError, '');
        ui.loginTitle.textContent = title;
        ui.loginPrompt.textContent = prompt;
        for (const id of fields) {
            const input = $(id);
            show(input);
            const t = input.parentElement.querySelector('.toggle-password');
            if (t) show(t);
        }
        ui.loginButton.textContent = buttonText;
        show(ui.cancelPasswordChange, !!cancel);
        ui.cancelPasswordChange.onclick = () => { hide(ui.loginModal); if (cancel) cancel(); };
        const run = () => {
            if (ui.loginButton.disabled) return;
            ui.loginButton.disabled = true;
            Promise.resolve().then(action).catch(e => {
                console.error(e);
                setError(ui.passwordError, e.message || String(e));
            }).finally(() => { ui.loginButton.disabled = false; });
        };
        ui.loginButton.onclick = run;
        for (const i of [ui.passwordInputOld, ui.passwordInput, ui.passwordConfirm])
            i.onkeydown = e => { if (e.key === 'Enter') run(); };
        show(ui.loginModal);
        setTimeout(() => $(fields[0]).focus(), 0);
    }

    async function makeVerifier(key) {
        return VC.encryptJSON(key, { check: true });
    }

    async function passwordMatches(password) {
        if (!state.salt || !state.verifier) return false;
        const key = await VC.deriveKey(password, Enc.base64ToBytes(state.salt));
        return (await VC.decryptJSON(key, state.verifier)) != null;
    }

    async function handleLogin() {
        const p = ui.passwordInput.value;
        if (!p) return setError(ui.passwordError, 'Password required.');
        const opened = await VC.openVault(state.encrypted, p);
        if (!opened) return setError(ui.passwordError, 'Invalid password.');
        state.key = opened.key;
        state.salt = state.encrypted.salt;
        state.verifier = await makeVerifier(opened.key);
        state.accounts = opened.data.accounts;
        startApp();
    }

    function checkNewPassword(p, c, what = 'Password') {
        if (p.length < VC.MIN_PASSWORD_LENGTH) return `${what} must be >= ${VC.MIN_PASSWORD_LENGTH} chars.`;
        if (p !== c) return what === 'Password' ? "Passwords don't match." : "New passwords don't match.";
        return null;
    }

    async function setPassword(p) {
        const salt = VC.newSalt();
        state.key = await VC.deriveKey(p, salt);
        state.salt = Enc.bytesToBase64(salt);
        state.verifier = await makeVerifier(state.key);
        state.settings.passwordEnabled = true;
    }

    async function handlePasswordCreate() {
        const err = checkNewPassword(ui.passwordInput.value, ui.passwordConfirm.value);
        if (err) return setError(ui.passwordError, err);
        await setPassword(ui.passwordInput.value);
        applySettings();
        hide(ui.loginModal);
        await save();
    }

    async function handleChangePassword() {
        if (!(await passwordMatches(ui.passwordInputOld.value))) return setError(ui.passwordError, 'Current password incorrect.');
        const err = checkNewPassword(ui.passwordInput.value, ui.passwordConfirm.value, 'New password');
        if (err) return setError(ui.passwordError, err);
        await setPassword(ui.passwordInput.value);
        hide(ui.loginModal);
        await save();
        alert('Password changed successfully.');
    }

    function onPasswordCheckbox(e) {
        hide(ui.settingsPanel);
        if (e.target.checked) {
            setupPasswordModal({
                title: 'Create Master Password', prompt: 'Create a password to encrypt your vault.',
                fields: ['password-input', 'password-confirm'], buttonText: 'Create Vault',
                cancel: () => { ui.passwordEnabledCheckbox.checked = false; },
                action: handlePasswordCreate,
            });
        } else if (confirm('Are you sure? Your vault will be stored unencrypted.')) {
            state.key = null; state.salt = null; state.verifier = null; state.encrypted = null;
            state.settings.passwordEnabled = false;
            applySettings();
            save();
        } else {
            e.target.checked = true;
        }
    }

    // ---------- start ----------
    function startApp() {
        state.ready = true;
        state.encrypted = state.settings.passwordEnabled ? state.encrypted : null;
        ui.appContainer.classList.remove('locked');
        hide(ui.loginModal);
        hide(ui.loadError);
        applySettings();
        renderCodes();
        if (!ticker) ticker = setInterval(() => updateCodes(false), 1000);
    }

    async function loadVault() {
        hide(ui.loadError);
        let doc;
        try {
            doc = await Store.load();
        } catch (e) {
            console.error('ChronoNumbers load error:', e);
            // never start empty after a failed read: the first save would replace the real vault
            ui.loadErrorText.textContent = 'Could not load your accounts from Peergos: ' + e.message;
            ui.appContainer.classList.remove('locked');
            show(ui.loadError);
            return;
        }
        let parsed;
        try {
            parsed = Vault.parse(doc);
        } catch (e) {
            ui.loadErrorText.textContent = e.message;
            ui.appContainer.classList.remove('locked');
            show(ui.loadError);
            return;
        }
        state.settings = parsed.settings;
        applySettings();
        if (parsed.encrypted) {
            state.encrypted = parsed.encrypted;
            state.accounts = null;
            setupPasswordModal({ title: 'Unlock Vault', prompt: 'Enter your master password to unlock.',
                fields: ['password-input'], buttonText: 'Unlock', action: handleLogin });
        } else {
            state.accounts = parsed.accounts;
            startApp();
        }
    }

    function closeTopModal() {
        for (const m of [ui.showQrModal, ui.exportVaultModal, ui.aegisImportModal, ui.encryptedImportModal, ui.editAccountModal, ui.addAccountModal]) {
            if (!m.classList.contains('hidden')) { m === ui.addAccountModal ? closeAddModal() : hide(m); return true; }
        }
        if (!ui.loginModal.classList.contains('hidden') && !ui.cancelPasswordChange.classList.contains('hidden')) {
            ui.cancelPasswordChange.click();
            return true;
        }
        if (!ui.settingsPanel.classList.contains('hidden')) { hide(ui.settingsPanel); return true; }
        return false;
    }

    function wire() {
        ui.codesContainer.addEventListener('click', e => {
            const item = e.target.closest('.code-item');
            if (!item) return;
            if (e.target.closest('.code')) return void onCodeClick(item);
            const uuid = item.dataset.uuid;
            if (e.target.closest('.edit-btn')) handleEdit(uuid);
            else if (e.target.closest('.delete-btn')) handleDelete(uuid);
            else if (e.target.closest('.qr-btn')) handleShowQr(uuid);
        });
        ui.settingsToggle.addEventListener('click', () => { if (state.ready) ui.settingsPanel.classList.toggle('hidden'); });
        ui.settingsClose.addEventListener('click', () => hide(ui.settingsPanel));
        ui.fontSizeSlider.addEventListener('input', () => { state.settings.fontSize = parseInt(ui.fontSizeSlider.value, 10); applySettings(); });
        ui.fontSizeSlider.addEventListener('change', () => { state.settings.fontSize = parseInt(ui.fontSizeSlider.value, 10); applySettings(); save(); });
        ui.layoutButtons.forEach(b => b.addEventListener('click', () => { state.settings.layout = b.dataset.layout; applySettings(); save(); }));
        for (const c of [ui.showIssuerCheck, ui.showNameCheck, ui.showActionsCheck]) c.addEventListener('change', () => {
            state.settings.showIssuer = ui.showIssuerCheck.checked;
            state.settings.showName = ui.showNameCheck.checked;
            state.settings.showActions = ui.showActionsCheck.checked;
            applyDisplaySettings();
            save();
        });
        ui.maskCodesCheck.addEventListener('change', () => { state.settings.maskCodes = ui.maskCodesCheck.checked; updateCodes(false); save(); });
        ui.searchBar.addEventListener('input', filterCodes);

        ui.addAccountBtn.addEventListener('click', () => {
            if (!state.ready) return toast('Your accounts are not loaded yet.');
            setError(ui.addError, '');
            openModal(ui.addAccountModal);
        });
        ui.cancelAddAccount.addEventListener('click', closeAddModal);
        ui.saveManualAccount.addEventListener('click', handleManualAdd);
        ui.manualSecret.addEventListener('keydown', e => { if (e.key === 'Enter') handleManualAdd(); });
        ui.scanQrButton.addEventListener('click', () => ui.qrFileInput.click());
        ui.qrFileInput.addEventListener('change', e => {
            const f = e.target.files[0];
            e.target.value = '';
            if (f) handleQrFile(f);
        });

        ui.cancelEditAccount.addEventListener('click', () => hide(ui.editAccountModal));
        ui.updateEditAccount.addEventListener('click', handleUpdate);
        ui.closeQrModalBtn.addEventListener('click', () => hide(ui.showQrModal));

        ui.deleteAllBtn.addEventListener('click', () => {
            if (!state.accounts) return;
            if (!confirm('Are you sure you want to delete ALL accounts? This is irreversible.')) return;
            state.accounts = [];
            codeCache.clear();
            save();
            renderCodes();
        });
        ui.importAegisBtn.addEventListener('click', () => { hide(ui.settingsPanel); setError(ui.aegisError, ''); openModal(ui.aegisImportModal); });
        ui.cancelAegisImport.addEventListener('click', () => { hide(ui.aegisImportModal); ui.aegisJsonInput.value = ''; });
        ui.confirmAegisImport.addEventListener('click', handleAegisImport);
        ui.importEncryptedVaultBtn.addEventListener('click', () => {
            hide(ui.settingsPanel);
            ui.encryptedVaultInput.value = '';
            ui.importPassword.value = '';
            resetSecretToggles(ui.encryptedImportModal);
            setError(ui.importError, '');
            openModal(ui.encryptedImportModal);
        });
        ui.cancelEncryptedImport.addEventListener('click', () => { hide(ui.encryptedImportModal); ui.encryptedVaultInput.value = ''; ui.importPassword.value = ''; });
        ui.confirmEncryptedImport.addEventListener('click', handleEncryptedImport);
        ui.exportVaultBtn.addEventListener('click', () => {
            hide(ui.settingsPanel);
            ui.exportDataTextarea.value = '';
            ui.exportEncryptedBtn.disabled = !state.settings.passwordEnabled;
            openModal(ui.exportVaultModal);
        });
        ui.closeExportBtn.addEventListener('click', () => hide(ui.exportVaultModal));
        ui.copyExportBtn.addEventListener('click', async () => alert((await copyText(ui.exportDataTextarea.value)) ? 'Copied!' : 'Copy failed.'));
        ui.exportUnencryptedBtn.addEventListener('click', () => { ui.exportDataTextarea.value = JSON.stringify(Acc.toAegis(state.accounts || []), null, 2); });
        ui.exportEncryptedBtn.addEventListener('click', () => exportEncrypted().catch(e => alert('Export failed: ' + e.message)));

        ui.passwordEnabledCheckbox.addEventListener('change', onPasswordCheckbox);
        ui.changePasswordBtn.addEventListener('click', () => {
            hide(ui.settingsPanel);
            setupPasswordModal({ title: 'Change Master Password', prompt: '',
                fields: ['password-input-old', 'password-input', 'password-confirm'], buttonText: 'Change Password',
                cancel: () => {}, action: handleChangePassword });
        });
        document.querySelectorAll('.toggle-password').forEach(btn => btn.addEventListener('click', e => {
            const input = e.currentTarget.parentElement.querySelector('input');
            const showIt = input.type === 'password';
            input.type = showIt ? 'text' : 'password';
            e.currentTarget.textContent = showIt ? '🙈' : '👁️';
        }));
        ui.loadRetryBtn.addEventListener('click', loadVault);
        document.addEventListener('keydown', e => { if (e.key === 'Escape') closeTopModal(); });
        window.addEventListener('beforeunload', e => {
            if (!Store.idle()) { e.preventDefault(); e.returnValue = ''; }
        });
        Store.onStatus(onSaveStatus);
    }

    function main() {
        bindUi();
        ui.footerVersion.textContent = `v${CN.VERSION}`;
        wire();
        applySettings();
        loadVault();
    }

    CN.app = { state, main, _test: { renderCodes, updateCodes } };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', main);
    else main();
})(typeof globalThis !== 'undefined' ? globalThis : this);
