import test from "node:test";
import assert from "node:assert/strict";

import {
  PlaceRegistry,
  serializePlaceCore,
  deserializePlaceCore,
  validatePlaceCoreSnapshot,
  computePlaceCoreStateHash
} from "../src/index.js";
import { tavernBlueprint } from "./fixtures.js";

function snapshotFixture() {
  const places = new PlaceRegistry();
  places.registerDefinition(tavernBlueprint());
  places.createPlace({
    id: "inn",
    definitionId: "tavern",
    attachments: {
      street: { domainId: "street", position: { x: 10, y: 10 }, nodeId: "street-inn" }
    }
  });
  places.setPortalState("inn", "front-door", { locked: true });
  places.setSpaceState("inn", "taproom", { enabled: false });
  return serializePlaceCore(places);
}

test("self-contained snapshot restores without external definitions", () => {
  const snapshot = snapshotFixture();
  assert.equal(validatePlaceCoreSnapshot(snapshot), true);

  const restored = deserializePlaceCore(JSON.parse(JSON.stringify(snapshot)));
  assert.equal(restored.getDefinition("tavern").contentHash, snapshot.definitions[0].contentHash);
  assert.equal(restored.resolvePortal("inn", "front-door").locked, true);
  assert.equal(restored.getSpace("inn", "taproom").enabled, false);
  assert.equal(
    computePlaceCoreStateHash(restored),
    computePlaceCoreStateHash(deserializePlaceCore(snapshot))
  );
});

test("snapshot validation rejects tampered definition content", () => {
  const snapshot = snapshotFixture();
  snapshot.definitions[0].blueprint.kind = "tampered";
  assert.throws(() => validatePlaceCoreSnapshot(snapshot), /definition hash mismatch/);
});

test("snapshot validation rejects orphan structural overrides", () => {
  const snapshot = snapshotFixture();
  snapshot.instances[0].portalOverrides["missing-door"] = { locked: true };
  assert.throws(() => validatePlaceCoreSnapshot(snapshot), /orphan portal override/);
});

test("snapshot validation rejects duplicate world-domain ownership", () => {
  const snapshot = snapshotFixture();
  const copy = structuredClone(snapshot.instances[0]);
  copy.id = "inn-2";
  snapshot.instances.push(copy);
  assert.throws(() => validatePlaceCoreSnapshot(snapshot), /duplicate bound domain/);
});

test("snapshot validation rejects missing parents and malformed dynamic portals", () => {
  const missingParent = snapshotFixture();
  missingParent.instances[0].parentId = "missing";
  assert.throws(() => validatePlaceCoreSnapshot(missingParent), /missing parent/);

  const malformed = snapshotFixture();
  malformed.instances[0].dynamicPortals.push({
    id: "breach",
    a: { domainId: "inn:ground", position: { x: Number.NaN, y: 0 } },
    b: { domainId: "street", position: { x: 0, y: 0 } }
  });
  assert.throws(() => validatePlaceCoreSnapshot(malformed), /invalid endpoint/);
});
