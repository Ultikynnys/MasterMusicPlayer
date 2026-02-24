/**
 * Add a black stroke around the icon's non-transparent pixels.
 * Strategy: read raw RGBA, dilate alpha mask by stroke width,
 * fill dilated area with black, composite original on top.
 */
const sharp = require('sharp');
const path = require('path');

const STROKE = 8;
const SRC = path.join(__dirname, '..', 'src', 'renderer', 'assets', 'MMP_Logo.png');
const DST = path.join(__dirname, '..', 'build', 'icon.png');

(async () => {
    // Read source as raw RGBA
    const { data: srcRaw, info } = await sharp(SRC).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const w = info.width;
    const h = info.height;
    const ew = w + STROKE * 2;
    const eh = h + STROKE * 2;

    console.log(`Source: ${w}x${h}, Output: ${ew}x${eh}, Stroke: ${STROKE}px`);

    // Build alpha array on expanded canvas (original centered with STROKE padding)
    const alpha = new Uint8Array(ew * eh);
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            alpha[(y + STROKE) * ew + (x + STROKE)] = srcRaw[(y * w + x) * 4 + 3];
        }
    }

    // Dilate alpha mask
    console.log('Dilating alpha mask...');
    const dilated = new Uint8Array(ew * eh);
    for (let y = 0; y < eh; y++) {
        for (let x = 0; x < ew; x++) {
            let found = false;
            const xMin = Math.max(0, x - STROKE);
            const xMax = Math.min(ew - 1, x + STROKE);
            const yMin = Math.max(0, y - STROKE);
            const yMax = Math.min(eh - 1, y + STROKE);
            for (let cy = yMin; cy <= yMax && !found; cy++) {
                for (let cx = xMin; cx <= xMax && !found; cx++) {
                    if ((cx - x) * (cx - x) + (cy - y) * (cy - y) <= STROKE * STROKE) {
                        if (alpha[cy * ew + cx] > 0) {
                            found = true;
                        }
                    }
                }
            }
            dilated[y * ew + x] = found ? 255 : 0;
        }
    }
    console.log('Dilation complete');

    // Build output RGBA: black stroke + original composited on top
    const out = Buffer.alloc(ew * eh * 4);
    for (let y = 0; y < eh; y++) {
        for (let x = 0; x < ew; x++) {
            const i = y * ew + x;
            // Start with black stroke layer
            out[i * 4] = 0;       // R
            out[i * 4 + 1] = 0;   // G
            out[i * 4 + 2] = 0;   // B
            out[i * 4 + 3] = dilated[i]; // A

            // Composite original on top (within padded area)
            const sx = x - STROKE;
            const sy = y - STROKE;
            if (sx >= 0 && sx < w && sy >= 0 && sy < h) {
                const si = (sy * w + sx) * 4;
                const sa = srcRaw[si + 3] / 255;
                const da = out[i * 4 + 3] / 255;
                const oa = sa + da * (1 - sa);
                if (oa > 0) {
                    out[i * 4] = Math.round((srcRaw[si] * sa + out[i * 4] * da * (1 - sa)) / oa);
                    out[i * 4 + 1] = Math.round((srcRaw[si + 1] * sa + out[i * 4 + 1] * da * (1 - sa)) / oa);
                    out[i * 4 + 2] = Math.round((srcRaw[si + 2] * sa + out[i * 4 + 2] * da * (1 - sa)) / oa);
                    out[i * 4 + 3] = Math.round(oa * 255);
                }
            }
        }
    }

    await sharp(out, { raw: { width: ew, height: eh, channels: 4 } })
        .png()
        .toFile(DST);

    console.log(`Done! Saved to ${DST}`);
})();
