import test from "node:test";
import assert from "node:assert/strict";

import {
  compilePlace,
  PlaceRegistry,
  composeTransforms,
  geometryBounds,
  geometryContainsGeometry,
  inverseTransformPoint,
  pointInGeometry,
  segmentIntersectsBounds,
  squaredDistancePointToSegment,
  transformPoint
} from "../src/index.js";

test("nested AABB spaces must be fully contained by their parent", () => {
  assert.throws(
    () => compilePlace({
      id: "bad-nested-aabb",
      layers: [{ id: "ground" }],
      spaces: [
        {
          id: "parent",
          layerId: "ground",
          geometry: {
            type: "aabb",
            minX: 0,
            minY: 0,
            maxX: 10,
            maxY: 10
          }
        },
        {
          id: "child",
          layerId: "ground",
          parentSpaceId: "parent",
          geometry: {
            type: "aabb",
            minX: 8,
            minY: 8,
            maxX: 12,
            maxY: 9
          }
        }
      ]
    }),
    /geometry is not fully contained by parent/
  );
});

test("concave parent containment checks child edges, not only vertices", () => {
  const parent = {
    type: "polygon",
    points: [
      { x: 0, y: 0 },
      { x: 4, y: 0 },
      { x: 4, y: 4 },
      { x: 3, y: 4 },
      { x: 3, y: 1 },
      { x: 1, y: 1 },
      { x: 1, y: 4 },
      { x: 0, y: 4 }
    ]
  };
  const child = {
    type: "polygon",
    points: [
      { x: 0.5, y: 3.5 },
      { x: 3.5, y: 3.5 },
      { x: 0.5, y: 3 }
    ]
  };

  // Every child vertex is individually inside one of the U-shape arms,
  // but the long top edge crosses the open notch.
  assert.equal(
    geometryContainsGeometry(parent, child),
    false
  );

  assert.throws(
    () => compilePlace({
      id: "bad-concave-child",
      layers: [{ id: "ground" }],
      spaces: [
        {
          id: "parent",
          layerId: "ground",
          geometry: parent
        },
        {
          id: "child",
          layerId: "ground",
          parentSpaceId: "parent",
          geometry: child
        }
      ]
    }),
    /geometry is not fully contained by parent/
  );
});

test("circle containment is exact across supported parent geometry types", () => {
  assert.equal(
    geometryContainsGeometry(
      {
        type: "aabb",
        minX: 0,
        minY: 0,
        maxX: 10,
        maxY: 10
      },
      {
        type: "circle",
        center: { x: 5, y: 5 },
        radius: 5
      }
    ),
    true
  );

  assert.equal(
    geometryContainsGeometry(
      {
        type: "circle",
        center: { x: 0, y: 0 },
        radius: 10
      },
      {
        type: "circle",
        center: { x: 7, y: 0 },
        radius: 4
      }
    ),
    false
  );

  assert.equal(
    geometryContainsGeometry(
      {
        type: "polygon",
        points: [
          { x: 0, y: 0 },
          { x: 10, y: 0 },
          { x: 10, y: 10 },
          { x: 0, y: 10 }
        ]
      },
      {
        type: "circle",
        center: { x: 5, y: 5 },
        radius: 4.9
      }
    ),
    true
  );

  assert.equal(
    geometryContainsGeometry(
      {
        type: "polygon",
        points: [
          { x: 0, y: 0 },
          { x: 10, y: 0 },
          { x: 10, y: 10 },
          { x: 0, y: 10 }
        ]
      },
      {
        type: "circle",
        center: { x: 5, y: 5 },
        radius: 5.1
      }
    ),
    false
  );
});

test("valid nested mixed geometry compiles", () => {
  const definition = compilePlace({
    id: "valid-nested-geometry",
    layers: [{ id: "ground" }],
    spaces: [
      {
        id: "hall",
        layerId: "ground",
        geometry: {
          type: "circle",
          center: { x: 0, y: 0 },
          radius: 10
        }
      },
      {
        id: "table-area",
        layerId: "ground",
        parentSpaceId: "hall",
        geometry: {
          type: "polygon",
          points: [
            { x: -2, y: -2 },
            { x: 2, y: -2 },
            { x: 2, y: 2 },
            { x: -2, y: 2 }
          ]
        }
      }
    ]
  });

  assert.equal(
    definition.getSpaceDepth("table-area"),
    1
  );
});


test("large finite circle distances do not become Infinity-squared false positives", () => {
  const hugeCircle = {
    type: "circle",
    center: { x: 0, y: 0 },
    radius: 1e200
  };

  assert.equal(
    pointInGeometry(
      { x: 2e200, y: 0 },
      hugeCircle
    ),
    false
  );
  assert.equal(
    geometryContainsGeometry(
      hugeCircle,
      {
        type: "circle",
        center: { x: 2e200, y: 0 },
        radius: 1
      }
    ),
    false
  );
});


