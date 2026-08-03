// Safe snapshot of the live database, even while the server is running
// under WAL mode. Uses better-sqlite3's built-in .backup() rather than
// shelling out to the sqlite3 CLI (which isn't guaranteed to be
// installed on a fresh server, and this keeps the whole app to one
// dependency set).
const path = require('path');
const db = require('../db/db');

const outPath = process.argv[2];
if (!outPath) {
  console.error('Usage: node scripts/backupDb.js <output-path>');
  process.exit(1);
}

db.backup(outPath)
  .then(() => {
    console.log(`[backup] db snapshot written to ${outPath}`);
    process.exit(0);
  })
  .catch((err) => {
    console.error('[backup] db snapshot failed:', err.message);
    process.exit(1);
  });
