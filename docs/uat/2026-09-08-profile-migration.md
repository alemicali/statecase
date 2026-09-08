# Local profile migration and historical reader refusal — 2026-09-08

Status: exact-candidate CI passed; broader release qualification remains open
Test IDs: RT-017, PR-014, SK-001

- Candidate: `20728d379e8ab4ea87be7a0a42e85cb60cc1b888`.
- [CI 34223473210](https://github.com/alemicali/statecase/actions/runs/34223473210)
  completed successfully in all nine jobs.
- Quality job `102051853598` passed 951 tests, 12 local workerd tests, package
  smoke, lint/types/build, production audit and `npm run uat:profile`.
- Historical source: `590782901000b40251030f79c722ddd5e1b4eaac`.
- Historical tarball SHA-256:
  `3b8af8b608eadf4e7815c208f7a2517a61549b80ba0f7d5d2b8ea7dc5c09856b`.
- Current tarball SHA-256:
  `41dc6638afbdd32ad8f1486e04d3105fd3c720a12c1353b1a528154503709bbd`.

The historical and current CLIs were built from their sources, packed and
clean-installed into independent temporary prefixes. No native harness or live
cloud service participates in this particular drill. The historical package
successfully read the synthetic legacy profile and created a Drop mapping first;
this positive control demonstrates a working old executable rather than an
unrelated installation failure.

The current CLI refused normal use until an explicit profile upgrade. Preview
preserved the original bytes. Confirmed migration returned an exact original
backup and enabled current status. The historical package then refused seven
config-dependent operations: status, push, pull, sync, harness setup, Drop add
and workspace attach. Each check preserved config and credential bytes, profile
directory inventory, native directory inventory and the native sentinel. The
current upgrade retry remained a no-op. Fixture cleanup was verified.

The same candidate independently passed native Codex job `102051853556`, native
Claude job `102051853605`, macOS lifecycle/credential jobs and both Node versions.
Pinned Codex `0.153.4` retained same-UUID memory-patch history, two native branches
and no-op convergence (78 encrypted objects). Claude `2.1.263` passed ordinary
continuity and seven-fresh-session memory qualification, including same-UUID
relative history and return transfer. These harness drills use deterministic
loopback inference and reference storage in disposable runner VMs.

Background job `102051853545` passed authenticated startup, automatic
bidirectional transfer, interrupted-upload journal retention/replay, offline
crash recovery, disjoint convergence, deletion and idle no-op. It used two
synthetic installations on one host with local workerd/D1/R2 and verified cleanup.

## Boundaries retained

This does not prove every historical release, commands in old binaries which
never read configuration, an upgrade while old processes are running, arbitrary
shared native roots, power loss, malicious same-user races, or live independent-
host cloud qualification. Profile framing is not an operating-system sandbox.
No operator profile, native session store or deployed Cloudflare resource was
modified. The previous unrelated background-service disappearance remains a
separate investigation; this pass does not establish its original cause.
