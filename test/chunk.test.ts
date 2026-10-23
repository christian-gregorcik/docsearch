import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { chunk } from "../src/chunk.ts";
import { BadRequestError } from "../src/errors.ts";

describe("chunk", () => {
  it("keeps a short document in one piece", () => {
    const text = "One short paragraph that fits comfortably.";
    const pieces = chunk(text, { maxChars: 200, overlapChars: 20 });
    assert.equal(pieces.length, 1);
    assert.equal(pieces[0]?.text, text);
    assert.equal(pieces[0]?.start, 0);
    assert.equal(pieces[0]?.end, text.length);
  });

  it("reports offsets that point back into the source", () => {
    const text = "First paragraph here.\n\nSecond paragraph here.\n\nThird paragraph here.";
    for (const piece of chunk(text, { maxChars: 30, overlapChars: 0 })) {
      assert.equal(text.slice(piece.start, piece.end), piece.text);
    }
  });

  it("numbers chunks from zero and in order", () => {
    const text = Array.from({ length: 8 }, (_, i) => `Paragraph number ${i}.`).join("\n\n");
    const pieces = chunk(text, { maxChars: 40, overlapChars: 0 });
    assert.ok(pieces.length > 1);
    assert.deepEqual(
      pieces.map((piece) => piece.index),
      pieces.map((_, i) => i),
    );
  });

  it("covers the whole document when there is no overlap", () => {
    const text = "Alpha beta gamma.\n\nDelta epsilon zeta.\n\nEta theta iota.";
    const pieces = chunk(text, { maxChars: 25, overlapChars: 0 });
    const covered = pieces.map((piece) => piece.text).join(" ").replace(/\s+/g, " ");
    for (const word of ["Alpha", "gamma", "Delta", "zeta", "Eta", "iota"]) {
      assert.ok(covered.includes(word), `${word} went missing`);
    }
  });

  it("repeats the tail of the previous chunk when asked to overlap", () => {
    const text = "Alpha beta gamma delta.\n\nEpsilon zeta eta theta.\n\nIota kappa lambda mu.";
    const pieces = chunk(text, { maxChars: 30, overlapChars: 15 });
    assert.ok(pieces.length > 1);
    const second = pieces[1];
    assert.ok(second !== undefined);
    assert.ok(second.start < (pieces[0]?.end ?? 0), "second chunk should start inside the first");
  });

  it("splits a paragraph that is too long on sentence boundaries", () => {
    const text = "One sentence here. Another sentence here. A third sentence here. A fourth one too.";
    const pieces = chunk(text, { maxChars: 45, overlapChars: 0 });
    assert.ok(pieces.length >= 2);
    for (const piece of pieces) assert.ok(piece.text.length <= 45 + 1, piece.text);
  });

  it("falls back to word boundaries when a sentence is still too long", () => {
    const text = `${"word ".repeat(60).trim()}.`;
    const pieces = chunk(text, { maxChars: 50, overlapChars: 0 });
    assert.ok(pieces.length > 1);
    for (const piece of pieces) assert.ok(piece.text.length <= 55, String(piece.text.length));
  });

  it("never opens a chunk in the middle of a word", () => {
    const text = "Alphabetical ordering matters.\n\nBeautifully constructed sentences follow.\n\nCertainly they do.";
    for (const piece of chunk(text, { maxChars: 40, overlapChars: 20 })) {
      if (piece.start === 0) continue;
      assert.ok(/\s/.test(text[piece.start - 1] as string), JSON.stringify(piece.text.slice(0, 12)));
    }
  });

  it("returns nothing for blank input", () => {
    assert.deepEqual(chunk("   \n\n  "), []);
    assert.deepEqual(chunk(""), []);
  });

  it("rejects settings that cannot work", () => {
    assert.throws(() => chunk("text", { maxChars: 0 }), BadRequestError);
    assert.throws(() => chunk("text", { maxChars: 1.5 }), BadRequestError);
    assert.throws(() => chunk("text", { overlapChars: -1 }), BadRequestError);
    assert.throws(() => chunk("text", { maxChars: 10, overlapChars: 10 }), BadRequestError);
  });
});
