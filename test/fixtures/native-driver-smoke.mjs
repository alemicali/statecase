import assert from "node:assert/strict";
import { basename, join, resolve } from "node:path";
import { ProfileLock } from "../../packages/runtime/src/index.ts";

const root = process.env.STATECASE_UAT_ROOT;
assert.ok(root && resolve(root) === root && /^statecase-driver-load-[A-Za-z0-9]+$/u.test(basename(root)));
assert.equal(process.env.HOME, root);
const lock = await ProfileLock.acquire(join(root, "profile.lock"));
await lock.release();
process.stdout.write(`${JSON.stringify({ result: "pass", nativeMutex: true })}\n`);
