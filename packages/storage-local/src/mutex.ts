import { closeSync, linkSync, lstatSync, mkdirSync, openSync, unlinkSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";

export class LocalMutexBusy extends Error {
  constructor() { super("local mutex is already held"); this.name = "LocalMutexBusy"; }
}

/** A persistent inode and a kernel-backed SQLite transaction, never a PID lease.
 * Do not unlink, replace, copy, or open/close this file outside SQLite while
 * any owner is live: POSIX close semantics can release same-process locks.
 */
export class LocalFileMutex {
  #closed = false;
  private constructor(readonly path: string, private readonly database: Database.Database) {}

  static acquire(path: string): LocalFileMutex {
    const target = resolve(path); let database: Database.Database | undefined;
    try {
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
      let exists = true;
      try { lstatSync(target); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") exists = false; else throw error; }
      if (!exists) {
        // Close the unpublished inode before linking it. Opening then closing
        // the final path could drop another local connection's POSIX lock.
        const temporary = `${target}.${randomUUID()}.tmp`;
        const fd = openSync(temporary, "wx", 0o600); closeSync(fd);
        try { linkSync(temporary, target); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
        finally { unlinkSync(temporary); }
      }
      const before = lstatSync(target);
      if (!before.isFile() || before.nlink !== 1 || (before.mode & 0o077) !== 0 ||
          (process.getuid && before.uid !== process.getuid())) throw new Error("unsafe mutex file");
      database = new Database(target, { timeout: 0, fileMustExist: true });
      database.exec("BEGIN EXCLUSIVE");
      // Force SQLite to validate the file, even if there are no tables.
      database.pragma("user_version", { simple: true });
      const after = lstatSync(target);
      if (before.dev !== after.dev || before.ino !== after.ino || !after.isFile() || after.nlink !== 1) throw new Error("mutex inode changed");
      return new LocalFileMutex(target, database);
    } catch (error) {
      database?.close();
      if ((error as { code?: unknown }).code === "SQLITE_BUSY") throw new LocalMutexBusy();
      throw new Error("local mutex is unavailable or unsafe; raw filesystem/database diagnostics withheld");
    }
  }

  release(): void {
    if (this.#closed) return;
    // close() rolls back the open transaction and releases the native lock.
    this.database.close(); this.#closed = true;
  }
}
