const fs = require('fs-extra');
const path = require('path');

/**
 * Pre-package script to minimize the final package size
 * This runs right before electron-builder packages the app
 */

const projectRoot = path.join(__dirname, '..');

async function prePackageOptimization() {
  console.log('Running pre-package optimization...');

  // Remove large unused vendor binaries for other platforms
  const vendorPath = path.join(projectRoot, 'src', 'vendor');
  const unnecessaryVendorFiles = [
    path.join(vendorPath, 'yt-dlp_macos') // macOS binary
  ];

  let totalSaved = 0;

  for (const filePath of unnecessaryVendorFiles) {
    try {
      if (await fs.pathExists(filePath)) {
        const stats = await fs.stat(filePath);
        await fs.remove(filePath);
        totalSaved += stats.size;
        console.log(`Removed: ${path.relative(projectRoot, filePath)} (${formatBytes(stats.size)})`);
      }
    } catch (error) {
      console.warn(`Warning: Could not remove ${filePath}:`, error.message);
    }
  }

  console.log(`Pre-package optimization complete! Space saved: ${formatBytes(totalSaved)}`);
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// Run optimization
prePackageOptimization().catch(console.error);
