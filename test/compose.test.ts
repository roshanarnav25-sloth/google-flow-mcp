import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { asbToken } from "../src/services/compose.js";
import { isCompleteMp4 } from "../src/services/scene.js";

describe("asb image token extraction", () => {
  it("reads the same token from the grid and picker hosts", () => {
    const token = "AB-nOUa9iKgd4aMxdEJT_iBxyfD2iXKU";
    assert.equal(asbToken(`https://flow.google.com/asb/${token}=s1600-rw`), token);
    assert.equal(asbToken(`https://lh3.googleusercontent.com/asb/${token}=w400-h225`), token);
  });

  it("ignores query strings and urls without a token", () => {
    assert.equal(asbToken("https://lh3.googleusercontent.com/asb/ABC123?foo=bar"), "ABC123");
    assert.equal(asbToken("https://flow-content.google/image/15e471c5-b40b-47f7-9082-0b12d024bc00"), null);
    assert.equal(asbToken(null), null);
  });
});

describe("mp4 completeness", () => {
  const box = (type: string, body = 0) => {
    const b = Buffer.alloc(8 + body);
    b.writeUInt32BE(8 + body, 0);
    b.write(type, 4, "latin1");
    return b;
  };

  it("accepts ftyp + moov + mdat ending exactly at the end", () => {
    assert.equal(isCompleteMp4(Buffer.concat([box("ftyp", 8), box("moov", 16), box("mdat", 32)])), true);
  });

  it("rejects a file cut off mid-box", () => {
    const whole = Buffer.concat([box("ftyp", 8), box("moov", 16), box("mdat", 32)]);
    assert.equal(isCompleteMp4(whole.subarray(0, whole.length - 5)), false);
  });

  it("rejects a file with no moov, or not starting with ftyp", () => {
    assert.equal(isCompleteMp4(Buffer.concat([box("ftyp", 8), box("mdat", 32)])), false);
    assert.equal(isCompleteMp4(Buffer.concat([box("moov", 16), box("ftyp", 8)])), false);
  });
});
