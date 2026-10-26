import fs from "node:fs";
import path from "node:path";
console.error("start");
try {
  fs.mkdirSync(path.dirname(path.resolve("/proc/nope/x.db")), { recursive: true });
  console.error("mkdir ok");
} catch (e) {
  console.error("mkdir threw:", e.code);
}
try {
  const { default: Database } = await import("better-sqlite3");
  console.error("import ok");
  const db = new Database("/proc/nope/x.db");
  console.error("db open ok");
  db.close();
} catch (e) {
  console.error("db threw:", e.code ?? e.message);
}
console.error("done");