test("circle bounds reject finite inputs whose derived bounds overflow", () => {
  assert.throws(
    () => geometryBounds({
      type: "circle",
      center: {
        x: 1e308,
        y: 0
      },
      radius: 1e308
    }),
    /finite.*bounds|bounds.*finite/i
  );
});


test("point-to-segment distance survives finite coordinate subtraction overflow", () => {
  assert.equal(
    squaredDistancePointToSegment(
      { x: 0, y: 0 },
      { x: -1e308, y: 0 },
      { x: 1e308, y: 0 }
    ),
    0
  );

  const squared = squaredDistancePointToSegment(
    { x: 0, y: 1 },
    { x: -1e308, y: 0 },
    { x: 1e308, y: 0 }
  );
  assert.ok(
    Math.abs(squared - 1) <= 1e-12
  );
});


test("polygon containment survives finite cross-product overflow", () => {
  const triangle = {
    type: "polygon",
    points: [
      { x: -1e308, y: -1e308 },
      { x: 1e308, y: 1e308 },
      { x: 1e308, y: -1e308 }
    ]
  };

  assert.equal(
    pointInGeometry(
      { x: 0, y: 1e307 },
      triangle
    ),
    false
  );
  assert.equal(
    pointInGeometry(
      { x: 0, y: -1e307 },
      triangle
    ),
    true
  );
});


test("transform helpers survive finite intermediate overflow when the result is finite", () => {
  const transform = {
    x: -1e308,
    y: 0,
    rotation: 0,
    scale: 1e308
  };

  assert.deepEqual(
    transformPoint(
      { x: 2, y: 0 },
      transform
    ),
    { x: 1e308, y: 0 }
  );

  assert.deepEqual(
    inverseTransformPoint(
      { x: 1e308, y: 0 },
      transform
    ),
    { x: 2, y: 0 }
  );
});


test("composeTransforms survives finite rotation-sum overflow", () => {
  const parent = {
    x: 0,
    y: 0,
    rotation: 1e308,
    scale: 1
  };
  const child = {
    x: 0,
    y: 0,
    rotation: 1e308,
    scale: 1
  };

  const composed =
    composeTransforms(parent, child);

  assert.equal(
    Number.isFinite(composed.rotation),
    true
  );

  const point = { x: 1, y: 0 };
  const sequential = transformPoint(
    transformPoint(point, child),
    parent
  );
  const direct = transformPoint(
    point,
    composed
  );

  assert.ok(
    Math.abs(direct.x - sequential.x) <= 1e-12
  );
  assert.ok(
    Math.abs(direct.y - sequential.y) <= 1e-12
  );
});


test("segment-bounds intersection survives finite subtraction overflow", () => {
  const a = {
    x: -1e308,
    y: -1e308
  };
  const b = {
    x: 1e308,
    y: 1e308
  };

  assert.equal(
    segmentIntersectsBounds(
      a,
      b,
      {
        minX: 8.9e307,
        minY: -9.1e307,
        maxX: 9.1e307,
        maxY: -8.9e307
      }
    ),
    false
  );

  assert.equal(
    segmentIntersectsBounds(
      a,
      b,
      {
        minX: -1e307,
        minY: -1e307,
        maxX: 1e307,
        maxY: 1e307
      }
    ),
    true
  );
});


test("deep space enablement remains scalable and invalidates after overrides", () => {
  const depth = 3_000;
  const spaces = Array.from(
    { length: depth },
    (_, index) => ({
      id: `space-${index}`,
      layerId: "inside",
      parentSpaceId:
        index === 0
          ? null
          : `space-${index - 1}`,
      geometry: {
        type: "aabb",
        minX: 0,
        minY: 0,
        maxX: 1,
        maxY: 1
      }
    })
  );

  const definition = compilePlace({
    id: "deep-space-enablement",
    layers: [{ id: "inside" }],
    spaces
  });

  const places = new PlaceRegistry();
  places.registerDefinition(definition);
  const place = places.createPlace({
    id: "deep-place",
    definitionId: definition.id
  });
  const domainId =
    place.layerDomains.get("inside");

  assert.equal(
    places.locate(
      domainId,
      { x: 0.5, y: 0.5 }
    ).spaces.length,
    depth
  );

  places.setSpaceState(
    "deep-place",
    "space-0",
    { enabled: false }
  );

  assert.equal(
    places.locate(
      domainId,
      { x: 0.5, y: 0.5 }
    ).spaces.length,
    0
  );

  assert.equal(
    places.getSpace(
      "deep-place",
      `space-${depth - 1}`
    ).enabled,
    false
  );
});
