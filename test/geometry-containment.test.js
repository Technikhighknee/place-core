import test from "node:test";
import assert from "node:assert/strict";

import {
  compilePlace,
  geometryContainsGeometry,
  pointInGeometry
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
