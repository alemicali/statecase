# Daytona two-GiB session UAT — 2026-09-07

Status: passed

This report qualifies `PERF-003`: bounded transfer, tail-only upload, and
deterministic concurrent append merge for a real Codex JSONL session larger
than 2 GiB. The packaged CLI ran in an ephemeral Daytona sandbox against the
deployed Cloudflare Worker, D1, Durable Object, and R2 service.

## Candidate and environment

- Candidate commit: `c04acd1`
- CLI package: `@statecase/cli@0.1.0`
- Package SHA-256:
  `0f81658c3285b39a7414319e9eba144e12e9891e007b16cbabbaf71034c6ab33`
- API: `https://statecase-api.hi-0e6.workers.dev`
- Worker version: `1957598c-cf58-42e6-88a9-9ebc95d9babf`
- Daytona runtime: Node.js 22.23.2, 4 vCPU, 4 GiB RAM, 10 GiB POSIX disk
- Temporary staging: disposable 20 GiB Daytona volume mounted through its
  object-backed filesystem
- Sandbox: `94dab357-8fe6-43fd-ba87-b16fc1864757`, ephemeral, 90-minute TTL

Before the run, the candidate passed 344 repository tests with 90.24%
aggregate branch coverage, lint, typecheck, build, package smoke, and GitHub
compatibility checks on Node.js 22 and 24. The sandbox received only the
checksummed npm tarball and the non-secret UAT driver. Passwords, recovery
material, and device tokens were generated inside the sandbox and never
printed.

## Acceptance evidence

The driver created two independently authorized devices with the same logical
workspace mapped to different absolute paths. It then:

1. generated a 2,147,483,737-byte Codex JSONL containing 32,768 unique 64-KiB
   records plus workspace metadata;
2. pushed it through deterministic record-aware 4-MiB chunking and observed
   514 encrypted objects;
3. pulled it onto the second device and verified every record and the localized
   workspace path as a stream;
4. appended one distinct complete record independently on each device;
5. proved the first append uploaded only two objects and less than 8 MiB;
6. merged the concurrent append over the streamed 2-GiB common base and proved
   that push also uploaded only two objects and less than 8 MiB;
7. pulled the merged head on both devices and verified all 32,768 filler records
   plus both append IDs exactly once on each native path.

The final result was:

```json
{
  "result": "pass",
  "sessionBytes": 2147483737,
  "fillerRecords": 32768,
  "initialObjects": 514,
  "appendObjects": 2,
  "mergedAppendObjects": 2,
  "durationsMs": {
    "initialPush": 908191,
    "initialPull": 616337,
    "remotePush": 144672,
    "mergedPush": 914984,
    "pullB": 398506,
    "pullA": 412973
  },
  "boundedTailTransfer": true,
  "concurrentMergeOverTwoGiB": true,
  "bothNativePathsConverged": true
}
```

The measured command time was 56 minutes 35.663 seconds in total. This is a
correctness acceptance baseline, not a throughput target. The reproducible
driver is
[`scripts/uat/daytona-large-session.mjs`](../../scripts/uat/daytona-large-session.mjs).

## Findings and corrections

Qualification exposed three environment/test issues and one product edge case:

- Daytona limits a sandbox's POSIX disk request to 10 GiB, so large disposable
  staging used a separately provisioned 20-GiB volume.
- Mounting the entire Statecase home on the object-backed volume is invalid
  because that filesystem does not provide the permission semantics required
  for owner-only configuration. Native state therefore remained on POSIX disk;
  only `TMPDIR` used the volume.
- Repeated identical filler records collapsed to four content-addressed
  objects. The final fixture includes a unique record index and therefore
  exercises 514 real encrypted objects.
- The object-backed mount removes an empty temporary directory after its last
  child disappears. A second sync initially failed before pull with `ENOENT`
  during `statfs`. Commit `c04acd1` now recreates the configured temporary root,
  creates a private staging child, checks capacity on that materialized child,
  and cleans the child on preflight failure. Unit regression tests and the full
  rerun passed.

No acceptance assertion was weakened after these corrections.

## Cleanup

The runner deleted the successful sandbox and its 20-GiB volume in `finally`.
D1 rows for the disposable identity and vault were removed in foreign-key-safe
order. A temporary, non-deployed maintenance Worker was hard-limited to the
three exact UAT vault prefixes. It removed 4, 514, and 518 objects respectively;
subsequent inventories returned zero objects and zero bytes for every prefix.
The maintenance process was then stopped. No unrelated Daytona sandbox,
Cloudflare resource, D1 row, or R2 prefix was modified.

## Remaining boundary

This UAT qualifies the 2-GiB bounded-transfer and concurrent-append path for the
tested Linux x64/Daytona profile. It does not replace the remaining real-OS
daemon/service, architecture compatibility, initialized-submodule, retention,
in-place restore, post-revocation key rewrap, or real harness-version release
gates.
