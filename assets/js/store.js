/* ChronoNumbers – the vault file in the app's private Peergos data folder (STORE_APP_DATA).
 *   GET  /peergos-api/v0/data/<file>  → 200 JSON | 404 (first start: no file yet)
 *   PUT  /peergos-api/v0/data/<file>  → 201 created | 200 replaced
 * Every call has a time limit (Peergos can leave a request unanswered), and writes are serialized: a change made
 * while a write runs is written right after it (only the newest state; concurrent PUTs on one file can fail).
 * Copyright (C) 2026 anderlejan. GPL-3.0-or-later. */
(function (root) {
    'use strict';
    const CN = root.CN = root.CN || {};

    const VAULT_FILE = 'chrononumbers.vault.json';
    const API = '/peergos-api/v0/data/';
    const READ_TIMEOUT_MS = 60000;
    const WRITE_TIMEOUT_MS = 90000;

    class StoreError extends Error {
        constructor(message, status) { super(message); this.status = status; }
    }

    async function request(url, options, timeoutMs) {
        const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
        let timer;
        const timeout = new Promise((_, reject) => {
            timer = setTimeout(() => { if (ctrl) ctrl.abort(); reject(new StoreError('Peergos did not answer in time.', 0)); }, timeoutMs);
        });
        try {
            return await Promise.race([fetch(url, { ...options, signal: ctrl ? ctrl.signal : undefined }), timeout]);
        } catch (e) {
            if (e instanceof StoreError) throw e;
            throw new StoreError('Cannot reach Peergos: ' + (e && e.message || e), 0);
        } finally {
            clearTimeout(timer);
        }
    }

    /** The stored vault object, or null when there is none yet (first start). Throws StoreError otherwise. */
    async function load() {
        const r = await request(API + VAULT_FILE, { method: 'GET', cache: 'no-store' }, READ_TIMEOUT_MS);
        if (r.status === 404) return null;
        if (!r.ok) throw new StoreError(`Peergos answered ${r.status} ${r.statusText || ''}`.trim(), r.status);
        const text = await r.text();
        if (!text.trim()) return null;
        try {
            return JSON.parse(text);
        } catch (e) {
            throw new StoreError('The vault file is damaged (not valid JSON).', r.status);
        }
    }

    async function put(data) {
        const r = await request(API + VAULT_FILE, {
            method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
        }, WRITE_TIMEOUT_MS);
        if (!r.ok) throw new StoreError(`Saving failed: Peergos answered ${r.status} ${r.statusText || ''}`.trim(), r.status);
    }

    // ---- serialized writer ----
    let running = null;      // promise of the write in progress
    let pending = null;      // {produce, waiters} – the newest state waiting for the running write
    const listeners = new Set();

    function emit(state, error) {
        for (const fn of listeners) { try { fn(state, error); } catch (e) { console.error(e); } }
    }

    /** Saves the result of `produce()` (sync or async, called when the write starts → always the newest state). */
    function save(produce) {
        return new Promise((resolve, reject) => {
            if (pending) {
                pending.produce = produce;
                pending.waiters.push({ resolve, reject });
            } else {
                pending = { produce, waiters: [{ resolve, reject }] };
            }
            if (!running) running = drain();
        });
    }

    async function drain() {
        while (pending) {
            const job = pending;
            pending = null;
            emit('saving');
            let error = null;
            for (let attempt = 0; attempt < 3; attempt++) {
                try {
                    await put(await job.produce());
                    error = null;
                    break;
                } catch (e) {
                    error = e;
                    if (pending) break; // a newer state is waiting – write that one instead
                    await new Promise(r => setTimeout(r, 800 * (attempt + 1)));
                }
            }
            if (error && !pending) {
                emit('error', error);
                job.waiters.forEach(w => w.reject(error));
            } else {
                if (!pending) emit('saved');
                job.waiters.forEach(w => w.resolve());
            }
        }
        running = null;
    }

    function idle() {
        return !running && !pending;
    }

    CN.store = { load, save, idle, onStatus: fn => listeners.add(fn), VAULT_FILE, StoreError };
})(typeof globalThis !== 'undefined' ? globalThis : this);
