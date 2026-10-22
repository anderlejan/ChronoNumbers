# ChronoNumbers

A TOTP authenticator (two-factor codes, like Google Authenticator or Aegis) as a [Peergos](https://peergos.org)
custom app. Your accounts live in the app's private folder in your own Peergos space – end-to-end encrypted by
Peergos and, if you want, encrypted a second time with a master password.

- Time-based one-time codes (RFC 6238): SHA1, SHA256 or SHA512, 6–8 digits, any period.
- Add accounts by scanning a QR code from a picture file, or by typing the issuer and secret key.
- Edit issuer, name, group, note and the advanced settings; show any account as a QR code to move it to another app.
- Click a code to copy it. Codes can be masked (asterisks) until you copy them. Search by issuer or name.
- List or grid layout, adjustable font size, show or hide issuer, name and buttons.
- **Master password** (optional): the vault is encrypted with AES-GCM-256, the key derived from your password with
  PBKDF2-SHA-256 (250 000 iterations). Without the password the vault cannot be opened – there is no recovery.
- Import from **Aegis** (unencrypted export, database versions 1–3), export in Aegis' format, and encrypted
  export/import of the whole vault.
- Settings and accounts are saved the moment you change them; nothing is stored in the browser.

The app needs one Peergos permission: **store app data** (its own private folder). It makes no network requests
outside Peergos (the Peergos sandbox would block them anyway).

## Install

1. Download `ChronoNumbers-v<version>.zip` from the latest release.
2. In Peergos, upload the ZIP to your drive and click it to open it (Peergos shows what is inside).
3. Open the menu (⋮) of `peergos-app.json` → **Install** → confirm. Installing a newer version over an older one
   keeps your accounts.
4. Start ChronoNumbers from the Peergos app launcher.

Peergos 1.38 and older cannot install from inside a ZIP: unpack it, upload the folder, then use the menu of
`peergos-app.json` → **Install App**.

Upgrading from 1.6.x: install the new ZIP over it – the vault file and the master password stay the same.

## Development

The app is plain HTML, CSS and JavaScript – no build step, no dependencies at run time.

```
peergos-app.json        Peergos app manifest
assets/index.html       entry point
assets/js/              the app: encoding, totp, vaultcrypto, accounts, vault, store, qr, app (UI)
assets/vendor/          third-party libraries, exactly as built upstream (tools/vendor.json pins them)
assets/licenses/        licence texts shipped with the app
tests/                  unit tests (Node), browser tests (Playwright + a mock Peergos), end-to-end tests (real Peergos)
tools/                  release build, vendor update, settings loader
```

Settings for the tools and tests come from environment variables, or from a local `.env` file (copy
`.env.example`; `.env` is never committed). The app itself has no settings or secrets.

```sh
node tests/unit.test.js                 # logic: RFC 6238/4226 vectors, otpauth, Aegis, vault format, encryption
python3 tests/browser_test.py           # the whole UI against tests/mock_peergos.py (needs Playwright + Chromium)
python3 tests/mock_peergos.py           # try the app at http://localhost:8811/index.html?username=test&pgi=t
python3 tools/make_release.py --dev     # test build: ZIP + unpacked folder in Releases/dev/
python3 tools/make_release.py           # release build from a clean, committed tree; tags v<version>
```

### Testing in a real Peergos

Use a throw-away local server, never a real account:

```sh
java -jar Peergos.jar pki-init -port 8777 -proxy-target /ip4/127.0.0.1/tcp/8003 -log-to-console false \
     -useIPFS false -max-users 100 peergos.password <admin password> pki.keygen.password x pki.keyfile.password y \
     default-quota 4294967296 PEERGOS_PATH <empty folder> -admin-usernames peergos -max-daily-signups 10000
java -cp Peergos.jar tests/peergos/Setup.java http://localhost:8777 testuser     # PEERGOS_TEST_PASSWORD from the environment
printf 'mkdir apps\ncd apps\nput ChronoNumbers-v1.7.0.zip\nexit\n' | \
     java -jar Peergos.jar shell -username testuser -PEERGOS_PASSWORD "$PEERGOS_TEST_PASSWORD" -peergos-url http://localhost:8777
python3 tests/peergos/e2e.py --install ChronoNumbers-v1.7.0.zip
```

### Note on the app's data/ folder

A Peergos app may ship a `data/` folder whose files are copied into the app's private folder on install.
ChronoNumbers ships none – it writes its vault file itself. Do not add an empty `data/` folder: installing an
unpacked app folder whose `data/` (or any folder below it) holds no files never finishes in Peergos
(seen with 1.39). `tools/make_release.py` refuses empty folders.

## Licence

ChronoNumbers is free software under the GNU General Public License, version 3 or later (see `LICENSE`).
It includes jsQR (Apache-2.0) and Project Nayuki's QR Code generator (MIT) – see `THIRD_PARTY_NOTICES.md`.
