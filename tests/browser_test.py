#!/usr/bin/env python3
"""Browser test of ChronoNumbers against the mock Peergos data API (tests/mock_peergos.py), in headless Chromium.

  python3 tests/browser_test.py [--headed] [--shots DIR]

Starts its own mock server on a free port; needs Python Playwright with Chromium.
"""
import argparse, re, base64, hashlib, hmac, json, os, socket, struct, sys, tempfile, threading, time, urllib.request
from playwright.sync_api import sync_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import mock_peergos  # noqa: E402

ap = argparse.ArgumentParser()
ap.add_argument('--headed', action='store_true')
ap.add_argument('--shots')
A = ap.parse_args()
failures = []
VAULT = 'chrononumbers.vault.json'
SECRET = 'JBSWY3DPEHPK3PXP'


def ok(name, cond, extra=''):
    print(('  ok   ' if cond else '  FAIL ') + name + ('' if cond or extra == '' else ' – ' + str(extra)), flush=True)
    if not cond:
        failures.append(name)
    return cond


def totp(secret, t=None, digits=6, period=30, algo='sha1'):
    key = base64.b32decode(secret.upper() + '=' * (-len(secret) % 8))
    c = int((time.time() if t is None else t) // period)
    h = hmac.new(key, struct.pack('>Q', c), getattr(hashlib, algo)).digest()
    o = h[-1] & 15
    return str((struct.unpack('>I', h[o:o + 4])[0] & 0x7fffffff) % 10 ** digits).zfill(digits)


def free_port():
    s = socket.socket(); s.bind(('127.0.0.1', 0)); p = s.getsockname()[1]; s.close(); return p


PORT = free_port()
srv = mock_peergos.serve(PORT)
threading.Thread(target=srv.serve_forever, daemon=True).start()
BASE = 'http://localhost:%d' % PORT
URL = BASE + '/index.html?theme=dark-mode&username=test&pgi=t&lang=en'


def mock(path, body=None):
    req = urllib.request.Request(BASE + path, data=None if body is None else json.dumps(body).encode(), method='GET' if body is None else 'POST')
    with urllib.request.urlopen(req) as r:
        return json.loads(r.read() or b'{}')


def stored():
    f = mock('/mock/state')['files'].get(VAULT)
    return json.loads(f) if f else None


PAGE = []


def wait(fn, what, timeout=15, every=0.1):
    end = time.time() + timeout
    last = None
    while time.time() < end:
        try:
            last = fn()
            if last:
                return last
        except Exception as e:
            last = e
        # never time.sleep: the sync Playwright API delivers events (dialogs!) only while it is called
        PAGE[0].wait_for_timeout(every * 1000) if PAGE else time.sleep(every)
    raise TimeoutError('timed out waiting for %s (last: %r)' % (what, last))


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=not A.headed)
        ctx = browser.new_context(viewport={'width': 900, 'height': 900})
        ctx.grant_permissions(['clipboard-read', 'clipboard-write'], origin=BASE)
        page = ctx.new_page()
        PAGE.append(page)
        errors, dialogs = [], []
        page.on('pageerror', lambda e: errors.append('pageerror: ' + str(e)))
        page.on('console', lambda m: errors.append(m.text) if m.type == 'error' and re.search(r'TypeError|ReferenceError|SyntaxError|is not defined', m.text) else None)
        answers = []  # scripted answers for confirm(); default accept

        def on_dialog(d):
            dialogs.append((d.type, d.message))
            accept = answers.pop(0) if answers else True
            d.accept() if accept else d.dismiss()
        page.on('dialog', on_dialog)

        def load(files=None):
            mock('/mock/reset', {'files': files or {}})
            page.goto(URL)
            wait(lambda: page.evaluate("!!(window.CN && CN.app && (CN.app.state.ready || !document.getElementById('login-modal').classList.contains('hidden') || !document.getElementById('load-error').classList.contains('hidden')))"), 'the app to start')

        def items():
            return page.evaluate("[...document.querySelectorAll('.code-item')].filter(i => i.style.display !== 'none').map(i => ({issuer: i.querySelector('.issuer').textContent, name: i.querySelector('.name').textContent, code: i.querySelector('.code').textContent}))")

        def settle():
            wait(lambda: page.evaluate('CN.store.idle()'), 'saving to finish')

        def add_manual(issuer, secret):
            page.click('#add-account-btn')
            page.fill('#manual-issuer', issuer)
            page.fill('#manual-secret', secret)
            page.click('#save-manual-account')

        def open_settings():
            if page.is_hidden('#settings-panel'):
                page.click('#settings-toggle')

        print('1. first start (no vault file yet)', flush=True)
        load()
        ok('app is ready without a data file', page.evaluate('CN.app.state.ready') is True)
        ok('placeholder shown', 'Add your first account.' in page.inner_text('#codes-container'))
        ok('footer shows version and author', page.inner_text('#footer-version') == 'v1.7.0' and 'by anderlejan' in page.inner_text('footer'))
        ok('nothing written on start', mock('/mock/state')['puts'] == 0)

        print('2. add accounts by hand', flush=True)
        add_manual('Example', 'jbsw y3dp ehpk 3pxp')
        wait(lambda: len(items()) == 1, 'the account')
        settle()
        s = stored()
        ok('saved to the data folder with a normalized secret', s and s['accounts'][0]['info']['secret'] == SECRET and s['vault'] is None, s)
        ok('masked by default', wait(lambda: items()[0]['code'] == '******', 'masked code'))
        open_settings()
        page.uncheck('#mask-codes-check')
        code = wait(lambda: (lambda c: c if c.isdigit() else None)(items()[0]['code']), 'the code')
        ok('code equals RFC 6238 TOTP', code in (totp(SECRET), totp(SECRET, time.time() - 1)), code)
        page.click('#settings-close')
        page.click('.code-item .code')
        ok('click shows Copied!', wait(lambda: items()[0]['code'] == 'Copied!', 'Copied!', 3))
        clip = page.evaluate('navigator.clipboard.readText()')
        ok('code copied to the clipboard', clip in (totp(SECRET), totp(SECRET, time.time() - 1)), clip)
        ok('code shown again after copying', wait(lambda: items()[0]['code'].isdigit(), 'code after Copied!', 3))
        add_manual('Again', SECRET.lower())
        ok('duplicate refused', wait(lambda: ('alert', 'Account already exists.') in dialogs, 'alert'))
        page.fill('#manual-secret', '0000-1111')
        page.click('#save-manual-account')
        ok('invalid secret explained in the dialog', 'not valid Base32' in page.inner_text('#add-error'))
        page.fill('#manual-issuer', '')
        page.click('#save-manual-account')
        ok('issuer required', page.inner_text('#add-error') == 'Issuer and Secret required.')
        page.keyboard.press('Escape')
        ok('Escape closes the dialog', page.is_hidden('#add-account-modal'))

        print('3. Aegis import (also: names are text, never HTML)', flush=True)
        aegis = {'version': 1, 'header': {'slots': None, 'params': None}, 'db': {'version': 3, 'groups': [{'uuid': 'g', 'name': 'Team'}], 'entries': [
            {'type': 'totp', 'uuid': 'x1', 'name': '<img src=x onerror="window.__xss=1">', 'issuer': '<b>Bold</b>', 'groups': ['g'],
             'info': {'secret': 'MZXW6YTBOI', 'algo': 'SHA256', 'digits': 8, 'period': 30}},
            {'type': 'totp', 'uuid': 'x2', 'name': 'fast', 'issuer': 'TwoSeconds', 'info': {'secret': 'KRSXG5CTMVRXEZLU', 'algo': 'SHA1', 'digits': 6, 'period': 2}},
            {'type': 'hotp', 'uuid': 'x3', 'name': 'h', 'issuer': 'H', 'info': {'secret': 'MZXW6YQ', 'algo': 'SHA1', 'digits': 6, 'counter': 1}},
        ]}}
        open_settings()
        page.click('#import-aegis-btn')
        page.fill('#aegis-json-input', json.dumps(aegis))
        page.click('#confirm-aegis-import')
        ok('import result reported', wait(lambda: ('alert', 'Imported 2 accounts. Skipped 0 duplicates.') in dialogs, 'import alert'), dialogs[-1:])
        names = [i['name'] for i in items()]
        ok('HTML in names is shown as text', '<img src=x onerror="window.__xss=1">' in names and page.evaluate('window.__xss') is None, names)
        ok('no injected elements', page.evaluate("document.querySelectorAll('#codes-container img, #codes-container b').length") == 0)
        settle()
        imported = [a for a in stored()['accounts'] if a['uuid'] == 'x1'][0]
        ok('Aegis group name, algorithm and digits kept', imported['group'] == 'Team' and imported['info']['algo'] == 'SHA256' and imported['info']['digits'] == 8, imported)
        got8 = [i for i in items() if i['issuer'] == '<b>Bold</b>'][0]['code']
        ok('8-digit SHA256 code right', got8 in (totp('MZXW6YTBOI', digits=8, algo='sha256'), totp('MZXW6YTBOI', time.time() - 1, digits=8, algo='sha256')), got8)
        fast = lambda: [i for i in items() if i['issuer'] == 'TwoSeconds'][0]['code']
        first = wait(lambda: fast() if fast().isdigit() else None, 'fast code')
        second = wait(lambda: fast() if fast().isdigit() and fast() != first else None, 'the 2-second code to change', 6)
        ok('codes renew when their period ends', second in (totp('KRSXG5CTMVRXEZLU', period=2), totp('KRSXG5CTMVRXEZLU', time.time() - 1, period=2)), (first, second))
        page.fill('#search-bar', 'fast')
        ok('search filters by name', [i['issuer'] for i in items()] == ['TwoSeconds'])
        page.fill('#search-bar', '')

        print('4. edit, QR code out and back in, delete', flush=True)
        uid = page.evaluate("CN.app.state.accounts.find(a => a.issuer === 'Example').uuid")
        page.click('.code-item[data-uuid="%s"] .edit-btn' % uid)
        page.fill('#edit-name', 'me@example.com')
        page.fill('#edit-group', 'Private')
        page.fill('#edit-note', 'my note & more')
        page.click('details.advanced-settings summary')
        page.fill('#edit-period', '0')
        page.click('#update-edit-account')
        ok('bad period refused', 'period' in page.inner_text('#edit-error'))
        page.fill('#edit-period', '30')
        page.click('#update-edit-account')
        ok('edit saved', wait(lambda: any(i['name'] == 'me@example.com' for i in items()), 'edited name'))
        page.click('.code-item[data-uuid="%s"] .qr-btn' % uid)
        png = page.evaluate("document.querySelector('#show-qr-canvas canvas').toDataURL('image/png')")
        ok('QR code shown', png.startswith('data:image/png') and 'Example (me@example.com)' in page.inner_text('#show-qr-label'))
        page.click('#close-qr-modal-btn')
        page.click('.code-item[data-uuid="%s"] .delete-btn' % uid)
        ok('delete asks first', wait(lambda: any(d[0] == 'confirm' and 'Example (me@example.com)' in d[1] for d in dialogs), 'confirm'))
        ok('account deleted', wait(lambda: not any(i['issuer'] == 'Example' for i in items()), 'deletion'))
        qr_file = os.path.join(tempfile.mkdtemp(), 'qr.png')
        open(qr_file, 'wb').write(base64.b64decode(png.split(',', 1)[1]))
        page.click('#add-account-btn')
        page.set_input_files('#qr-file-input', qr_file)
        ok('account re-added from its QR picture', wait(lambda: any(i['issuer'] == 'Example' for i in items()), 'QR import'))
        back = page.evaluate("CN.app.state.accounts.find(a => a.issuer === 'Example')")
        ok('QR keeps name, group, note and secret', back['name'] == 'me@example.com' and back['group'] == 'Private' and back['note'] == 'my note & more' and back['info']['secret'] == SECRET, back)

        print('5. display settings are stored', flush=True)
        open_settings()
        page.click('.layout-btn[data-layout=grid]')
        page.evaluate("const s = document.getElementById('font-size-slider'); s.value = 20; s.dispatchEvent(new Event('input')); s.dispatchEvent(new Event('change'));")
        page.uncheck('#show-name-check')
        settle()
        st = stored()['settings']
        ok('layout, font size (a number) and display options saved', st['layout'] == 'grid' and st['fontSize'] == 20 and st['showName'] is False and st['maskCodes'] is False, st)
        page.reload()
        wait(lambda: page.evaluate('CN.app.state.ready'), 'reload')
        ok('settings come back after a reload', page.evaluate("document.getElementById('codes-container').classList.contains('grid') && document.getElementById('codes-container').classList.contains('hide-name')"))
        page.check('#show-name-check') if not page.is_hidden('#settings-panel') else (open_settings(), page.check('#show-name-check'))

        print('6. export → delete all → import (unencrypted)', flush=True)
        count = len(page.evaluate('CN.app.state.accounts'))
        open_settings()
        page.click('#export-vault-btn')
        page.click('#export-unencrypted-btn')
        exported = json.loads(page.input_value('#export-data-textarea'))
        ok('export is in Aegis format', exported['db']['version'] == 2 and all(e['type'] == 'totp' for e in exported['db']['entries']) and len(exported['db']['entries']) == count)
        ok('encrypted export disabled without a password', page.is_disabled('#export-encrypted-btn'))
        page.click('#close-export-btn')
        open_settings()
        page.click('#delete-all-btn')
        ok('delete all', wait(lambda: page.evaluate('CN.app.state.accounts.length') == 0, 'empty'))
        open_settings()
        page.click('#import-aegis-btn')
        page.fill('#aegis-json-input', json.dumps(exported))
        page.click('#confirm-aegis-import')
        ok('own export imports again completely', wait(lambda: page.evaluate('CN.app.state.accounts.length') == count, 'reimport'))

        print('7. master password', flush=True)
        open_settings()
        page.check('#password-enabled-checkbox')
        page.fill('#password-input', 'short')
        page.fill('#password-confirm', 'short')
        page.click('#login-button')
        ok('short password refused', '8' in page.inner_text('#password-error'))
        page.click('#cancel-password-change')
        ok('creating can be cancelled', page.is_hidden('#login-modal') and not page.is_checked('#password-enabled-checkbox'))
        open_settings()
        page.check('#password-enabled-checkbox')
        page.fill('#password-input', 'first password')
        page.fill('#password-confirm', 'first passwort')
        page.click('#login-button')
        ok('mismatch refused', "don't match" in page.inner_text('#password-error'))
        page.fill('#password-confirm', 'first password')
        page.press('#password-confirm', 'Enter')
        wait(lambda: page.is_hidden('#login-modal'), 'vault creation')
        settle()
        s = stored()
        ok('stored encrypted: no accounts, no secrets in the file', 'accounts' not in s and s['vault'] and SECRET not in json.dumps(s) and s['settings']['passwordEnabled'] is True, list(s))
        page.reload()
        wait(lambda: page.is_visible('#login-modal'), 'unlock dialog')
        ok('locked after reload', page.evaluate('CN.app.state.accounts') is None and page.inner_text('#login-title') == 'Unlock Vault')
        page.fill('#password-input', 'wrong password')
        page.click('#login-button')
        ok('wrong password refused', wait(lambda: page.inner_text('#password-error') == 'Invalid password.', 'error'))
        page.fill('#password-input', 'first password')
        page.click('#login-button')
        ok('unlocked with the right password', wait(lambda: page.evaluate('CN.app.state.ready && CN.app.state.accounts.length') == count, 'unlock'))
        open_settings()
        page.click('#change-password-btn')
        page.fill('#password-input-old', 'not it')
        page.fill('#password-input', 'second password')
        page.fill('#password-confirm', 'second password')
        page.click('#login-button')
        ok('change refused with a wrong current password', wait(lambda: page.inner_text('#password-error') == 'Current password incorrect.', 'error'))
        page.fill('#password-input-old', 'first password')
        page.click('#login-button')
        ok('password changed', wait(lambda: ('alert', 'Password changed successfully.') in dialogs, 'alert'))
        settle()
        open_settings()
        page.click('#export-vault-btn')
        page.click('#export-encrypted-btn')
        enc_export = wait(lambda: page.input_value('#export-data-textarea'), 'encrypted export')
        ok('encrypted export holds a vault and no secrets', 'ciphertext' in enc_export and SECRET not in enc_export)
        page.click('#close-export-btn')
        page.reload()
        wait(lambda: page.is_visible('#login-modal'), 'unlock dialog')
        page.fill('#password-input', 'first password')
        page.click('#login-button')
        ok('old password no longer opens it', wait(lambda: page.inner_text('#password-error') == 'Invalid password.', 'error'))
        page.fill('#password-input', 'second password')
        page.click('#login-button')
        wait(lambda: page.evaluate('CN.app.state.ready'), 'unlock')
        open_settings()
        page.click('#delete-all-btn')
        wait(lambda: page.evaluate('CN.app.state.accounts.length') == 0, 'empty')
        open_settings()
        page.click('#import-encrypted-vault-btn')
        page.fill('#encrypted-vault-input', enc_export)
        page.fill('#import-password', 'wrong')
        page.click('#confirm-encrypted-import')
        ok('encrypted import: wrong password explained', wait(lambda: 'Incorrect password' in page.inner_text('#import-error'), 'error'))
        answers.append(True)  # import the settings too
        page.fill('#import-password', 'second password')
        page.click('#confirm-encrypted-import')
        ok('encrypted import restores all accounts', wait(lambda: page.evaluate('CN.app.state.accounts.length') == count, 'import'))
        settle()
        open_settings()
        page.uncheck('#password-enabled-checkbox')
        settle()
        s = stored()
        ok('password switched off: stored unencrypted again', s['vault'] is None and len(s['accounts']) == count and s['settings']['passwordEnabled'] is False)

        print('8. Peergos errors never lose data', flush=True)
        keep = json.dumps(stored())
        mock('/mock/reset', {'files': {VAULT: keep}})
        mock('/mock/fail', {'method': 'GET', 'status': 500, 'count': 1})
        page.goto(URL)
        wait(lambda: page.is_visible('#load-error'), 'the load error')
        ok('a failed read shows an error, not an empty vault', page.evaluate('CN.app.state.ready') is False and 'Could not load' in page.inner_text('#load-error'))
        page.click('#add-account-btn')
        ok('adding is blocked until loaded', page.is_hidden('#add-account-modal'))
        ok('nothing written while not loaded', mock('/mock/state')['puts'] == 0 and json.dumps(stored()) == keep)
        page.click('#load-retry-btn')
        ok('Try again loads the vault', wait(lambda: page.evaluate('CN.app.state.ready && CN.app.state.accounts.length') == count, 'retry'))
        mock('/mock/fail', {'method': 'PUT', 'status': 500, 'count': 3})
        open_settings()
        page.click('.layout-btn[data-layout=list]')
        ok('a failed save is reported', wait(lambda: 'Could not save' in page.inner_text('#toast'), 'toast', 20))
        page.click('#toast')
        settle()
        ok('clicking the message saves again', stored()['settings']['layout'] == 'list')
        mock('/mock/delay', {'seconds': 1.0})
        for lay in ('grid', 'list', 'grid', 'list', 'grid'):
            page.click('.layout-btn[data-layout=%s]' % lay)
        settle()
        ok('rapid changes: writes serialized, the newest state wins', stored()['settings']['layout'] == 'grid' and mock('/mock/state')['puts'] <= 6)
        mock('/mock/delay', {'seconds': 0})

        print('9. vault files written by ChronoNumbers 1.6.1', flush=True)
        legacy = {'settings': {'fontSize': '18', 'layout': 'list', 'passwordEnabled': False, 'showIssuer': True, 'showName': True, 'showActions': True},
                  'accounts': [{'uuid': 'L1', 'issuer': 'Unknown', 'name': 'legacy', 'group': None, 'note': '', 'favorite': False, 'thumbnail': None,
                                'info': {'secret': 'jbswy3dpehpk3pxp', 'algo': 'SHA1', 'digits': 6, 'period': 30}}], 'vault': None}
        load({VAULT: legacy})
        it = items()
        ok('1.6.1 file opens; "Unknown" issuer hidden; masked by default', len(it) == 1 and it[0]['name'] == 'legacy' and page.is_hidden('.code-item .issuer') and wait(lambda: items()[0]['code'] == '******', 'masked'))
        ok('font size string from 1.6.1 understood', page.evaluate("document.getElementById('codes-container').style.fontSize") == '18px')
        ok('nothing rewritten just by opening', mock('/mock/state')['puts'] == 0)
        load({VAULT: 'not json'})
        ok('a damaged file is reported and left alone', page.is_visible('#load-error') and mock('/mock/state')['puts'] == 0)
        if A.shots:
            load({VAULT: legacy})
            page.screenshot(path=os.path.join(A.shots, 'mock-list.png'))

        ok('no script errors', not errors, errors[:5])
        browser.close()
    print('%d check(s) failed' % len(failures) if failures else 'ALL BROWSER TESTS PASSED', flush=True)
    sys.exit(1 if failures else 0)


if __name__ == '__main__':
    main()
