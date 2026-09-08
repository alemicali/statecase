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
kit. Native macOS support and recovery/downgrade workflows remain unfinished.

See the [repository documentation](https://github.com/alemicali/statecase#readme) for
setup, threat-model, compatibility, and recovery details.
