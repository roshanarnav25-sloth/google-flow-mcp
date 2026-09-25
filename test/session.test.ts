import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseCredits } from "../src/services/session.js";

describe("credit balance parsing", () => {
  it("reads the account panel's wording", () => {
    assert.equal(parseCredits("50 Google Flow credits"), 50);
    assert.equal(parseCredits("1,250 Google Flow credits"), 1250);
  });

  it("reads the legacy 'credits remaining' wording", () => {
    assert.equal(parseCredits("You have 300 credits remaining"), 300);
  });

  it("never mistakes the composer's price quote for a balance", () => {
    assert.equal(parseCredits("Generating will use 20 credits"), null);
    assert.equal(parseCredits("Video Veo 3.1 - Fast 16:9 x1 Generating will use 20 credits"), null);
  });

  it("returns null when nothing credit-shaped is present", () => {
    assert.equal(parseCredits(""), null);
  });
});
