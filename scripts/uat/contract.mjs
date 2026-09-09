// Explicit golden request contract for standalone Node UAT drivers. Keep in
// step with the released client; protocol tests verify parity, and real Worker
// drills enforce these headers independently of the CLI implementation.
export const contractHeaders = Object.freeze({
  "x-statecase-client-contract": "1",
  "x-statecase-capabilities": "namespace-provenance-v1,native-context-v1,memory-references-v1,local-write-guards-v1",
});
