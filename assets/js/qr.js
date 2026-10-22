/* ChronoNumbers – QR codes: drawing (Project Nayuki's qrcodegen) and reading from pictures (jsQR).
 * Copyright (C) 2026 anderlejan. GPL-3.0-or-later. */
(function (root) {
    'use strict';
    const CN = root.CN = root.CN || {};

    /** A canvas with the QR code of `text` (white quiet zone of 4 modules). */
    function toCanvas(text, scale = 5, border = 4) {
        if (typeof qrcodegen === 'undefined') throw new Error('The QR code library is not loaded.');
        const qr = qrcodegen.QrCode.encodeText(text, qrcodegen.QrCode.Ecc.MEDIUM);
        const size = (qr.size + border * 2) * scale;
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = size;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#FFFFFF';
        ctx.fillRect(0, 0, size, size);
        ctx.fillStyle = '#000000';
        for (let y = 0; y < qr.size; y++)
            for (let x = 0; x < qr.size; x++)
                if (qr.getModule(x, y)) ctx.fillRect((x + border) * scale, (y + border) * scale, scale, scale);
        return canvas;
    }

    function loadImage(file) {
        return new Promise((resolve, reject) => {
            const url = URL.createObjectURL(file);
            const img = new Image();
            img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
            img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('This file could not be opened as a picture.')); };
            img.src = url;
        });
    }

    function decode(img, maxSide) {
        const k = Math.min(1, maxSide / Math.max(img.naturalWidth || img.width, img.naturalHeight || img.height));
        const w = Math.max(1, Math.round((img.naturalWidth || img.width) * k));
        const h = Math.max(1, Math.round((img.naturalHeight || img.height) * k));
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(img, 0, 0, w, h);
        const data = ctx.getImageData(0, 0, w, h);
        // both: screenshots of dark-mode pages show light-on-dark codes
        const code = jsQR(data.data, w, h, { inversionAttempts: 'attemptBoth' });
        return code && code.data ? code.data : null;
    }

    /** The text of the first QR code in a picture file, or null when there is none. */
    async function scanFile(file) {
        if (typeof jsQR === 'undefined') throw new Error('The QR scanning library is not loaded. Please reload the app.');
        const img = await loadImage(file);
        // big photos: try a reduced copy first (fast), then full size
        return decode(img, 1600) || decode(img, 4096);
    }

    CN.qr = { toCanvas, scanFile };
})(typeof globalThis !== 'undefined' ? globalThis : this);
