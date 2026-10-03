import test from "node:test";
import assert from "node:assert/strict";

import {
  DynamicAabbIndex,
  DynamicPointIndex,
  StaticGeometryIndex
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


test("DynamicAabbIndex rejects invalid bounds before mutating existing entries", () => {
  const index = new DynamicAabbIndex(8);
  const original = {
    minX: 1,
    minY: 2,
    maxX: 3,
    maxY: 4
  };
  index.set("box", original);

  assert.throws(
    () => index.set("box", {
      minX: Number.NaN,
      minY: 0,
      maxX: 1,
      maxY: 1
    }),
    /finite bounds/
  );
  assert.deepEqual(index.getBounds("box"), original);

  assert.throws(
    () => index.queryBounds({
      minX: 5,
      minY: 0,
      maxX: 4,
      maxY: 1
    }),
    /ordered bounds/
  );
  assert.throws(
    () => index.queryPoint({
      x: Number.NaN,
      y: 0
    }),
    /finite Vec2/
  );
});


test("DynamicAabbIndex stores huge items without materializing covered empty cells", () => {
  const index = new DynamicAabbIndex(64);
  const huge = {
    minX: -1_000_000_000_000,
    minY: -1_000_000_000_000,
    maxX: 1_000_000_000_000,
    maxY: 1_000_000_000_000
  };

  index.set("world-sized", huge);

  assert.equal(index.size, 1);
  assert.equal(index.cellCount, 0);
  assert.equal(index.largeItemCount, 1);
  assert.deepEqual(
    index.queryPoint({ x: 0, y: 0 }),
    ["world-sized"]
  );
  assert.deepEqual(
    index.queryBounds({
      minX: 100,
      minY: 100,
      maxX: 101,
      maxY: 101
    }),
    ["world-sized"]
  );

  index.set("world-sized", {
    minX: 0,
    minY: 0,
    maxX: 1,
    maxY: 1
  });
  assert.equal(index.largeItemCount, 0);
  assert.ok(index.cellCount > 0);

  index.delete("world-sized");
  assert.equal(index.size, 0);
  assert.equal(index.cellCount, 0);
});

test("StaticGeometryIndex keeps huge geometry in a sparse fallback", () => {
  const index = new StaticGeometryIndex(
    [{
      id: "world-sized",
      geometry: {
        type: "aabb",
        minX: -1_000_000_000_000,
        minY: -1_000_000_000_000,
        maxX: 1_000_000_000_000,
        maxY: 1_000_000_000_000
      }
    }],
    { cellSize: 8 }
  );

  assert.equal(index.cellCount, 0);
  assert.equal(index.largeItemCount, 1);
  assert.deepEqual(
    index
      .queryPoint({ x: 123, y: -456 })
      .map((item) => item.id),
    ["world-sized"]
  );
});


test("StaticGeometryIndex cannot query against geometry different from its index", () => {
  const item = {
    id: "shifted",
    geometry: {
      type: "aabb",
      minX: 0,
      minY: 0,
      maxX: 1,
      maxY: 1
    }
  };

  const index = new StaticGeometryIndex(
    [item],
    {
      cellSize: 1
    }
  );

  assert.deepEqual(
    index.queryPoint(
      { x: 0.5, y: 0.5 },
      null,
      () => ({
        type: "aabb",
        minX: 100,
        minY: 100,
        maxX: 101,
        maxY: 101
      })
    ),
    [item],
    "extra legacy arguments must not replace the geometry used to build the index"
  );

  assert.deepEqual(
    index.queryPoint({
      x: 100.5,
      y: 100.5
    }),
    []
  );
});


test("StaticGeometryIndex reuses its constructor geometry accessor by default", () => {
  const items = [{
    id: "custom",
    shape: {
      type: "aabb",
      minX: 0,
      minY: 0,
      maxX: 4,
      maxY: 4
    }
  }];

  const index = new StaticGeometryIndex(
    items,
    {
      geometryOf: (item) => item.shape
    }
  );

  assert.deepEqual(
    index.queryPoint({ x: 2, y: 2 }),
    items
  );
  assert.deepEqual(
    index.queryPoint({ x: 10, y: 10 }),
    []
  );
});


test("DynamicPointIndex radius and nearest remain correct when squared distances overflow", () => {
  const index = new DynamicPointIndex(64);
  index.set("near", { x: 1e200, y: 0 });
  index.set("far", { x: 2e200, y: 0 });

  assert.deepEqual(
    index
      .queryRadius(
        { x: 0, y: 0 },
        1.5e200
      )
      .map((hit) => hit.id),
    ["near"]
  );

  assert.equal(
    index.findNearest({ x: 0, y: 0 }).id,
    "near"
  );
});


test("DynamicPointIndex orders overflowed nearest distances correctly", () => {
  const index = new DynamicPointIndex(64);

  index.set("a-far", {
    x: 1e308,
    y: 0
  });
  index.set("z-near", {
    x: 9e307,
    y: 0
  });

  const result = index.findNearest(
    { x: -1e308, y: 0 },
    {
      compareIds: (a, b) =>
        String(a).localeCompare(String(b))
    }
  );

  assert.ok(result);
  assert.equal(result.id, "z-near");
});


test("DynamicPointIndex nearest search survives overflowed cell coordinates", () => {
  const index = new DynamicPointIndex(1e-308);

  index.set("a-far", {
    x: 0,
    y: 0
  });
  index.set("z-near", {
    x: 9e307,
    y: 0
  });

  const result = index.findNearest(
    { x: 1e308, y: 0 },
    {
      compareIds: (a, b) =>
        String(a).localeCompare(String(b))
    }
  );

  assert.ok(result);
  assert.equal(result.id, "z-near");

  assert.deepEqual(
    index.queryRadius(
      { x: 1e308, y: 0 },
      2e307
    ).map((hit) => hit.id),
    ["z-near"]
  );

  assert.equal(
    index.delete("z-near"),
    true
  );
  assert.equal(
    index.findNearest(
      { x: 1e308, y: 0 }
    )?.id,
    "a-far"
  );
});
