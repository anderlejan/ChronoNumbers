# Third-party software in ChronoNumbers

| File | Software | Licence | Source |
|---|---|---|---|
| `assets/vendor/jsQR.js` | jsQR 1.4.0 – QR code reader, `dist/jsQR.js` of the npm package, unchanged | Apache License 2.0 – `assets/licenses/jsQR-Apache-2.0.txt` | https://github.com/cozmo/jsQR · https://www.npmjs.com/package/jsqr |
| `assets/vendor/qrcodegen.js` | QR Code generator library, Copyright (c) Project Nayuki – `typescript-javascript/qrcodegen.ts` at commit `3c6d0b3c`, compiled with TypeScript 5.6.3 (`tsc --target ES2017 --strict`), otherwise unchanged | MIT – `assets/licenses/qrcodegen-MIT.txt` (also in the file's header) | https://github.com/nayuki/QR-Code-generator |

The SHA-256 of each file is pinned in `tools/vendor.json`; `sh tools/update_vendor.sh` rebuilds both from the
upstream sources and checks them. Both licences are compatible with the GPL-3.0-or-later licence of ChronoNumbers.

ChronoNumbers runs inside Peergos but contains no Peergos code; it only calls the documented app API
(`/peergos-api/v0/data/`).
