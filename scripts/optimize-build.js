const fs = require('fs-extra');
const path = require('path');

/**
 * Script to optimize the build by removing unnecessary files
 * Run this after npm install but before building
 */

const projectRoot = path.join(__dirname, '..');
const nodeModulesPath = path.join(projectRoot, 'node_modules');

// Directories and files to remove from node_modules to reduce size
const unnecessaryPaths = [
  // Test directories
  '**/test',
  '**/tests',
  '**/__tests__',
  '**/spec',
  '**/specs',
  
  // Documentation
  '**/docs',
  '**/doc',
  '**/documentation',
  '**/examples',
  '**/example',
  '**/sample',
  '**/samples',
  '**/demo',
  '**/demos',
  
  // Development files
  '**/.github',
  '**/.vscode',
  '**/.idea',
  '**/coverage',
  '**/.nyc_output',
  
  // Unnecessary files
  '**/*.md',
  '**/README*',
  '**/CHANGELOG*',
  '**/HISTORY*',
  '**/AUTHORS*',
  '**/CONTRIBUTORS*',
  '**/.eslintrc*',
  '**/.jshintrc*',
  '**/.babelrc*',
  '**/tsconfig.json',
  '**/*.ts.map',
  '**/*.d.ts',
  
  // Specific large packages we can optimize
  'ffmpeg-static/bin/linux',
  'ffmpeg-static/bin/darwin',
  'ffprobe-static/bin/linux',
  'ffprobe-static/bin/darwin',
];

async function optimizeBuild() {
  console.log('Starting build optimization...');
  
  let totalSaved = 0;
  
  for (const pattern of unnecessaryPaths) {
    try {
      const fullPath = path.join(nodeModulesPath, pattern);
      
      // Handle glob patterns
      if (pattern.includes('**')) {
        // For glob patterns, we need to search recursively
        await removeGlobPattern(nodeModulesPath, pattern);
      } else {
        // Direct path removal
        if (await fs.pathExists(fullPath)) {
          const stats = await fs.stat(fullPath);
          const size = stats.isDirectory() ? await getDirSize(fullPath) : stats.size;
          await fs.remove(fullPath);
          totalSaved += size;
          console.log(`Removed: ${pattern} (${formatBytes(size)})`);
        }
      }
    } catch (error) {
      console.warn(`Warning: Could not remove ${pattern}:`, error.message);
    }
  }
  
  console.log(`\nOptimization complete! Total space saved: ${formatBytes(totalSaved)}`);
}

async function removeGlobPattern(basePath, pattern) {
  const glob = require('glob');
  const matches = glob.sync(pattern, { cwd: basePath, absolute: true });
  
  for (const match of matches) {
    try {
      if (await fs.pathExists(match)) {
        const stats = await fs.stat(match);
        const size = stats.isDirectory() ? await getDirSize(match) : stats.size;
        await fs.remove(match);
        console.log(`Removed: ${path.relative(basePath, match)} (${formatBytes(size)})`);
      }
    } catch (error) {
      console.warn(`Warning: Could not remove ${match}:`, error.message);
    }
  }
}

async function getDirSize(dirPath) {
  let size = 0;
  try {
    const items = await fs.readdir(dirPath);
    for (const item of items) {
      const itemPath = path.join(dirPath, item);
      const stats = await fs.stat(itemPath);
      if (stats.isDirectory()) {
        size += await getDirSize(itemPath);
      } else {
        size += stats.size;
      }
    }
  } catch (error) {
    // Ignore errors for inaccessible directories
  }
  return size;
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// Run optimization
optimizeBuild().catch(console.error);
