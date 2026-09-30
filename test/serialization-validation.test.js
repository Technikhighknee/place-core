import test from "node:test";
import assert from "node:assert/strict";

import {
  PlaceRegistry,
  serializePlaceCore,
  deserializePlaceCore,
  validatePlaceCoreSnapshot,
  computePlaceCoreStateHash,
  compilePlace,
  startTravel
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
    a: { kind: "resolved", domainId: "inn:ground", position: { x: Number.NaN, y: 0 } },
    b: { kind: "resolved", domainId: "street", position: { x: 0, y: 0 } }
  });
  assert.throws(
    () => validatePlaceCoreSnapshot(malformed),
    /position must contain finite x\/y/
  );
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


test("snapshot validation rejects definition revision reference drift", () => {
  const snapshot = snapshotFixture();
  snapshot.definitions[0].revision = "tampered-revision";

  assert.throws(
    () => validatePlaceCoreSnapshot(snapshot),
    /definition revision mismatch/
  );
});

test("snapshot validation rejects unknown layer domains and invalid attachments", () => {
  const extraLayer = snapshotFixture();
  extraLayer.instances[0].layerDomains.ghost = "ghost-domain";
  assert.throws(
    () => validatePlaceCoreSnapshot(extraLayer),
    /domain for unknown layer ghost/
  );

  const badAttachment = snapshotFixture();
  badAttachment.instances[0].attachments.street.position.x = Number.NaN;
  assert.throws(
    () => validatePlaceCoreSnapshot(badAttachment),
    /attachments\.street\.position must contain finite x\/y/
  );
});

test("snapshot validation rejects malformed sparse overrides before restore", () => {
  const badBoolean = snapshotFixture();
  badBoolean.instances[0].portalOverrides["front-door"].locked = "true";
  assert.throws(
    () => validatePlaceCoreSnapshot(badBoolean),
    /locked must be a boolean/
  );

  const unknownField = snapshotFixture();
  unknownField.instances[0].spaceOverrides.taproom.extra = true;
  assert.throws(
    () => validatePlaceCoreSnapshot(unknownField),
    /contains unknown field extra/
  );
});

test("snapshot validation rejects invalid dynamic portal semantics", () => {
  const invalidCost = snapshotFixture();
  invalidCost.instances[0].dynamicPortals.push({
    id: "slow-breach",
    a: {
      kind: "resolved",
      domainId: "inn:ground",
      position: { x: 1, y: 0 }
    },
    b: {
      kind: "resolved",
      domainId: "street",
      position: { x: 0, y: 0 }
    },
    transitionCost: -1
  });
  assert.throws(
    () => validatePlaceCoreSnapshot(invalidCost),
    /transitionCost must be a finite number >= 0/
  );

  const invalidBoolean = snapshotFixture();
  invalidBoolean.instances[0].dynamicPortals.push({
    id: "weird-breach",
    a: {
      kind: "resolved",
      domainId: "inn:ground",
      position: { x: 1, y: 0 }
    },
    b: {
      kind: "resolved",
      domainId: "street",
      position: { x: 0, y: 0 }
    },
    locked: "false"
  });
  assert.throws(
    () => validatePlaceCoreSnapshot(invalidBoolean),
    /locked must be a boolean/
  );

  const invalidRoad = snapshotFixture();
  invalidRoad.instances[0].dynamicPortals.push({
    id: "bad-road",
    a: {
      kind: "resolved",
      domainId: "inn:ground",
      position: { x: 0, y: 0 }
    },
    b: {
      kind: "resolved",
      domainId: "street",
      position: { x: 0, y: 0 }
    },
    roadBindings: [{
      layerId: "ground",
      roadId: "missing-road"
    }]
  });
  assert.throws(
    () => validatePlaceCoreSnapshot(invalidRoad),
    /unknown navigation road missing-road/
  );
});

