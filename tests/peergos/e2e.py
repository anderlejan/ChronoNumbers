#!/usr/bin/env python3
"""End-to-end test of ChronoNumbers in a REAL local Peergos server (a throw-away one, never a real account).

Needs: a local Peergos server (README "Testing"), a user made with tests/peergos/Setup.java, and the app uploaded
into that user's drive under /<user>/apps/ (a ZIP and/or unpacked app folders, e.g. with the Peergos shell `put`).
Settings come from the environment or .env: PEERGOS_URL, PEERGOS_TEST_USER, PEERGOS_TEST_PASSWORD.

  python3 tests/peergos/e2e.py --install ChronoNumbers-v1.7.0.zip [--install "ChronoNumbers 1.7.0"]
                               [--expect-hang old-folder-with-empty-data] [--shots DIR]

Checks, in Chromium, through the Peergos web UI:
  1. (--expect-hang) installing that app folder never finishes – the Peergos bug with an EMPTY data/ folder
  2. each --install item installs (from inside a ZIP or from an unpacked folder; a repeat is an upgrade)
  3. the app starts in the real sandbox (cross-origin isolated, CSP) and starts empty without a vault file
  4. an account added in the app is stored in the app's Peergos data folder and is there after closing and reopening
  5. the code shown is the right TOTP code; copying works in the sandbox; master password locks it after reopening
"""
import argparse, base64, hashlib, hmac, json, os, struct, sys, time
from playwright.sync_api import sync_playwright

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 'tools'))
import env  # noqa: E402

env.load()
ap = argparse.ArgumentParser()
ap.add_argument('--url', default=os.environ['PEERGOS_URL'])
ap.add_argument('--user', default=os.environ['PEERGOS_TEST_USER'])
ap.add_argument('--install', action='append', default=[], help='ZIP or app folder name in /<user>/apps/ (repeatable, in order)')
ap.add_argument('--expect-hang', action='append', default=[], help='app folder whose installation must NOT finish')
ap.add_argument('--shots')
ap.add_argument('--headed', action='store_true')
A = ap.parse_args()
PASSWORD = os.environ.get('PEERGOS_TEST_PASSWORD')
if not PASSWORD:
    sys.exit('set PEERGOS_TEST_PASSWORD (environment or .env)')
SECRET = 'JBSWY3DPEHPK3PXP'
failures = []

VUE = """(window.__pgVue || (window.__pgVue = {
 root() { const a = document.querySelector('#app'); return a && a._vnode && a._vnode.component ? a._vnode.component.proxy : null; },
 children(c) { const out = []; const walk = v => { if (v == null || typeof v !== 'object') return;
   if (Array.isArray(v)) { v.forEach(walk); return; }
   if (v.component) { if (v.component.proxy) out.push(v.component.proxy); else walk(v.component.subTree); return; }
   if (v.suspense) { walk(v.suspense.activeBranch); return; } walk(v.children); }; walk(c.$.subTree); return out; },
 shown(c) { return c.$el != null && c.$el.nodeType === 1 && document.contains(c.$el); },
 find(method) { const q = []; const r = this.root(); if (r) q.push(r);
   while (q.length) { const c = q.shift(); if (typeof c[method] === 'function' && this.shown(c)) return c; q.push(...this.children(c)); } return null; }
}))"""
PAGE = []


def ok(name, cond, extra=''):
    print(('  ok   ' if cond else '  FAIL ') + name + ('' if cond or extra == '' else ' – ' + str(extra)), flush=True)
    if not cond:
        failures.append(name)
    return cond


def pause(seconds):
    # the sync Playwright API delivers events only while it is called – never time.sleep
    PAGE[0].wait_for_timeout(seconds * 1000)


def wait(fn, what, timeout=120, every=0.5):
    end = time.time() + timeout
    last = None
    while time.time() < end:
        try:
            last = fn()
            if last:
                return last
        except Exception as e:
            last = e
        pause(every)
    raise TimeoutError('timed out waiting for ' + what + ' (last: %r)' % (last,))


