import test from "node:test";
import assert from "node:assert/strict";

import {
  compilePlace,
  composeTransforms,
  pointInGeometry,
  squaredDistancePointToSegment,
  transformPoint
} from "../src/index.js";

function compileWithPolygon(id, points) {
  return compilePlace({
    id,
    layers: [{ id: "ground" }],
    spaces: [{
      id: "room",
      layerId: "ground",
      geometry: {
        type: "polygon",
        points
      }
    }]
  });
}

test("polygon spaces reject zero-area geometry", () => {
  assert.throws(
    () => compileWithPolygon(
      "zero-area",
      [
        { x: 0, y: 0 },
        { x: 1, y: 0 },
        { x: 2, y: 0 }
      ]
    ),
    /non-zero area/
  );
});

test("polygon spaces reject repeated closing points", () => {
  assert.throws(
    () => compileWithPolygon(
      "repeated-closing",
      [
        { x: 0, y: 0 },
        { x: 2, y: 0 },
        { x: 2, y: 2 },
        { x: 0, y: 2 },
        { x: 0, y: 0 }
      ]
    ),
    /zero-length edges or repeated closing points/
  );
});

test("polygon spaces reject self-intersections even with non-zero signed area", () => {
  assert.throws(
    () => compileWithPolygon(
      "self-intersection",
      [
        { x: 0, y: 0 },
        { x: 3, y: 3 },
        { x: 0, y: 3 },
        { x: 3, y: 0 },
        { x: 1, y: -1 }
      ]
    ),
    /simple and cannot self-intersect/
  );
});

test("valid concave polygons remain supported", () => {
  const definition = compileWithPolygon(
    "valid-concave",
    [
      { x: 0, y: 0 },
      { x: 4, y: 0 },
      { x: 4, y: 4 },
      { x: 3, y: 4 },
      { x: 3, y: 1 },
      { x: 1, y: 1 },
      { x: 1, y: 4 },
      { x: 0, y: 4 }
    ]
  );

  assert.equal(
    definition.getSpace("room").geometry.type,
    "polygon"
  );
});


test("degenerate polygon edges do not contain arbitrary points", () => {
  const geometry = {
    type: "polygon",
    points: [
      { x: 0, y: 0 },
      { x: 0, y: 0 },
      { x: 1, y: 0 }
    ]
  };

  assert.equal(
    pointInGeometry(
      { x: 100, y: 100 },
      geometry
    ),
    false
  );
});


test("pointInGeometry rejects invalid circle radii", () => {
  assert.throws(
    () => pointInGeometry(
      { x: 0, y: 0 },
      {
        type: "circle",
        center: { x: 0, y: 0 },
        radius: -2
      }
    ),
    /radius must be >= 0/
  );
});

test("short non-degenerate segments keep their line geometry", () => {
  const a = { x: 0, y: 0 };
  const b = { x: 1e-5, y: 0 };
  const point = { x: 1e-5, y: 1e-6 };

  const distanceSq =
    squaredDistancePointToSegment(
      point,
      a,
      b
    );

  assert.ok(
    Math.abs(distanceSq - 1e-12) < 1e-20,
    `expected 1e-12, got ${distanceSq}`
  );
});


test("transform helpers reject non-finite composed results", () => {
  assert.throws(
    () => composeTransforms(
      { scale: 1e308 },
      { scale: 2 }
    ),
    /scale.*finite/i
  );

  assert.throws(
    () => composeTransforms(
      { scale: 1e-300 },
      { scale: 1e-300 }
    ),
    /scale.*> 0/i
  );

  assert.throws(
    () => transformPoint(
      { x: 1e308, y: 0 },
      { scale: 2 }
    ),
    /result.*finite Vec2/i
  );
});