test("snapshot validation rejects malformed active travel state", () => {
  const places = new PlaceRegistry();
  places.registerDefinition({
    id: "travel-snapshot-place",
    layers: [{ id: "inside" }],
    anchors: [{
      id: "target",
      layerId: "inside",
      position: { x: 5, y: 0 },
      nodeId: "target"
    }]
  });
  const place = places.createPlace({
    id: "house",
    definitionId: "travel-snapshot-place"
  });

  const entity = {
    id: "hans",
    domainId: place.layerDomains.get("inside"),
    position: { x: 0, y: 0 },
    mobility: { speed: 1 },
    journey: null
  };
  const bridge = {
    getEntity() { return entity; },
    planLocalRoute() { return { estimatedSeconds: 5 }; },
    startLocalJourney() {
      entity.journey = { destinationNodeId: "target" };
      return true;
    },
    stopLocalJourney() { entity.journey = null; },
    transferEntity() {}
  };

  startTravel(
    places,
    bridge,
    "hans",
    { placeId: "house", anchorId: "target" }
  );

  const invalidOption = serializePlaceCore(places);
  invalidOption.activeTravels[0].options.maxDomainPathAttempts = 0;
  assert.throws(
    () => validatePlaceCoreSnapshot(invalidOption),
    /maxDomainPathAttempts must be a positive integer/
  );

  const invalidBoolean = serializePlaceCore(places);
  invalidBoolean.activeTravels[0].localStarted = "true";
  assert.throws(
    () => validatePlaceCoreSnapshot(invalidBoolean),
    /localStarted must be a boolean/
  );

  const invalidStep = serializePlaceCore(places);
  invalidStep.activeTravels[0].plan.steps[0].estimatedSeconds = -1;
  assert.throws(
    () => validatePlaceCoreSnapshot(invalidStep),
    /estimatedSeconds/
  );

  const mismatch = serializePlaceCore(places);
  mismatch.activeTravels[0].plan.target = {
    placeId: "house",
    anchorId: "different"
  };
  assert.throws(
    () => validatePlaceCoreSnapshot(mismatch),
    /plan target mismatch/
  );
});

test("snapshot validation rejects invalid placement transforms", () => {
  const snapshot = snapshotFixture();
  snapshot.instances[0].placement = {
    domainId: "street",
    parentPlaceId: null,
    containment: "footprint",
    transform: {
      x: 0,
      y: 0,
      rotation: 0,
      scale: 0
    }
  };

  assert.throws(
    () => validatePlaceCoreSnapshot(snapshot),
    /placement scale must be > 0/
  );
});


test("snapshot validation rejects static attachment threshold mismatch before restore", () => {
  const places = new PlaceRegistry();
  places.registerDefinition({
    id: "snapshot-threshold-place",
    layers: [{
      id: "inside",
      navigation: {
        nodes: [
          { id: "a", x: 0, y: 0 },
          { id: "b", x: 1, y: 0 },
          { id: "c", x: 0, y: 1 }
        ],
        roads: [
          { id: "ab", from: "a", to: "b" },
          { id: "ac", from: "a", to: "c" }
        ]
      }
    }],
    portals: [{
      id: "door",
      a: { kind: "external", slot: "outside" },
      b: {
        kind: "local",
        layerId: "inside",
        position: { x: 1, y: 0 },
        nodeId: "b"
      },
      roadBindings: [{
        layerId: "inside",
        roadId: "ab"
      }]
    }]
  });

  const place = places.createPlace({
    id: "hall",
    definitionId: "snapshot-threshold-place",
    attachments: {
      outside: {
        domainId: "street",
        position: { x: 10, y: 0 },
        nodeId: "street-door"
      }
    }
  });
  const snapshot = serializePlaceCore(places);
  const item = snapshot.instances[0];

  item.attachments.outside = {
    domainId: place.layerDomains.get("inside"),
    position: { x: 0, y: 1 },
    nodeId: "c"
  };

  assert.throws(
    () => validatePlaceCoreSnapshot(snapshot),
    /road binding ab does not connect its endpoint nodes/
  );
});

