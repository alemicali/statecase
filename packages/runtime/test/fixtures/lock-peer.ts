import { ProfileLock } from "../../src/index.js";

let held: ProfileLock | undefined;
process.on("message", (message: { action: "acquire" | "release" | "collect"; path: string; checkpoint?: "recovery" | "publish" }) => {
  void (async () => {
    if (message.action === "collect") {
      if (!global.gc) throw new Error("fixture requires exposed GC");
      for (let round = 0; round < 3; round++) { global.gc(); await new Promise<void>((done) => setImmediate(done)); }
      process.send?.({ result: "collected" }); return;
    }
    if (message.action === "release") { await held?.release(); held = undefined; process.send?.({ result: "released" }); return; }
    if (held) throw new Error("fixture already holds a lock");
    const pause = async (point: string) => {
      process.send?.({ result: "checkpoint", point });
      await new Promise<void>(() => undefined); // parent terminates this exact fixture process
    };
    try {
      held = await ProfileLock.acquire(message.path, {
        beforeStaleRecovery: message.checkpoint === "recovery" ? () => pause("recovery") : undefined,
        beforePublish: message.checkpoint === "publish" ? () => pause("publish") : undefined,
      });
      process.send?.({ result: "acquired" });
    } catch { process.send?.({ result: "denied" }); }
  })().catch(() => { process.send?.({ result: "fixture-error" }); });
});
process.send?.({ result: "ready" });
