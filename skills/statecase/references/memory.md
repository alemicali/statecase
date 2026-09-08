# Explicit native memory collections

Use this workflow only for collections the operator/deployment policy selected.
Run `statecase --json memory list` and inspect configured harness namespaces in
`statecase --json status`. Each collection ID is stable across machines; its
directory is device-local. Never guess a native directory from the other host's
home path or reinterpret a collection ID as another project.

For a selected Claude project memory directory, use the already attached logical
workspace ID and configured harness namespace:

```sh
statecase --json memory map project-recall /native/memory/path --kind claude-project --harness harness:claude:default --workspace ws_project --dry-run
```

Review the selected identity, file count and byte count. After authorization,
repeat with `--yes` instead of `--dry-run`. Codex uses `--kind codex-global` and
the configured Codex namespace, without `--workspace`: it is global recall, not
project-isolated memory. Never grant it implicitly with a project token.

On a fresh peer, map the same ID with the same category/harness/workspace and its
own native path. For an existing binding, `memory map <id> <new-path> --dry-run`
preserves those identity fields and previews clearing the applied marker. Repeat
with `--yes`, then pull/hydrate before resume. Mapping does not move or delete
files from the old directory. To change logical ownership, use a new collection
ID; do not remove/recreate an old ID to bypass an identity mismatch.

`memory remove <id> --dry-run`, followed by `--yes` after approval, forgets only
the local binding. It neither deletes native content nor erases cloud history.
Remove dependent project-memory bindings before detaching their logical workspace.
Enrollment rejects unsafe/unsupported selected native content; do not fall back
to a Drop or exclude inconvenient files just to make a check pass.

For historical inspection, use the `mappingId` returned by `memory list`
(`memory_<collectionId>`) with `restore --revision ... --mapping ... --target ...
--dry-run`. Staging restores only that collection. In-place restore follows the
main skill's approval/preview/stopped-harness requirements, including the native
harness owning this memory; do not restore the active agent's own recall.

If `requiresDaemonRestart` is true and the installation uses a running service,
stop the Statecase daemon and run `statecase daemon install` again so both its
filesystem watches and OS write permissions include the new roots. Do not stop
the harness itself for a mapping-only change. No native settings are modified.

For a sandbox, the trusted issuer must explicitly grant `memory:<id>` alongside
the required harness/workspace namespaces. Mapping does not create that grant.
Read/append permits updates to the granted memory; it is a behavioral trust
decision. Missing scope is not a reason to inspect keys or widen access.

`nativeLocationVerified: false` is intentional: current transport and checkpoint
tests do not establish effective native recall/generation, custom/subagent
formats or native-version compatibility. Do not claim those capabilities from
a successful map or sync. Strict session hydration checks pinned collections,
but complete native path localization/compatibility still requires qualification.
