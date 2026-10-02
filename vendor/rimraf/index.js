'use strict';

// Local replacement for the deprecated `rimraf` v2 (npm: "Rimraf versions prior to v4
// are no longer supported"). It satisfies the only consumer in this tree, which is
// `temp` (reachable only via electron-winstaller -> the Squirrel.Windows target this
// project never builds), and expects rimraf v2's shape:
//
//   const rimraf = require('rimraf');
//   const rimrafSync = rimraf.sync;          // sync deletion
//   rimraf(path, { maxBusyTries: 6 }, cb);   // callback-style async deletion
//
// Node's fs.rm({ recursive: true, force: true }) is behaviourally equivalent, so this
// shim re-implements the v2 surface with zero dependencies.
//
// Wired up via devDependencies: "rimraf": "file:./vendor/rimraf" (version 2.6.3
// satisfies temp's "~2.6.2", so npm dedupes to this one).

const fs = require('fs');

function rimraf(target, options, callback) {
  if (typeof options === 'function') {
    callback = options;
    options = {};
  }
  if (typeof callback === 'function') {
    fs.rm(target, { recursive: true, force: true }, (err) => callback(err || null));
    return undefined;
  }
  return fs.promises.rm(target, { recursive: true, force: true });
}

rimraf.sync = function rimrafSync(target) {
  fs.rmSync(target, { recursive: true, force: true });
};

module.exports = rimraf;
