import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { DEFAULT_RRF_K, fuse } from "../src/rrf.ts";

describe("fuse", () => {
  it("puts an item both rankers liked above one only a single ranker found", () => {
    const fused = fuse([
      { name: "lexical", ids: [1, 2, 3] },
      { name: "vector", ids: [3, 1, 9] },
    ]);
    assert.equal(fused[0]?.id, 1);
    assert.deepEqual(fused[0]?.ranks, { lexical: 1, vector: 2 });
  });

  it("records the rank each ranker gave", () => {
    const fused = fuse([
      { name: "lexical", ids: [5] },
      { name: "vector", ids: [7, 5] },
    ]);
    const five = fused.find((entry) => entry.id === 5);
    assert.deepEqual(five?.ranks, { lexical: 1, vector: 2 });
    assert.deepEqual(fused.find((entry) => entry.id === 7)?.ranks, { vector: 1 });
  });

  it("scores by reciprocal rank", () => {
    const [first] = fuse([{ name: "only", ids: [42] }], 10);
    assert.ok(Math.abs((first?.score ?? 0) - 1 / 11) < 1e-12);
  });

  it("counts an id once per ranking even if it repeats", () => {
    const [entry] = fuse([{ name: "lexical", ids: [4, 4, 4] }]);
    assert.deepEqual(entry?.ranks, { lexical: 1 });
    assert.equal(Object.keys(entry?.ranks ?? {}).length, 1);
  });

  it("breaks ties on the lower id so the order is stable", () => {
    const fused = fuse([{ name: "a", ids: [9] }, { name: "b", ids: [2] }]);
    assert.deepEqual(fused.map((entry) => entry.id), [2, 9]);
  });

  it("returns nothing when every ranking is empty", () => {
    assert.deepEqual(fuse([{ name: "a", ids: [] }]), []);
    assert.deepEqual(fuse([]), []);
  });

  it("lets a larger k flatten the difference between the top places", () => {
    const tight = fuse([{ name: "a", ids: [1, 2] }], 1);
    const flat = fuse([{ name: "a", ids: [1, 2] }], 1000);
    const gap = (list: ReturnType<typeof fuse>) => (list[0]?.score ?? 0) - (list[1]?.score ?? 0);
    assert.ok(gap(flat) < gap(tight));
  });

  it("refuses a k that would divide by zero or worse", () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.throws(() => fuse([{ name: "a", ids: [1] }], bad), /rrf k/);
    }
  });

  it("uses 60 unless told otherwise", () => {
    assert.equal(DEFAULT_RRF_K, 60);
    assert.deepEqual(fuse([{ name: "a", ids: [1] }]), fuse([{ name: "a", ids: [1] }], 60));
  });
});
