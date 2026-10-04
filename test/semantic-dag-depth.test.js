import test from "node:test";
import assert from "node:assert/strict";

import {
  PlaceRegistry,
  serializePlaceCore,
  validatePlaceCoreSnapshot,
  deserializePlaceCore
} from "../src/index.js";

const DEPTH = 12_000;

function id(index) {
  return `node-${String(index).padStart(5, "0")}`;
}

test("deep semantic containment does not depend on the JavaScript call stack", () => {
  const places = new PlaceRegistry();
  places.registerDefinition({
    id: "deep-semantic-node",
    layers: [{ id: "inside" }]
  });

  for (let i = 0; i < DEPTH; i += 1) {
    places.createPlace({
      id: id(i),
      definitionId: "deep-semantic-node",
      parentId: i === 0 ? null : id(i - 1)
    });
  }

  const last = id(DEPTH - 1);
  const ancestors =
    places.getSemanticAncestors(last);

  assert.equal(
    ancestors.length,
    DEPTH - 1
  );
  assert.equal(ancestors[0], id(0));
  assert.equal(
    ancestors.at(-1),
    id(DEPTH - 2)
  );

  places.assertInternalConsistency();

  const snapshot = serializePlaceCore(places);
  assert.equal(
    validatePlaceCoreSnapshot(snapshot),
    true
  );

  const restored =
    deserializePlaceCore(snapshot);
  const restoredAncestors =
    restored.getSemanticAncestors(last);

  assert.equal(
    restoredAncestors.length,
    DEPTH - 1
  );
  assert.equal(
    restoredAncestors[0],
    id(0)
  );
  assert.equal(
    restoredAncestors.at(-1),
    id(DEPTH - 2)
  );

  restored.assertInternalConsistency();
});


test("deep relative placement remains iterative across consistency and snapshot validation", () => {
  const places = new PlaceRegistry();
  places.registerDefinition({
    id: "deep-placement-node",
    layers: [{ id: "inside" }]
  });

  for (let i = 0; i < DEPTH; i += 1) {
    places.createPlace({
      id: id(i),
      definitionId: "deep-placement-node",
      placement: i === 0
        ? {
            domainId: "world",
            transform: {
              x: 0,
              y: 0,
              rotation: 0,
              scale: 1
            }
          }
        : {
            parentPlaceId: id(i - 1),
            transform: {
              x: 1,
              y: 0,
              rotation: 0,
              scale: 1
            }
          }
    });
  }

  const last = id(DEPTH - 1);
  const resolved =
    places.getResolvedPlacement(last);

  assert.ok(resolved);
  assert.equal(resolved.domainId, "world");
  assert.equal(
    resolved.transform.x,
    DEPTH - 1
  );

  places.assertInternalConsistency();

  const snapshot = serializePlaceCore(places);
  assert.equal(
    validatePlaceCoreSnapshot(snapshot),
    true
  );
});


test("high-degree semantic memberships keep consistency checks linear", () => {
  const places = new PlaceRegistry();
  places.registerDefinition({
    id: "high-degree-semantic-node",
    layers: [{ id: "inside" }]
  });

  places.createPlace({
    id: "parent",
    definitionId: "high-degree-semantic-node"
  });

  const memberships = Array.from(
    { length: 8_000 },
    (_, index) => ({
      parentPlaceId: "parent",
      kind: `relation-${index}`
    })
  );

  places.createPlace({
    id: "child",
    definitionId: "high-degree-semantic-node",
    memberships
  });

  places.assertInternalConsistency();

  assert.equal(
    places.getPlace("child").getMemberships().length,
    memberships.length
  );
});


test("deep footprint placements avoid repeated ancestor resolution", () => {
  const depth = 3_000;
  const places = new PlaceRegistry();
  places.registerDefinition({
    id: "deep-footprint-node",
    layers: [{ id: "inside" }],
    footprint: {
      type: "aabb",
      minX: 0,
      minY: 0,
      maxX: 1,
      maxY: 1
    }
  });

  for (let i = 0; i < depth; i += 1) {
    places.createPlace({
      id: `foot-${i}`,
      definitionId: "deep-footprint-node",
      placement: i === 0
        ? {
            domainId: "world",
            containment: "footprint",
            transform: {
              x: 0,
              y: 0,
              rotation: 0,
              scale: 1
            }
          }
        : {
            parentPlaceId: `foot-${i - 1}`,
            containment: "footprint",
            transform: {
              x: 1,
              y: 0,
              rotation: 0,
              scale: 1
            }
          }
    });
  }

  places.setPlacement(
    "foot-0",
    {
      domainId: "world",
      containment: "footprint",
      transform: {
        x: 10,
        y: 0,
        rotation: 0,
        scale: 1
      }
    }
  );

  const resolved =
    places.getResolvedPlacement(
      `foot-${depth - 1}`
    );

  assert.ok(resolved);
  assert.equal(
    resolved.transform.x,
    10 + depth - 1
  );

  places.assertInternalConsistency();
});
