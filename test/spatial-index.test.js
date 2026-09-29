import test from "node:test";
import assert from "node:assert/strict";

import {
  DynamicAabbIndex,
  DynamicPointIndex
} from "../src/geometry.js";

test("DynamicAabbIndex huge sparse bounds query does not enumerate empty world cells", () => {
  const index = new DynamicAabbIndex(64);

  index.set("near", {
    minX: 0,
    minY: 0,
    maxX: 1,
    maxY: 1
  });
  index.set("far", {
    minX: 1_000_000_000_000,
    minY: -1_000_000_000_000,
    maxX: 1_000_000_000_001,
    maxY: -999_999_999_999
  });

  assert.deepEqual(
    new Set(index.queryBounds({
      minX: -1_000_000_000_001,
      minY: -1_000_000_000_001,
      maxX: 1_000_000_000_002,
      maxY: 1_000_000_000_002
    })),
    new Set(["near", "far"])
  );
});

test("DynamicPointIndex nearest search is independent of empty coordinate distance", () => {
  const index = new DynamicPointIndex(64);

  index.set("near", { x: 10, y: 0 });
  index.set("far", {
    x: 1_000_000_000_000,
    y: -1_000_000_000_000
  });

  assert.equal(
    index.findNearest({ x: 0, y: 0 }).id,
    "near"
  );

  index.delete("near");

  const result = index.findNearest({ x: 0, y: 0 });
  assert.ok(result);
  assert.equal(result.id, "far");
  assert.deepEqual(result.point, {
    x: 1_000_000_000_000,
    y: -1_000_000_000_000
  });
});

test("DynamicPointIndex terminates with null when every candidate is filtered", () => {
  const index = new DynamicPointIndex(64);

  for (let i = 0; i < 10_000; i += 1) {
    index.set(`p-${i}`, {
      x: i * 100_000,
      y: (i % 17) * 1_000_000
    });
  }

  assert.equal(
    index.findNearest(
      { x: 0, y: 0 },
      { predicate: () => false }
    ),
    null
  );
});

test("DynamicPointIndex radius query visits only occupied sparse cells", () => {
  const index = new DynamicPointIndex(64);

  index.set("a", { x: 10, y: 0 });
  index.set("b", { x: 1_000_000_000_000, y: 0 });
  index.set("outside", { x: 2_000_000_000_000, y: 0 });

  assert.deepEqual(
    new Set(
      index.queryRadius(
        { x: 0, y: 0 },
        1_000_000_000_001
      ).map((hit) => hit.id)
    ),
    new Set(["a", "b"])
  );
});

test("DynamicPointIndex updates and deletes without stale nearest entries", () => {
  const index = new DynamicPointIndex(8);

  index.set("moving", { x: 1, y: 1 });
  index.set("other", { x: 20, y: 20 });

  assert.equal(
    index.findNearest({ x: 0, y: 0 }).id,
    "moving"
  );

  index.set("moving", { x: 100, y: 100 });

  assert.equal(
    index.findNearest({ x: 0, y: 0 }).id,
    "other"
  );

  index.delete("other");

  assert.equal(
    index.findNearest({ x: 0, y: 0 }).id,
    "moving"
  );

  index.delete("moving");
  assert.equal(index.findNearest({ x: 0, y: 0 }), null);
  assert.equal(index.size, 0);
  assert.equal(index.cellCount, 0);
});
