# Statecase CLI

Take your agents anywhere. Statecase carries encrypted sessions, skills,
context, and work in progress across persistent and ephemeral machines.

Local credentials keep their existing owner-only file mode unless explicitly
protected with a native keyring. On Linux with an available Secret Service:

```sh
statecase --json credentials status
statecase --json credentials protect --dry-run
statecase --json credentials protect --yes
```

Status and preview do not access the keyring. After migration, missing or locked
native keys fail closed; there is no plaintext fallback. This is local at-rest
protection, not a replacement for device enrollment or an encrypted recovery
kit. Selected macOS Keychain support is implemented; default-store UI/reboot and
full recovery/downgrade qualification remain unfinished.

Native memory is opt-in and separate from arbitrary Drops:

```sh
statecase --json memory list
statecase --json memory map recall /native/memory/path --kind codex-global --harness harness:codex:default --dry-run
```

After reviewing the preview, repeat with `--yes`. Claude project collections use
`--kind claude-project --harness harness:claude:default --workspace <logical-id>`.
Use the same collection ID on every peer with that peer's native directory.
An existing binding can change path/name/mode but not logical ownership.
Rebinding clears its applied marker, does not move native files, and requires
pull/hydration before resume. `memory remove <id> --dry-run` / `--yes` removes
only the local binding. Mapping/list/removal need no cloud session and never
grant remote keys or change native memory settings.

When a native service is running, stop it and rerun `statecase daemon install`
after changing selected roots to refresh OS write permissions and watches.
Provision missing roots through normal native initialization or hydration before
service installation; empty/unavailable roots and full native-service lifecycle
still require qualification. Memory transport does not yet establish effective
native recall/generation or compatibility across harness versions.

See the [repository documentation](https://github.com/alemicali/statecase#readme) for
setup, threat-model, compatibility, and recovery details.
