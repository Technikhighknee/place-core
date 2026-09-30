import test from "node:test";
import assert from "node:assert/strict";

import { compilePlace } from "../src/index.js";

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
