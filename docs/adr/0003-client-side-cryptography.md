# ADR 0003: Client-side cryptography

Status: accepted
Date: 2026-09-05
Owners: Statecase maintainers
Test IDs: CR-001 through CR-010

## Context

Statecase must synchronize untrusted agent state through infrastructure that
cannot read payload contents. The format needs misuse-resistant nonces,
streamable independent objects, password-based recovery, deterministic
scope-local deduplication, and a reviewed implementation available to Node.

## Decision

Use libsodium's XChaCha20-Poly1305-IETF AEAD for object envelopes and Argon2id
for passphrase-derived recovery keys. Generate random 192-bit nonces per
envelope. Authenticate a canonical header as AAD. Derive subkeys with keyed
BLAKE2b and compute scope-local object IDs with keyed BLAKE2b over plaintext.

Payload encryption and decryption happen only on clients. The Worker stores and
coordinates opaque envelopes. The initial Node implementation uses
`libsodium-wrappers-sumo`; no custom cryptographic primitive is permitted.

## Alternatives considered

- AES-256-GCM through WebCrypto: portable, but its shorter nonce makes random
  nonce misuse less forgiving at large object counts.
- Restic repositories: strong backup encryption, but not the application-level
  object and merge protocol Statecase requires.
- Unkeyed content hashes: permit cross-vault content correlation.

## Consequences

The CLI carries a WASM/native-sized dependency and must await sodium
initialization. Object formats remain independently versioned so the primitive
can be migrated without rewriting history.

## Security and privacy impact

Keys and plaintext never enter remote APIs or logs. Each vault has a random
root key; per-namespace keys prevent cross-scope correlation. Authentication
failure is terminal for that object and produces no plaintext.

## Compatibility and migration

Envelope version 1 fixes algorithm identifiers, header encoding, nonce length,
and derivation contexts. Readers reject unknown required versions.

## Verification

CR-001 through CR-010, published vectors, mutation tests, wrong-scope tests,
redacted-error tests, and cross-Node/Docker vectors must pass.
