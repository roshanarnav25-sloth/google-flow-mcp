import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { pairTokensFromRpc } from "../src/services/media.js";

const CLIP = "270ee87c-f8fe-4b60-8090-9e45edc97e6c";
const EDIT = "6684f218-fea6-4443-af86-25715a28337f";
const IMG = "15e471c5-b40b-47f7-9082-0b12d024bc00";
const thumb = (t: string) => `https://flow.google.com/asb/${t}=s1600-rw`;

/** Shaped like the live media-list response: wrb.fr envelope, JSON-in-a-string payload. */
function body(payload: unknown): string {
  const inner = JSON.stringify(payload);
  const chunk = JSON.stringify([["wrb.fr", "Zzl0ze", inner, null, null, null, "generic"]]);
  return `)]}'\n\n${chunk.length}\n${chunk}\n25\n[["e",4,null,null,123]]\n`;
}

describe("media-list rpc pairing", () => {
  it("pairs each entry's thumbnail token with its media id and editor id", () => {
    const entry = (id: string, edit: string | null, tok: string) => [
      id,
      null,
      edit,
      null,
      null,
      [null, null, null, null, null, thumb(tok), null, null, null, null, thumb(tok)],
    ];
    const pairs = pairTokensFromRpc(body([null, null, [entry(CLIP, EDIT, "TOKclip"), entry(IMG, null, "TOKimg")]]));
    const byToken = Object.fromEntries(pairs.map((p) => [p.token, p]));
    assert.deepEqual(byToken.TOKclip, { token: "TOKclip", mediaId: CLIP, editId: EDIT });
    assert.deepEqual(byToken.TOKimg, { token: "TOKimg", mediaId: IMG, editId: null });
  });

  it("does not credit a referenced id with the entry's own thumbnail", () => {
    // A clip entry that references its source still by id, deeper down.
    const clip = [
      CLIP,
      null,
      EDIT,
      null,
      null,
      [null, null, null, null, null, thumb("TOKclip"), [null, [null, [[null, null, IMG]]]]],
    ];
    const pairs = pairTokensFromRpc(body([null, null, [clip]]));
    assert.equal(pairs.find((p) => p.token === "TOKclip")?.mediaId, CLIP);
  });

  it("drops a token claimed by two different ids", () => {
    const a = [CLIP, null, null, [thumb("SHARED")]];
    const b = [IMG, null, null, [thumb("SHARED")]];
    assert.equal(pairTokensFromRpc(body([[a, b]])).length, 0);
  });

  it("ignores bodies that are not batchexecute JSON", () => {
    assert.deepEqual(pairTokensFromRpc("<html>sign in</html>"), []);
  });
});
