/**
 * V5 isolation guard for database paths.
 *
 * `openDatabase()` migrates and seeds whatever file it is handed. V1-V4 are
 * frozen, so any code path that accepts a database location from an operator
 * argument, an environment variable or a request must run it through here
 * first. Anything outside this project directory is refused rather than
 * silently written to.
 *
 * `:memory:` is allowed: it is what the test suite uses and it touches no disk.
 */

import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const V5_PROJECT_ROOT = resolve(join(dirname(fileURLToPath(import.meta.url)), ".."));

export function isInsideV5(candidate, root = V5_PROJECT_ROOT) {
  if (candidate === ":memory:") return true;
  const target = resolve(String(candidate));
  const rootPath = resolve(root);
  if (target === rootPath) return false;
  const inside = relative(rootPath, target);
  if (!inside) return false;
  if (inside === "..") return false;
  if (inside.startsWith(`..${sep}`)) return false;
  // An absolute result means the two paths are on different drives.
  if (resolve(inside) === inside) return false;
  return true;
}

export function assertV5DatabasePath(candidate, root = V5_PROJECT_ROOT) {
  if (candidate === ":memory:") return ":memory:";
  const target = resolve(String(candidate));
  if (isInsideV5(target, root)) return target;
  const error = new Error(
    "Refusing to open a database outside this V5 project.\n" +
      `  requested: ${target}\n` +
      `  V5 root:   ${resolve(root)}\n` +
      "openDatabase() migrates and seeds the file it opens, and V1-V4 are frozen. " +
      "Copy the database into this project first if you need to inspect it.",
  );
  error.code = "database_outside_v5";
  error.statusCode = 400;
  throw error;
}
