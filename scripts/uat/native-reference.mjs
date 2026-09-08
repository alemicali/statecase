import assert from "node:assert/strict";

// Test-only encrypted object transport; never bundled into the product CLI.
export function referenceTransport(canary) {
  const objects = new Map(), heads = new Map(), revisions = new Map(), checkpoints = new Map();
  let head = null;
  return { objectCount: () => objects.size, fetch: async (input, init) => {
    const url = new URL(input);
    let match = /\/namespaces\/([^/]+)\/objects\/([^/]+)$/u.exec(url.pathname);
    if (match) {
      const objectKey = `${decodeURIComponent(match[1])}\0${match[2]}`;
      if (init?.method === "PUT") {
        const bytes = new Uint8Array(await new Response(init.body).arrayBuffer());
        assert.ok(!new TextDecoder().decode(bytes).includes(canary), "plaintext canary reached object storage");
        objects.set(objectKey, bytes);
        return Response.json({ created: true, size: bytes.byteLength }, { status: 201 });
      }
      assert.ok(objects.has(objectKey));
      return new Response(objects.get(objectKey));
    }
    match = /\/namespaces\/([^/]+)\/revisions\/([^/]+)$/u.exec(url.pathname);
    if (match) return Response.json(revisions.get(`${decodeURIComponent(match[1])}\0${match[2]}`));
    match = /\/scoped-revisions\/([^/]+)$/u.exec(url.pathname);
    if (match) return Response.json(checkpoints.get(match[1]));
    if (url.pathname.endsWith("/namespaces")) return Response.json({ revisionId: head, namespaces: [...heads.values()], commitProvenance: 1 });
    if (url.pathname.endsWith("/head")) return Response.json({ revisionId: null, manifestObjectId: null });
    if (url.pathname.endsWith("/namespace-commits")) {
      const request = JSON.parse(init.body);
      for (const update of request.updates) assert.equal(heads.get(update.namespace)?.revisionId ?? null, update.baseNamespaceRevisionId);
      for (const update of request.updates) {
        const previousRevisionId = heads.get(update.namespace)?.revisionId ?? null;
        const value = { namespace: update.namespace, revisionId: update.namespaceRevisionId, manifestObjectId: update.manifestObjectId, keyEpoch: update.keyEpoch ?? 1, commitMode: update.mode };
        heads.set(update.namespace, value);
        revisions.set(`${update.namespace}\0${update.namespaceRevisionId}`, { ...value, previousRevisionId });
      }
      const previousRevisionId = head;
      head = request.vaultRevisionId;
      checkpoints.set(head, { revisionId: head, previousRevisionId, namespaces: [...heads.values()] });
      return Response.json({ outcome: "committed", revisionId: head });
    }
    throw new Error("unsupported reference transport route");
  } };
}