test("snapshot validation rejects dynamic threshold node mismatch", () => {
  const places = new PlaceRegistry();
  places.registerDefinition({
    id: "dynamic-snapshot-threshold",
    layers: [{
      id: "inside",
      navigation: {
        nodes: [
          { id: "a", x: 0, y: 0 },
          { id: "b", x: 1, y: 0 },
          { id: "c", x: 0, y: 1 }
        ],
        roads: [{
          id: "ab",
          from: "a",
          to: "b"
        }]
      }
    }]
  });
  const place = places.createPlace({
    id: "hall",
    definitionId: "dynamic-snapshot-threshold"
  });
  const domainId = place.layerDomains.get("inside");

  places.addPortal("hall", {
    id: "door",
    a: {
      domainId,
      position: { x: 0, y: 0 },
      nodeId: "a",
      layerId: "inside"
    },
    b: {
      domainId,
      position: { x: 1, y: 0 },
      nodeId: "b",
      layerId: "inside"
    },
    roadBindings: [{
      layerId: "inside",
      roadId: "ab"
    }]
  });

  const snapshot = serializePlaceCore(places);
  snapshot.instances[0].dynamicPortals[0].b = {
    ...snapshot.instances[0].dynamicPortals[0].b,
    position: { x: 0, y: 1 },
    nodeId: "c"
  };

  assert.throws(
    () => validatePlaceCoreSnapshot(snapshot),
    /road binding ab does not connect its endpoint nodes/
  );
});

test("snapshot validation requires topology-backed dynamic road bindings", () => {
  const snapshot = snapshotFixture();
  snapshot.instances[0].dynamicPortals.push({
    id: "bad-topology-binding",
    a: {
      kind: "resolved",
      domainId: "street",
      position: { x: 0, y: 0 }
    },
    b: {
      kind: "resolved",
      domainId: "other",
      position: { x: 0, y: 0 }
    },
    roadBindings: [{
      layerId: "cellar",
      roadId: "imaginary"
    }]
  });

  const definition = snapshot.definitions[0].blueprint;
  const cellar = definition.layers.find((layer) => layer.id === "cellar");
  cellar.navigation = null;
  cellar.topologyId = null;

  // Re-hash after intentionally producing a structurally valid definition
  // whose dynamic binding points at a layer without navigation ownership.
  const compiled = compilePlace(definition);
  snapshot.definitions[0].contentHash = compiled.contentHash;
  snapshot.definitions[0].revision = compiled.revision;

  assert.throws(
    () => validatePlaceCoreSnapshot(snapshot),
    /road binding requires navigation topology on layer cellar/
  );
});


test("snapshot validation rejects unknown nested runtime fields before restore", () => {
  const badAttachment = snapshotFixture();
  badAttachment.instances[0].attachments.street.postion = {
    x: 1,
    y: 2
  };
  assert.throws(
    () => validatePlaceCoreSnapshot(badAttachment),
    /attachments\.street contains unknown field postion/
  );

  const badAttachmentPoint = snapshotFixture();
  badAttachmentPoint.instances[0]
    .attachments.street.position.z = 3;
  assert.throws(
    () => validatePlaceCoreSnapshot(badAttachmentPoint),
    /attachments\.street\.position contains unknown field z/
  );

  const badPlacement = snapshotFixture();
  badPlacement.instances[0].placement = {
    domainId: "street",
    containment: "footprint",
    transform: {
      x: 0,
      y: 0,
      rotation: 0,
      scale: 1
    },
    parentPlacId: "typo"
  };
  assert.throws(
    () => validatePlaceCoreSnapshot(badPlacement),
    /placement contains unknown field parentPlacId/
  );

  const badTransform = snapshotFixture();
  badTransform.instances[0].placement = {
    domainId: "street",
    containment: "footprint",
    transform: {
      x: 0,
      y: 0,
      rotation: 0,
      scale: 1,
      skew: 1
    }
  };
  assert.throws(
    () => validatePlaceCoreSnapshot(badTransform),
    /placement\.transform contains unknown field skew/
  );

  const dynamic = snapshotFixture();
  dynamic.instances[0].dynamicPortals.push({
    id: "breach",
    kind: "breach",
    tags: [],
    a: {
      kind: "resolved",
      domainId: "inn:ground",
      position: { x: 1, y: 0 },
      nodeId: null,
      placeId: "inn",
      spaceId: null,
      layerId: "ground",
      metadata: null
    },
    b: {
      kind: "resolved",
      domainId: "street",
      position: { x: 0, y: 0 },
      nodeId: null,
      placeId: null,
      spaceId: null,
      layerId: null,
      metadata: null
    },
    bidirectional: true,
    transitionCost: 0,
    enabled: true,
    open: true,
    locked: false,
    blocked: false,
    destroyed: false,
    blocksWhenClosed: false,
    roadBindings: [],
    metadata: null,
    bidirectionl: false
  });
  assert.throws(
    () => validatePlaceCoreSnapshot(dynamic),
    /dynamic portal contains unknown field bidirectionl/
  );
});
