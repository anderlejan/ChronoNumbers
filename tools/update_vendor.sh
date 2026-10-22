#!/bin/sh
# Rebuilds assets/vendor/ from the pinned upstream sources (needs node/npm and git) and checks the hashes in
# tools/vendor.json. Run from the repository root:  sh tools/update_vendor.sh
set -eu
ROOT=$(pwd)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
cd "$TMP"
npm pack jsqr@1.4.0 >/dev/null 2>&1
tar xzf jsqr-1.4.0.tgz
cp package/dist/jsQR.js "$ROOT/assets/vendor/jsQR.js"
git clone -q https://github.com/nayuki/QR-Code-generator qr
git -C qr checkout -q 3c6d0b3cefb4e049dc337e82237c9644399716a8
cp qr/typescript-javascript/qrcodegen.ts .
npm init -y >/dev/null 2>&1
npm install -q typescript@5.6.3 >/dev/null 2>&1
npx tsc --target ES2017 --strict qrcodegen.ts
cp qrcodegen.js "$ROOT/assets/vendor/qrcodegen.js"
cd "$ROOT"
python3 tools/make_release.py --check-vendor
