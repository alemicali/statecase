# ADR 0019: Vault key epochs and device rewrap

Status: accepted
Date: 2026-09-07
Owners: Statecase maintainers
Test IDs: CR-009, CR-010, AU-008, UAT-09

## Context

Server-side device revocation prevents a lost installation from making new
authorized requests, but it does not revoke encryption material that the
installation already received. Re-encrypting the same vault root key for the
remaining devices would therefore be access-control rotation, not
cryptographic revocation. Statecase also has immutable historical ciphertext:
remaining devices must retain the old keys needed to read and restore it.

Rotation is a high-risk remote mutation. A lost HTTP response after a committed
rotation must not cause the client to delete the only new recovery artifact or
mistake another device's concurrent rotation for its own.

## Decision

Every persistent installation creates an X25519-compatible exchange keypair
locally. D1 stores only the tagged public key. The private key remains in the
owner-only local credential store. Once registered, an exchange public key is
immutable for that device ID (enforced in D1); registration without a public
key preserves the existing one. Replacing an exchange key requires a new
installation identity, so an envelope recipient cannot silently change keys
between recipient discovery and rotation.

Every vault has a monotonically increasing positive `key_epoch`, beginning at
one. A rotation:

1. generates a new independent random 256-bit vault root key;
2. creates a sealed-box envelope for each and only each active vault member
   that has a public exchange key;
3. atomically inserts all envelopes, advances the epoch by exactly one,
   revokes every outstanding vault capability and capability session, and
   writes an audit event;
4. excludes revoked devices and rejects incomplete, duplicate, stale, or
   otherwise mismatched recipient sets.

D1 constraints and triggers re-evaluate the active recipient set inside the
same transaction. A membership or epoch race therefore aborts the complete
batch; envelope insertion also rechecks that the issuer is still an active
owner. Infrastructure/transport errors are not classified as definitive
recipient rejection: they remain ambiguous 5xx responses so clients retain
candidate recovery material. The cloud never receives a plaintext vault key.

Protocol 1.1 namespace heads, revisions, manifests, and file entries carry the
epoch that encrypted them. Clients retain a local keyring so immutable history
remains readable. An append chain cannot cross an epoch boundary: the first
write under a new epoch is a complete namespace snapshot. The Worker rejects
old-epoch namespace commits and disables legacy protocol 1.0 commits after the
first rotation.

The vault Durable Object orders commits and rotations, rechecking D1 at the
commit boundary rather than trusting an earlier HTTP check. Before dispatching
the D1 rotation transaction it persists a monotonic minimum writable epoch.
Commits fail closed whenever D1 is below that floor. A timeout/reset or delayed
D1 result therefore cannot reopen the old epoch. The floor is never rolled
back: if recipient membership races the transaction, an authorized owner
retries a valid rotation to the same next epoch to complete the transition.
Preflight-invalid recipient sets do not advance the floor. The short ordered
section uses Cloudflare's
[blockConcurrencyWhile contract](https://developers.cloudflare.com/durable-objects/api/state/);
its reset/timeout behavior is why the floor is durable, not merely in memory.

Clients authenticate historical entries and recompute their keyed content
digests at the current epoch before three-way comparison. Object IDs, key
epochs, and chunk layouts are storage details, not file edits; semantic
metadata (including file modes) remains part of equality. A selected historical
entry is re-encrypted before publication, including unchanged files. Preview
may read and stage verified data but does not upload new ciphertext or advance
heads. Historical harness restore retains the original Session Capsule pins.

An active device requests its envelopes after its last local epoch and unwraps
them sequentially. A missing or non-contiguous epoch fails closed. Version-two
recovery kits encrypt the entire historical keyring and identify the current
epoch; joining with a stale kit is rejected before membership is added or the
kit becomes local authority. Membership insertion records and transactionally
checks the recovery epoch and active installation; an HTTP preflight check is
not sufficient. An omitted request epoch means one for legacy clients.
Version-one epoch-one kits remain readable for unrotated vaults.

History ingestion authenticates the complete response before replacing local
credentials once. It never advances the caller's epoch/map incrementally.
Schema, sequence, authentication, network, and persistence failures wipe owned
decoded buffers and leave the persisted prior authority intact. Local full-key
rings require canonical base64url 32-byte roots and a contiguous epoch sequence,
bounded to 1,000 retained epochs consistently with the recovery format. Commands
derive capabilities from the keyring's current root, not its legacy alias.
Command-owned decoded root buffers are released on preflight failures too;
historical rekey and append-merge scope buffers are released even if download
or temporary-stage cleanup fails. This is bounded buffer ownership hygiene,
not a claim that JavaScript strings, library copies, or process memory can all
be securely erased.

The rotating client writes a new exclusive, owner-only recovery kit before the
remote mutation. If the mutation response is lost, it queries the authoritative
epoch and decrypts its own proposed-epoch envelope from history, then compares that key with the
candidate key in constant time. It accepts the rotation only on an exact match.
It locates that proposed epoch in the retained envelope history even when a
later rotation has already superseded it; the next sync ingests newer epochs.
If reconciliation is unavailable, it preserves the recovery kit, does not
advance local credentials, and reports an unknown outcome. A definitive
rejection removes only the newly created unused candidate kit. An existing
file at the requested recovery path is never overwritten or removed.

Capability envelopes bind their namespace keys to one key epoch. Creation is
rejected when the requested epoch is stale or when any requested namespace has
not yet been republished under the current epoch. Rotation revokes existing
grants and sessions before new scoped access can be issued.
D1 stores the grant epoch and checks both the current epoch and active owner
identity inside the grant insertion transaction. A grant request that passed
HTTP authorization before rotation cannot insert an old-epoch grant afterward.

## Alternatives considered

- Rewrap the existing root key: the revoked device would keep the same future
  decryption authority, so this does not solve the threat.
- Re-encrypt every historical object immediately: expensive, destroys stable
  content addressing, and increases the destructive failure surface.
- Delete old keys on remaining devices: makes historical restore and Session
  Capsule hydration impossible.
- Trust the rotation HTTP response alone: cannot distinguish a pre-commit
  network failure from a committed mutation whose response was lost.
- Let the server generate or escrow the new root: violates Statecase's E2EE
  boundary.

## Consequences

New data written after a completed rotation is unavailable to the revoked
device even if it retains its old vault key. Historical ciphertext continues
to use its original epoch and remains restorable by trusted keyring holders.
The next trusted push republishes each configured writable namespace under the
new epoch; until then the CLI reports `rekeyPending` and refuses new
capabilities for stale namespaces.

Existing installations created before exchange keys were introduced must run
`statecase login` again before an owner can rotate a vault containing them.
Rotation intentionally fails rather than omitting such an active member.

Rotation cannot erase plaintext, old keys, or ciphertext already copied by a
lost device. It also cannot protect future plaintext if the device remains
fully compromised and is not revoked. Those limits remain explicit in the
threat model.

## Verification

CR-009 and CR-010 cover tagged key generation, sealed-box round trips, wrong
recipient/context rejection, exact-recipient D1 rollback, epoch-gated commits,
capability revocation, sequential active-device refresh, stale recovery kits,
revoked-device denial, response-loss reconciliation, and unknown-outcome kit
preservation. UAT-09 must repeat the flow through the packaged CLI and live
Cloudflare bindings, then remove all disposable identities and data.
