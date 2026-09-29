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


test("state hash is independent of dynamic portal insertion order", () => {
  const make = (order) => {
    const places = new PlaceRegistry();
    places.registerDefinition(tavernBlueprint());
    const inn = places.createPlace({
      id: "inn",
      definitionId: "tavern",
      attachments: {
        street: { domainId: "street", position: { x: 10, y: 10 }, nodeId: "street-inn" }
      }
    });
    const ground = inn.layerDomains.get("ground");

    const specs = {
      alpha: {
        id: "alpha",
        kind: "breach",
        a: { domainId: ground, position: { x: 1, y: 0 }, nodeId: "g-door" },
        b: { domainId: "street", position: { x: 11, y: 10 }, nodeId: "street-inn" }
      },
      beta: {
        id: "beta",
        kind: "breach",
        a: { domainId: ground, position: { x: 2, y: 0 }, nodeId: "g-bar" },
        b: { domainId: "street", position: { x: 12, y: 10 }, nodeId: "street-inn" }
      }
    };

    for (const id of order) places.addPortal("inn", specs[id]);
    return places;
  };

  const a = make(["alpha", "beta"]);
  const b = make(["beta", "alpha"]);

  assert.equal(computePlaceCoreStateHash(a), computePlaceCoreStateHash(b));
  assert.deepEqual(
    serializePlaceCore(a).instances[0].dynamicPortals.map((portal) => portal.id),
    ["alpha", "beta"]
  );
});


test("serialized snapshots are byte-stable across irrelevant insertion order", () => {
  const blueprint = {
    id: "canonical-place",
    layers: [{ id: "inside" }],
    portals: [
      {
        id: "alpha-door",
        a: { kind: "external", slot: "alpha" },
        b: { kind: "local", layerId: "inside", position: { x: 0, y: 0 } }
      },
      {
        id: "beta-door",
        a: { kind: "external", slot: "beta" },
        b: { kind: "local", layerId: "inside", position: { x: 1, y: 0 } }
      }
    ]
  };

  const build = (reverse) => {
    const places = new PlaceRegistry();
    places.registerDefinition(blueprint);

    const alpha = {
      domainId: "street",
      position: { x: 10, y: 0 },
      metadata: reverse
        ? { b: 2, a: 1 }
        : { a: 1, b: 2 }
    };
    const beta = {
      domainId: "street",
      position: { x: 20, y: 0 },
      metadata: reverse
        ? { nested: { y: 2, x: 1 }, z: 3 }
        : { z: 3, nested: { x: 1, y: 2 } }
    };

    places.createPlace({
      id: "house",
      definitionId: "canonical-place",
      attachments: reverse
        ? { beta, alpha }
        : { alpha, beta },
      metadata: reverse
        ? { z: 3, nested: { y: 2, x: 1 } }
        : { nested: { x: 1, y: 2 }, z: 3 }
    });

    if (reverse) {
      places.setPortalState("house", "beta-door", { locked: true });
      places.setPortalState("house", "alpha-door", { locked: true });
    } else {
      places.setPortalState("house", "alpha-door", { locked: true });
      places.setPortalState("house", "beta-door", { locked: true });
    }

    return places;
  };

  const a = build(false);
  const b = build(true);

  const aJson = JSON.stringify(serializePlaceCore(a));
  const bJson = JSON.stringify(serializePlaceCore(b));

  assert.equal(aJson, bJson);
  assert.equal(computePlaceCoreStateHash(a), computePlaceCoreStateHash(b));
});
