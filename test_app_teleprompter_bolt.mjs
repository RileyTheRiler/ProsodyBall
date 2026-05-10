import fs from 'fs';
const appJs = fs.readFileSync('app.js', 'utf-8');
if (appJs.includes('// ⚡ Bolt Optimization: Cache string parsing')) {
    console.log("Bolt optimization successfully found in app.js.");
} else {
    console.error("Failed to find Bolt optimization in app.js.");
    process.exit(1);
}
if (appJs.includes('if (this._lastTeleprompterActive === active')) {
    console.log("DOM caching logic successfully found in app.js.");
} else {
    console.error("Failed to find DOM caching logic in app.js.");
    process.exit(1);
}