def totp(secret, t=None):
    key = base64.b32decode(secret)
    h = hmac.new(key, struct.pack('>Q', int((time.time() if t is None else t) // 30)), hashlib.sha1).digest()
    o = h[-1] & 15
    return str((struct.unpack('>I', h[o:o + 4])[0] & 0x7fffffff) % 10 ** 6).zfill(6)


def shot(page, name):
    if A.shots:
        page.screenshot(path=os.path.join(A.shots, name + '.png'))


def login(page):
    page.goto(A.url + '/')
    wait(lambda: page.evaluate("[...document.querySelectorAll('button')].some(b => b.textContent.trim() === 'Sign in' && !b.disabled)"), 'sign in button', 300)
    page.evaluate("""([u, p]) => { const set = (el, v) => { const s = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        s.call(el, v); el.dispatchEvent(new Event('input', {bubbles: true})); };
        set(document.querySelector('input[name=username]'), u); set(document.querySelector('input[name=password]'), p);
        [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Sign in').click(); }""", [A.user, PASSWORD])
    wait(lambda: page.evaluate("/upgrade/i.test(document.body.innerText)"), 'sign in to complete', 300)


def goto_view(page, label, method, handle):
    probe = "([m, h]) => { const c = " + VUE + ".find(m); if (c) { window[h] = c; return true; } return false; }"
    for _ in range(5):
        if page.evaluate(probe, [method, handle]):
            return
        page.evaluate("l => { const b = [...document.querySelectorAll('button, a')].find(x => x.textContent.trim() === l); if (b) b.click(); }", label)
        try:
            wait(lambda: page.evaluate(probe, [method, handle]), label, 60)
            return
        except TimeoutError:
            pass
    raise RuntimeError('view ' + label + ' never appeared')


DIALOG = "[...document.querySelectorAll('.app-install-container, .pg-dialog')].find(x => x.textContent.includes('App Installation'))"


def start_install(page, name):
    goto_view(page, 'Drive', 'downloadFile', '__drive')
    wait(lambda: page.evaluate("window.__drive.currentDir && !window.__drive.showSpinner"), 'drive listing', 180)
    page.evaluate("p => window.__drive.changePath(p)", '/%s/apps/%s' % (A.user, name))
    wait(lambda: page.evaluate("!window.__drive.showSpinner && window.__drive.files.some(f => f.getName() === 'peergos-app.json')"), 'the app listing of ' + name, 180)

    def open_menu():
        page.evaluate("""() => { window.__drive.closeMenu && window.__drive.closeMenu();
            const card = [...document.querySelectorAll('.grid-card, .drive-table tbody tr')].find(c => c.textContent.includes('peergos-app.json'));
            card.querySelector('[aria-label=menu]').click(); }""")
        pause(1.5)
        return page.evaluate("(() => { const e = document.querySelector('#app-install'); return !!e && e.getClientRects().length > 0; })()")
    wait(open_menu, 'Install in the menu of peergos-app.json', 60, 0.1)
    page.evaluate("document.querySelector('#app-install').click()")
    wait(lambda: page.evaluate("(() => { const x = " + DIALOG + "; return !!x && x.textContent.includes('ChronoNumbers'); })()"), 'the install dialog', 90)
    text = page.evaluate("(" + DIALOG + ").textContent")
    page.evaluate("[...(" + DIALOG + ").querySelectorAll('button')].find(b => b.textContent.trim() === 'Install').click()")
    return text


def finished(page):
    page.evaluate("() => { const c = " + VUE + ".find('confirmReplaceAppInstall'); if (c && c.showConfirm) { window.__replaced = true; c.confirm_consumer_func(); } }")
    return page.evaluate("!(" + DIALOG + ")")


def app_frame(page):
    outer = page.query_selector('#sandboxId')
    fo = outer and outer.content_frame()
    inner = fo and fo.query_selector('#appSandboxId')
    fi = inner and inner.content_frame()
    return fi if fi and '/index.html' in fi.url and 'username=' in fi.url else None


def launch(page):
    goto_view(page, 'Launcher', 'launchAppFromUI', '__launcher')
    wait(lambda: page.evaluate("!window.__launcher.showSpinner && Array.isArray(window.__launcher.appsList) && window.__launcher.appsList.some(a => a.name === 'chrononumbers')"), 'the launcher to list the app', 60)
    page.evaluate("window.__launcher.launchApp('chrononumbers')")
    return wait(lambda: (lambda f: f if f and f.evaluate("!!(window.CN && CN.app && (CN.app.state.ready || !document.getElementById('login-modal').classList.contains('hidden')))") else None)(app_frame(page)), 'the app to start', 120)


def close_app(page):
    page.evaluate("() => { const c = " + VUE + ".find('closeSandbox'); if (c) c.closeSandbox(); }")
    wait(lambda: page.evaluate("!document.querySelector('#sandboxId')"), 'the app to close', 60)


def items(f):
    return f.evaluate("[...document.querySelectorAll('.code-item')].map(i => ({issuer: i.querySelector('.issuer').textContent, code: i.querySelector('.code').textContent}))")


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=not A.headed)
        ctx = browser.new_context(viewport={'width': 1280, 'height': 900})
        page = ctx.new_page()
        PAGE.append(page)
        errors, dialogs = [], []
        page.on('pageerror', lambda e: errors.append('pageerror: ' + str(e)))
        ctx.on('console', lambda m: errors.append(m.text) if m.type == 'error' and ('/js/' in (m.location or {}).get('url', '') or 'ChronoNumbers' in m.text) else None)
        page.on('dialog', lambda d: (dialogs.append((d.type, d.message)), d.accept()))
        print('0. sign in', flush=True)
        login(page)

        if A.expect_hang:
            print('1. the Peergos bug: an app folder with an EMPTY data/ folder', flush=True)
        for name in A.expect_hang:
            start_install(page, name)
            try:
                wait(lambda: finished(page), 'installation', 90)
                ok('installing %s does not finish (empty data/ folder)' % name, False, 'it finished')
            except TimeoutError:
                ok('installing %s never finishes (empty data/ folder) – reproduced' % name, True)
                shot(page, 'hang-' + name)
            login(page)  # a fresh page: the stuck dialog cannot be closed

        print('2. install', flush=True)
        for name in A.install:
            text = start_install(page, name)
            ok('install dialog for %s shows version and permission' % name, '1.' in text and ('data' in text.lower() or 'store' in text.lower()), text[:200])
            page.evaluate("window.__replaced = false")
            t0 = time.time()
            wait(lambda: finished(page), 'installation of ' + name, 180)
            ok('installed from %s in %.0f s%s' % (name, time.time() - t0, ' (replaced: upgrade path)' if page.evaluate('window.__replaced') else ''), True)

        print('3. start in the sandbox', flush=True)
        f = launch(page)
        ok('cross-origin isolated sandbox', f.evaluate('window.crossOriginIsolated') is True)
        want = json.load(open(os.path.join(env.ROOT, 'peergos-app.json'), encoding='utf-8'))['version']
        ok('the installed app is this version (%s)' % want, f.evaluate('CN.VERSION') == want, f.evaluate('CN.VERSION'))
        state0 = f.evaluate('({ready: CN.app.state.ready, n: CN.app.state.accounts && CN.app.state.accounts.length})')
        ok('the app loads its vault (or starts empty) in the real sandbox', state0['ready'] is True, state0)
        shot(page, 'app-1-start')

        print('4. data folder', flush=True)
        # an earlier interrupted run may have left its test account behind
        f.evaluate("if (CN.app.state.accounts.some(a => a.issuer === 'E2E')) { CN.app.state.accounts = CN.app.state.accounts.filter(a => a.issuer !== 'E2E'); CN.app._test.renderCodes(); }")
        existing = f.evaluate('CN.app.state.accounts.length')
        f.click('#add-account-btn')
        f.fill('#manual-issuer', 'E2E')
        f.fill('#manual-secret', SECRET)
        f.click('#save-manual-account')
        wait(lambda: f.evaluate("CN.app.state.accounts.length") == existing + 1, 'the account')
        t0 = time.time()
        wait(lambda: f.evaluate("CN.store.idle() && document.getElementById('save-status').textContent === 'Saved'"), 'the save', 60)
        ok('saved to Peergos in %.1f s' % (time.time() - t0), True)
        raw = f.evaluate("fetch('/peergos-api/v0/data/chrononumbers.vault.json', {cache: 'no-store'}).then(r => r.text())")
        ok('vault file in the app data folder', SECRET in raw and '"E2E"' in raw, raw[:120])
        f.evaluate("CN.app.state.settings.maskCodes = false; CN.app._test.updateCodes(true)")
        code = wait(lambda: (lambda c: c if c.isdigit() else None)([i for i in items(f) if i['issuer'] == 'E2E'][0]['code']), 'the code')
        ok('code is the right TOTP code', code in (totp(SECRET), totp(SECRET, time.time() - 1)), code)
        f.click('.code-item:last-child .code')
        copied = wait(lambda: [i for i in items(f) if i['issuer'] == 'E2E'][0]['code'] == 'Copied!', 'Copied!', 5)
        ok('copy works inside the Peergos sandbox', copied and not any(d[1] == 'Copy failed.' for d in dialogs), dialogs[-2:])
        shot(page, 'app-2-account')
        close_app(page)
        f = launch(page)
        ok('the account is there after closing and reopening', any(i['issuer'] == 'E2E' for i in items(f)))

        print('5. master password in the real sandbox', flush=True)
        # Peergos' own toasts (bottom right, in the main page) can lie over the settings panel: click in the frame
        print('    Peergos toasts now:', page.evaluate("[...document.querySelectorAll('.Vue-Toastification__toast')].map(t => t.textContent.trim().slice(0, 80))"), flush=True)
        fclick = lambda sel: f.evaluate("s => document.querySelector(s).click()", sel)
        fclick('#settings-toggle')
        fclick('#password-enabled-checkbox')
        f.fill('#password-input', 'e2e password 1')
        f.fill('#password-confirm', 'e2e password 1')
        fclick('#login-button')
        wait(lambda: f.evaluate("CN.store.idle() && document.getElementById('save-status').textContent === 'Saved'"), 'the save', 60)
        raw = f.evaluate("fetch('/peergos-api/v0/data/chrononumbers.vault.json', {cache: 'no-store'}).then(r => r.text())")
        ok('stored encrypted in Peergos', SECRET not in raw and 'ciphertext' in raw)
        close_app(page)
        f = launch(page)
        ok('locked after reopening', f.is_visible('#login-modal'))
        f.fill('#password-input', 'e2e password 1')
        fclick('#login-button')
        ok('unlocks', wait(lambda: f.evaluate('CN.app.state.ready') and any(i['issuer'] == 'E2E' for i in items(f)), 'unlock', 60))
        # leave the test account as it was: no password, no test account
        fclick('#settings-toggle')
        fclick('#password-enabled-checkbox')
        f.evaluate("CN.app.state.accounts = CN.app.state.accounts.filter(a => a.issuer !== 'E2E')")
        fclick('#settings-toggle')
        fclick('.layout-btn[data-layout=list]')
        wait(lambda: f.evaluate("CN.store.idle()"), 'the save', 60)
        shot(page, 'app-3-end')
        close_app(page)
        ok('no script errors in the app', not errors, errors[:5])
        browser.close()
    print('%d check(s) failed' % len(failures) if failures else 'E2E PASSED', flush=True)
    sys.exit(1 if failures else 0)


if __name__ == '__main__':
    main()
