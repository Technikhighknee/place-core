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
