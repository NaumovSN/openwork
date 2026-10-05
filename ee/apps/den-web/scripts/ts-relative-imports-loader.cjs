/**
 * Turbopack loader for workspace packages that ship TypeScript source written for Node's ESM resolution, where
 * relative imports name the emitted file (`./xlsx-workbook.js`) while only `./xlsx-workbook.ts` exists. Turbopack
 * has no extension alias, so this drops the `.js` from relative specifiers and lets normal resolution find the
 * `.ts` file. Applied only to the packages listed in next.config.js.
 */
module.exports = function tsRelativeImports(source) {
  return source.replace(/((?:from|import)\s*\(?\s*["'])(\.{1,2}\/[^"']+?)\.js(["'])/g, "$1$2$3");
};
