function clamp(n, min, max) { return Math.min(max, Math.max(min, n)); }

function hexToRgb(hex) {
    const cleaned = hex.replace('#', '');
    const bigint = parseInt(cleaned.length === 3 ? cleaned.split('').map(c => c + c).join('') : cleaned, 16);
    const r = (bigint >> 16) & 255;
    const g = (bigint >> 8) & 255;
    const b = bigint & 255;
    return { r, g, b };
}

function rgbToHex(r, g, b) {
    const toHex = (v) => ('0' + v.toString(16)).slice(-2);
    return `#${toHex(clamp(Math.round(r), 0, 255))}${toHex(clamp(Math.round(g), 0, 255))}${toHex(clamp(Math.round(b), 0, 255))}`;
}

// Lighten/darken by percentage (positive lightens, negative darkens)
function lightenColor(color, percent) {
    try {
        const hex = color.startsWith('#') ? color : `#${color}`;
        const { r, g, b } = hexToRgb(hex);

        // Support two types of lightening logics present in original codebase
        // Using the one from broadcastServer.js as it's more robust
        const p = percent / 100;
        const lr = p >= 0 ? r + (255 - r) * p : r * (1 + p);
        const lg = p >= 0 ? g + (255 - g) * p : g * (1 + p);
        const lb = p >= 0 ? b + (255 - b) * p : b * (1 + p);
        return rgbToHex(lr, lg, lb);
    } catch (err) {
        console.warn('Failed to lighten color, returning fallback hex', { color, percent, error: err.message });
        return color;
    }
}

function luminance({ r, g, b }) {
    const a = [r, g, b].map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4) });
    return 0.2126 * a[0] + 0.7152 * a[1] + 0.0722 * a[2];
}

function isLightColor(hex) {
    try {
        return luminance(hexToRgb(hex)) > 0.6;
    } catch (err) {
        console.warn('Failed to check if color is light, assuming false', { hex, error: err.message });
        return false;
    }
}

function getContrastColor(backgroundColor) {
    try {
        const { r, g, b } = hexToRgb(backgroundColor);
        const lum = luminance({ r, g, b });

        if (lum > 0.5) {
            // Light background - use dark text
            return {
                color: '#1f2937',
                textShadow: '1px 1px 2px rgba(255, 255, 255, 0.8)'
            };
        } else {
            // Dark background - use light text
            return {
                color: 'white',
                textShadow: '1px 1px 2px rgba(0, 0, 0, 0.8)'
            };
        }
    } catch (err) {
        return { color: 'white', textShadow: 'none' };
    }
}

module.exports = {
    clamp,
    hexToRgb,
    rgbToHex,
    lightenColor,
    luminance,
    isLightColor,
    getContrastColor
};
