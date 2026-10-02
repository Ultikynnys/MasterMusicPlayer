'use strict';

// Drop-in replacement for the deprecated `boolean` package (thenativeweb/boolean),
// which its author retired ("Package no longer supported"). The only consumers in
// this project's tree are Electron's @electron/get optional proxy support
// (global-agent) and its logger (roarr), both of which import this module to coerce
// environment-variable strings to booleans.
//
// Wired up via the "overrides" field in package.json:  { "boolean": "file:./vendor/boolean" }
// Public surface matches the original: { boolean, isBooleanable }.

const TRUE_STRINGS = ['true', 't', 'yes', 'y', 'on', '1'];
const FALSE_STRINGS = ['false', 'f', 'no', 'n', 'off', '0'];

function boolean(value) {
  switch (Object.prototype.toString.call(value)) {
    case '[object String]':
      return TRUE_STRINGS.includes(value.trim().toLowerCase());
    case '[object Number]':
      return value.valueOf() === 1;
    case '[object Boolean]':
      return value.valueOf();
    default:
      return false;
  }
}

function isBooleanable(value) {
  switch (Object.prototype.toString.call(value)) {
    case '[object String]':
      return [...TRUE_STRINGS, ...FALSE_STRINGS].includes(value.trim().toLowerCase());
    case '[object Number]':
      return [0, 1].includes(value.valueOf());
    case '[object Boolean]':
      return true;
    default:
      return false;
  }
}

module.exports = { boolean, isBooleanable };
