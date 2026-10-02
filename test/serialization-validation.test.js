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

function canonicalDynamicPortal(overrides = {}) {
  const {
    a: aOverrides = {},
    b: bOverrides = {},
    ...portalOverrides
  } = overrides;

  return {
    id: "breach",
    kind: "portal",
    tags: [],
    a: {
      kind: "resolved",
      domainId: "inn:ground",
      position: { x: 1, y: 0 },
      nodeId: null,
      placeId: null,
      spaceId: null,
      layerId: null,
      metadata: null,
      ...aOverrides
    },
    b: {
      kind: "resolved",
      domainId: "street",
      position: { x: 0, y: 0 },
      nodeId: null,
      placeId: null,
      spaceId: null,
      layerId: null,
      metadata: null,
      ...bOverrides
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
    ...portalOverrides
  };
}

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

test("self-contained snapshot preserves selective tracked occupancy", () => {
  const places = new PlaceRegistry();
  places.updateEntityOccupancy({
    id: "idle",
    domainId: "default",
    position: { x: 3, y: 4 }
  });

  const snapshot = serializePlaceCore(places);
  assert.deepEqual(
    snapshot.occupancy,
    [{
      entityId: "idle",
      domainId: "default",
      position: { x: 3, y: 4 }
    }]
  );

  const restored =
    deserializePlaceCore(
      structuredClone(snapshot)
    );

  assert.deepEqual(
    restored.getEntityLocation("idle"),
    {
      domainId: "default",
      position: { x: 3, y: 4 },
      places: [],
      semanticPlaces: [],
      spaces: [],
      placeId: null,
      layerId: null,
      deepestSpace: null
    }
  );
});

test("snapshot validation requires the complete current version-1 schema", () => {
  for (const field of [
    "activeTravels",
    "pendingTravels"
  ]) {
    const snapshot =
      snapshotFixture();
    delete snapshot[field];

    assert.throws(
      () =>
        validatePlaceCoreSnapshot(
          snapshot
        ),
      new RegExp(
        `missing required field ${field}`
      )
    );
  }

  for (const field of [
    "parentId",
    "memberships",
    "placement",
    "metadata",
    "portalOverrides",
    "boundaryOverrides",
    "spaceOverrides",
    "dynamicPortals"
  ]) {
    const snapshot =
      snapshotFixture();
    delete snapshot.instances[0][field];

    assert.throws(
      () =>
        validatePlaceCoreSnapshot(
          snapshot
        ),
      new RegExp(
        `instances\\[0\\].*missing required field ${field}`
      )
    );
  }
});

test("snapshot validation requires canonical persisted attachment fields", () => {
  for (const field of [
    "nodeId",
    "placeId",
    "spaceId",
    "metadata"
  ]) {
    const snapshot =
      snapshotFixture();
    delete snapshot.instances[0]
      .attachments.street[field];

    assert.throws(
      () =>
        validatePlaceCoreSnapshot(
          snapshot
        ),
      new RegExp(
        `attachments\\.street is missing required field ${field}`
      )
    );
  }
});


test("snapshot validation rejects duplicate tracked occupancy identities", () => {
  const snapshot = snapshotFixture();
  snapshot.occupancy.push(
    {
      entityId: "idle",
      domainId: "default",
      position: { x: 1, y: 2 }
    },
    {
      entityId: "idle",
      domainId: "default",
      position: { x: 2, y: 3 }
    }
  );

  assert.throws(
    () =>
      validatePlaceCoreSnapshot(
        snapshot
      ),
    /duplicate occupancy entity idle/
  );
});

test("state hash includes selective tracked occupancy", () => {
  const empty = new PlaceRegistry();
  const tracked = new PlaceRegistry();
  tracked.updateEntityOccupancy({
    id: "idle",
    domainId: "default",
    position: { x: 3, y: 4 }
  });

  assert.notEqual(
    computePlaceCoreStateHash(empty),
    computePlaceCoreStateHash(tracked)
  );
});

test("resumeWorldCoreState verifies stationary tracked occupancy before attach", () => {
  const places = new PlaceRegistry();
  places.updateEntityOccupancy({
    id: "idle",
    domainId: "default",
    position: { x: 3, y: 4 }
  });
  const snapshot =
    serializePlaceCore(places);

  const matchingEntity = {
    id: "idle",
    domainId: "default",
    position: { x: 3, y: 4 }
  };
  let attached = null;
  const bridge = {
    getEntity(entityId) {
      return entityId === "idle"
        ? matchingEntity
        : null;
    },
    attachRegistry(registry) {
      attached = registry;
      return this;
    }
  };

  const restored =
    deserializePlaceCore(
      structuredClone(snapshot),
      {
        bridge,
        resumeWorldCoreState: true
      }
    );

  assert.equal(attached, restored);
  assert.deepEqual(
    restored.getEntityLocation("idle")
      ?.position,
    { x: 3, y: 4 }
  );

  let mismatchedAttached = false;
  const mismatchedBridge = {
    getEntity(entityId) {
      return entityId === "idle"
        ? {
            ...matchingEntity,
            position: { x: 9, y: 4 }
          }
        : null;
    },
    attachRegistry() {
      mismatchedAttached = true;
      return this;
    }
  };

  assert.throws(
    () =>
      deserializePlaceCore(
        structuredClone(snapshot),
        {
          bridge: mismatchedBridge,
          resumeWorldCoreState: true
        }
      ),
    /does not match saved occupancy/
  );
  assert.equal(
    mismatchedAttached,
    false
  );
});

test("restore rebuild events do not consume or overflow the runtime event queue", () => {
  const snapshot = snapshotFixture();

  const restored =
    deserializePlaceCore(
      snapshot,
      {
        captureEvents: true,
        eventQueueLimit: 1
      }
    );

  assert.deepEqual(
    restored.getEventQueueStats(),
    {
      size: 0,
      limit: 1,
      overflowPolicy: "drop-newest",
      dropped: 0
    }
  );

  restored.emit(
    "runtime-event",
    { value: 1 }
  );

  assert.deepEqual(
    restored.peekEvents().map(
      (event) => event.type
    ),
    ["runtime-event"]
  );
  assert.equal(
    restored.getEventQueueStats().dropped,
    0
  );
});

test("snapshot validation rejects malformed pending travel identity", () => {
  const missing = snapshotFixture();
  missing.pendingTravels.push({});

  assert.throws(
    () =>
      validatePlaceCoreSnapshot(
        missing
      ),
    /pendingTravels\[0\].*missing required field entityId/
  );

  const mismatch = snapshotFixture();
  mismatch.pendingTravels.push({
    entityId: "hans",
    target: {
      placeId: "inn"
    },
    savedState: {
      entityId: "other",
      target: {
        placeId: "inn"
      }
    }
  });

  assert.throws(
    () =>
      validatePlaceCoreSnapshot(
        mismatch
      ),
    /savedState entityId mismatch/
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
  malformed.instances[0].dynamicPortals.push(
    canonicalDynamicPortal({
      a: {
        position: {
          x: Number.NaN,
          y: 0
        }
      }
    })
  );
  assert.throws(
    () => validatePlaceCoreSnapshot(malformed),
    /position must contain finite x\/y/
  );
});


test("snapshot validation requires canonical persisted dynamic portal fields", () => {
  const snapshot = snapshotFixture();
  snapshot.instances[0].dynamicPortals.push(
    canonicalDynamicPortal()
  );
  assert.equal(
    validatePlaceCoreSnapshot(snapshot),
    true
  );

  const missingPortalField =
    structuredClone(snapshot);
  delete missingPortalField
    .instances[0]
    .dynamicPortals[0]
    .bidirectional;
  assert.throws(
    () =>
      validatePlaceCoreSnapshot(
        missingPortalField
      ),
    /dynamic portal is missing required field bidirectional/
  );

  const missingEndpointField =
    structuredClone(snapshot);
  delete missingEndpointField
    .instances[0]
    .dynamicPortals[0]
    .a.metadata;
  assert.throws(
    () =>
      validatePlaceCoreSnapshot(
        missingEndpointField
      ),
    /portal breach\.a is missing required field metadata/
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
  invalidCost.instances[0].dynamicPortals.push(
    canonicalDynamicPortal({
      id: "slow-breach",
      transitionCost: -1
    })
  );
  assert.throws(
    () => validatePlaceCoreSnapshot(invalidCost),
    /transitionCost must be a finite number >= 0/
  );

  const invalidBoolean = snapshotFixture();
  invalidBoolean.instances[0].dynamicPortals.push(
    canonicalDynamicPortal({
      id: "weird-breach",
      locked: "false"
    })
  );
  assert.throws(
    () => validatePlaceCoreSnapshot(invalidBoolean),
    /locked must be a boolean/
  );

  const invalidRoad = snapshotFixture();
  invalidRoad.instances[0].dynamicPortals.push(
    canonicalDynamicPortal({
      id: "bad-road",
      a: {
        position: { x: 0, y: 0 }
      },
      roadBindings: [{
        layerId: "ground",
        roadId: "missing-road"
      }]
    })
  );
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
    ...item.attachments.outside,
    domainId:
      place.layerDomains.get(
        "inside"
      ),
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
  snapshot.instances[0].dynamicPortals.push(
    canonicalDynamicPortal({
      id: "bad-topology-binding",
      a: {
        domainId: "street",
        position: { x: 0, y: 0 }
      },
      b: {
        domainId: "other",
        position: { x: 0, y: 0 }
      },
      roadBindings: [{
        layerId: "cellar",
        roadId: "imaginary"
      }]
    })
  );

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


test("versioned snapshots reject unknown envelope fields instead of dropping them", () => {
  const top = snapshotFixture();
  top.formatt = "place-core";
  assert.throws(
    () => validatePlaceCoreSnapshot(top),
    /place-core snapshot contains unknown field formatt/
  );

  const definition = snapshotFixture();
  definition.definitions[0].contnetHash =
    definition.definitions[0].contentHash;
  assert.throws(
    () => validatePlaceCoreSnapshot(definition),
    /snapshot\.definitions\[0\] contains unknown field contnetHash/
  );

  const instance = snapshotFixture();
  instance.instances[0].attachements = {};
  assert.throws(
    () => validatePlaceCoreSnapshot(instance),
    /snapshot\.instances\[0\] contains unknown field attachements/
  );
});

test("active travel snapshots reject ignored or contradictory plan state", () => {
  const places = new PlaceRegistry();
  places.registerDefinition({
    id: "strict-travel-snapshot",
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
    definitionId: "strict-travel-snapshot"
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
    planLocalRoute() {
      return { estimatedSeconds: 5 };
    },
    startLocalJourney() {
      entity.journey = { active: true };
      return true;
    },
    stopLocalJourney() {
      entity.journey = null;
    },
    transferEntity() {}
  };
  assert.ok(startTravel(
    places,
    bridge,
    "hans",
    { placeId: "house", anchorId: "target" }
  ));

  const extra = serializePlaceCore(places);
  extra.activeTravels[0].mystery = true;
  assert.throws(
    () => validatePlaceCoreSnapshot(extra),
    /active travel contains unknown field mystery/
  );

  const planExtra = serializePlaceCore(places);
  planExtra.activeTravels[0].plan.debug = true;
  assert.throws(
    () => validatePlaceCoreSnapshot(planExtra),
    /active travel plan contains unknown field debug/
  );

  const conflictingAlias = serializePlaceCore(places);
  conflictingAlias.activeTravels[0].plan.legs = [];
  assert.throws(
    () => validatePlaceCoreSnapshot(conflictingAlias),
    /legs\/steps mismatch/
  );

  const exhausted = serializePlaceCore(places);
  exhausted.activeTravels[0].stepIndex =
    exhausted.activeTravels[0].plan.steps.length;
  assert.throws(
    () => validatePlaceCoreSnapshot(exhausted),
    /stepIndex must reference an executable plan step/
  );

  const replannedLocal =
    serializePlaceCore(places);
  replannedLocal.activeTravels[0]
    .localStarted = false;
  assert.doesNotThrow(
    () =>
      validatePlaceCoreSnapshot(
        replannedLocal
      )
  );

  const unsafeReplans =
    serializePlaceCore(places);
  unsafeReplans.activeTravels[0].replans =
    Number.MAX_SAFE_INTEGER + 1;
  assert.throws(
    () => validatePlaceCoreSnapshot(unsafeReplans),
    /replans.*safe integer|invalid active travel replans/i
  );

  const failedButActive = serializePlaceCore(places);
  failedButActive.activeTravels[0].failureReason =
    "should-not-exist";
  assert.throws(
    () => validatePlaceCoreSnapshot(failedButActive),
    /failureReason must be null/
  );

  const wrongDomainPath = serializePlaceCore(places);
  wrongDomainPath.activeTravels[0].plan.domainPath = [
    "wrong-domain"
  ];
  assert.throws(
    () => validatePlaceCoreSnapshot(wrongDomainPath),
    /domainPath.*mismatch|domain path.*mismatch/i
  );

  const wrongLocalDomain = serializePlaceCore(places);
  wrongLocalDomain.activeTravels[0].plan.steps[0].domainId =
    "wrong-domain";
  wrongLocalDomain.activeTravels[0].plan.legs =
    structuredClone(
      wrongLocalDomain.activeTravels[0].plan.steps
    );
  assert.throws(
    () => validatePlaceCoreSnapshot(wrongLocalDomain),
    /local-journey.*domain|step.*domain.*mismatch/i
  );

  const wrongEstimate = serializePlaceCore(places);
  wrongEstimate.activeTravels[0].plan.estimatedSeconds += 1;
  assert.throws(
    () => validatePlaceCoreSnapshot(wrongEstimate),
    /estimatedSeconds.*mismatch|estimated.*step.*sum/i
  );

  const wrongResolvedTarget =
    serializePlaceCore(places);
  wrongResolvedTarget.activeTravels[0]
    .plan.resolvedTarget.placeId =
      "other-house";
  assert.throws(
    () =>
      validatePlaceCoreSnapshot(
        wrongResolvedTarget
      ),
    /resolvedTarget.*placeId.*target|resolved target.*mismatch/i
  );
});

test("deserialize options reject unknown fields", () => {
  assert.throws(
    () => deserializePlaceCore(
      snapshotFixture(),
      { restartTrvels: false }
    ),
    /deserialize options contains unknown field restartTrvels/
  );
});


test("snapshot validation treats prototype-shadowing layer IDs as own dictionary keys", () => {
  const places = new PlaceRegistry();
  places.registerDefinition({
    id: "prototype-threshold",
    layers: [{
      id: "constructor",
      navigation: {
        nodes: [
          { id: "a", x: 0, y: 0 },
          { id: "b", x: 1, y: 0 }
        ],
        roads: [{
          id: "threshold",
          from: "a",
          to: "b",
          bidirectional: true
        }]
      }
    }],
    spaces: [
      {
        id: "left",
        layerId: "constructor",
        geometry: {
          type: "aabb",
          minX: -1,
          minY: -1,
          maxX: 0,
          maxY: 1
        }
      },
      {
        id: "right",
        layerId: "constructor",
        geometry: {
          type: "aabb",
          minX: 0,
          minY: -1,
          maxX: 1,
          maxY: 1
        }
      }
    ],
    portals: [{
      id: "door",
      a: {
        layerId: "constructor",
        spaceId: "left",
        position: { x: 0, y: 0 },
        nodeId: "a"
      },
      b: {
        layerId: "constructor",
        spaceId: "right",
        position: { x: 1, y: 0 },
        nodeId: "b"
      },
      roadBindings: [{
        layerId: "constructor",
        roadId: "threshold"
      }]
    }]
  });
  places.createPlace({
    id: "house",
    definitionId: "prototype-threshold"
  });

  assert.equal(
    validatePlaceCoreSnapshot(
      serializePlaceCore(places)
    ),
    true
  );
});


test("snapshot validation rejects duplicate same-domain threshold road ownership", () => {
  const places = new PlaceRegistry();
  places.registerDefinition(
    compilePlace({
      id: "threshold-place",
      layers: [{
        id: "ground",
        navigation: {
          nodes: [
            { id: "a", x: 0, y: 0 },
            { id: "b", x: 1, y: 0 }
          ],
          roads: [{
            id: "door-road",
            from: "a",
            to: "b",
            width: 1
          }]
        }
      }]
    })
  );

  const place = places.createPlace({
    id: "house",
    definitionId: "threshold-place"
  });
  const domainId =
    place.layerDomains.get("ground");

  places.addPortal("house", {
    id: "door-a",
    transitionCost: 1,
    a: {
      domainId,
      position: { x: 0, y: 0 },
      nodeId: "a",
      placeId: "house",
      layerId: "ground"
    },
    b: {
      domainId,
      position: { x: 1, y: 0 },
      nodeId: "b",
      placeId: "house",
      layerId: "ground"
    },
    roadBindings: [{
      layerId: "ground",
      roadId: "door-road"
    }]
  });

  const snapshot =
    structuredClone(
      serializePlaceCore(places)
    );
  const duplicate =
    structuredClone(
      snapshot.instances[0]
        .dynamicPortals[0]
    );
  duplicate.id = "door-b";
  snapshot.instances[0]
    .dynamicPortals.push(duplicate);

  assert.throws(
    () =>
      validatePlaceCoreSnapshot(snapshot),
    /threshold|road.*portal|already bound/i
  );
});


test("snapshot validation rejects active travel portal identity drift", () => {
  const places = new PlaceRegistry();
  places.registerDefinition({
    id: "travel-portal-integrity",
    layers: [{ id: "inside" }],
    portals: [
      {
        id: "door-a",
        a: { kind: "external", slot: "a" },
        b: {
          kind: "local",
          layerId: "inside",
          position: { x: 0, y: 0 },
          nodeId: "inside-a"
        }
      },
      {
        id: "door-b",
        a: { kind: "external", slot: "b" },
        b: {
          kind: "local",
          layerId: "inside",
          position: { x: 10, y: 0 },
          nodeId: "inside-b"
        }
      }
    ],
    anchors: [{
      id: "target",
      layerId: "inside",
      position: { x: 20, y: 0 },
      nodeId: "target"
    }]
  });

  places.createPlace({
    id: "house",
    definitionId: "travel-portal-integrity",
    attachments: {
      a: {
        domainId: "street",
        position: { x: 0, y: 0 },
        nodeId: "street-a"
      },
      b: {
        domainId: "street",
        position: { x: 100, y: 0 },
        nodeId: "street-b"
      }
    }
  });

  const entity = {
    id: "hans",
    domainId: "street",
    position: { x: -1, y: 0 },
    mobility: { speed: 1 },
    journey: null
  };

  const nodeX = new Map([
    ["street-a", 0],
    ["street-b", 100],
    ["inside-a", 0],
    ["inside-b", 10],
    ["target", 20]
  ]);

  const bridge = {
    getEntity() {
      return entity;
    },
    planLocalRoute({
      position,
      destinationNodeId
    }) {
      const x = nodeX.get(destinationNodeId);
      return x == null
        ? null
        : {
            estimatedSeconds:
              Math.abs(position.x - x)
          };
    },
    startLocalJourney(
      id,
      destinationNodeId
    ) {
      entity.journey = { destinationNodeId };
      return true;
    },
    stopLocalJourney() {
      entity.journey = null;
    },
    transferEntity() {}
  };

  assert.ok(
    startTravel(
      places,
      bridge,
      "hans",
      {
        placeId: "house",
        anchorId: "target"
      }
    )
  );

  const snapshot = serializePlaceCore(places);
  const portalStep =
    snapshot.activeTravels[0].plan.steps.find(
      (step) =>
        step.type === "traverse-portal"
    );
  assert.ok(portalStep);
  assert.equal(portalStep.portalId, "door-a");

  const otherPortal =
    places.getPortalsForDomain("street").find(
      (portal) => portal.id === "door-b"
    );
  assert.ok(otherPortal);

  portalStep.portalKey = otherPortal.key;
  snapshot.activeTravels[0].plan.legs =
    structuredClone(
      snapshot.activeTravels[0].plan.steps
    );

  assert.throws(
    () => validatePlaceCoreSnapshot(snapshot),
    /portal.*key.*mismatch|portalKey.*mismatch/i
  );

  const excessiveRemaining =
    serializePlaceCore(places);
  const active =
    excessiveRemaining.activeTravels[0];
  const portalIndex =
    active.plan.steps.findIndex(
      (step) =>
        step.type === "traverse-portal"
    );
  assert.ok(portalIndex >= 0);

  const portalStepForRemaining =
    active.plan.steps[portalIndex];
  active.stepIndex = portalIndex;
  active.localStarted = false;
  active.portalEntered = true;
  active.portalTransitionRemaining =
    portalStepForRemaining.transitionCost + 1;

  assert.throws(
    () =>
      validatePlaceCoreSnapshot(
        excessiveRemaining
      ),
    /portalTransitionRemaining.*transitionCost|remaining.*transition/i
  );

  const replannedPortal =
    serializePlaceCore(places);
  const replanned =
    replannedPortal.activeTravels[0];
  const replannedPortalIndex =
    replanned.plan.steps.findIndex(
      (step) =>
        step.type === "traverse-portal"
    );
  replanned.stepIndex =
    replannedPortalIndex;
  replanned.localStarted = false;
  replanned.portalEntered = false;
  replanned.portalTransitionRemaining = 0;

  assert.doesNotThrow(
    () =>
      validatePlaceCoreSnapshot(
        replannedPortal
      )
  );

  const zeroRemaining =
    serializePlaceCore(places);
  const zero =
    zeroRemaining.activeTravels[0];
  const zeroPortalIndex =
    zero.plan.steps.findIndex(
      (step) =>
        step.type === "traverse-portal"
    );
  zero.stepIndex = zeroPortalIndex;
  zero.localStarted = false;
  zero.portalEntered = true;
  zero.portalTransitionRemaining = 0;

  assert.throws(
    () =>
      validatePlaceCoreSnapshot(
        zeroRemaining
      ),
    /entered portal.*positive portalTransitionRemaining/
  );
});


test("fresh snapshots accept explicit descendant anchors for parent space targets", () => {
  const places = new PlaceRegistry();
  places.registerDefinition({
    id: "explicit-descendant-target",
    layers: [{
      id: "inside",
      navigation: {
        nodes: [
          { id: "start", x: 0, y: 0 },
          { id: "counter", x: 1, y: 0 }
        ],
        roads: [{
          id: "hall",
          from: "start",
          to: "counter"
        }]
      }
    }],
    spaces: [
      {
        id: "floor",
        layerId: "inside",
        geometry: {
          type: "aabb",
          minX: 0,
          minY: -1,
          maxX: 2,
          maxY: 1
        }
      },
      {
        id: "room",
        parentSpaceId: "floor",
        layerId: "inside",
        geometry: {
          type: "aabb",
          minX: 0.5,
          minY: -1,
          maxX: 2,
          maxY: 1
        }
      }
    ],
    anchors: [{
      id: "counter",
      layerId: "inside",
      spaceId: "room",
      position: { x: 1, y: 0 },
      nodeId: "counter"
    }]
  });

  const place = places.createPlace({
    id: "house",
    definitionId: "explicit-descendant-target"
  });

  const entity = {
    id: "hans",
    domainId: place.layerDomains.get("inside"),
    position: { x: 0, y: 0 },
    mobility: { speed: 1 },
    journey: null
  };

  const bridge = {
    getEntity() {
      return entity;
    },
    planLocalRoute() {
      return { estimatedSeconds: 1 };
    },
    startLocalJourney(id, destinationNodeId) {
      entity.journey = { destinationNodeId };
      return true;
    },
    stopLocalJourney() {
      entity.journey = null;
    },
    transferEntity() {}
  };

  assert.ok(
    startTravel(
      places,
      bridge,
      "hans",
      {
        placeId: "house",
        spaceId: "floor",
        anchorId: "counter"
      }
    )
  );

  const snapshot = serializePlaceCore(places);

  assert.equal(
    snapshot.activeTravels[0].plan.resolvedTarget.spaceId,
    "floor"
  );
  assert.equal(
    snapshot.activeTravels[0].plan.resolvedTarget.anchorId,
    "counter"
  );
  assert.doesNotThrow(
    () => validatePlaceCoreSnapshot(snapshot)
  );
});

test("fresh snapshots preserve deterministic implicit anchor selection", () => {
  const places = new PlaceRegistry();
  places.registerDefinition({
    id: "fresh-request-binding",
    layers: [{ id: "inside" }],
    anchors: [
      {
        id: "alpha",
        layerId: "inside",
        position: { x: 5, y: 0 },
        nodeId: "alpha"
      },
      {
        id: "beta",
        layerId: "inside",
        position: { x: 6, y: 0 },
        nodeId: "beta"
      }
    ]
  });
  const place = places.createPlace({
    id: "house",
    definitionId:
      "fresh-request-binding"
  });
  const entity = {
    id: "hans",
    domainId:
      place.layerDomains.get("inside"),
    position: { x: 0, y: 0 },
    mobility: { speed: 1 },
    journey: null
  };
  const bridge = {
    getEntity() {
      return entity;
    },
    planLocalRoute() {
      return {
        estimatedSeconds: 5
      };
    },
    startLocalJourney(
      id,
      destinationNodeId
    ) {
      entity.journey = {
        destinationNodeId
      };
      return true;
    },
    stopLocalJourney() {
      entity.journey = null;
    },
    transferEntity() {}
  };

  assert.ok(
    startTravel(
      places,
      bridge,
      "hans",
      { placeId: "house" }
    )
  );

  const snapshot =
    serializePlaceCore(places);
  const travel =
    snapshot.activeTravels[0];

  assert.equal(
    travel.plan.resolvedTarget.anchorId,
    "alpha"
  );

  travel.plan.resolvedTarget = {
    placeId: "house",
    anchorId: "beta",
    spaceId: null,
    layerId: "inside",
    domainId:
      place.layerDomains.get("inside"),
    position: { x: 6, y: 0 },
    nodeId: "beta"
  };
  travel.plan.steps[0] = {
    type: "local-journey",
    domainId:
      place.layerDomains.get("inside"),
    destinationNodeId: "beta",
    destinationPosition: {
      x: 6,
      y: 0
    },
    estimatedSeconds: 5
  };
  travel.plan.legs =
    travel.plan.steps;

  assert.throws(
    () =>
      validatePlaceCoreSnapshot(
        snapshot
      ),
    /implicit anchor selection/
  );
});


test("fresh direct snapshots reject invented null-context fields", () => {
  const places = new PlaceRegistry();
  places.registerDefinition({
    id: "direct-portal-target",
    layers: [
      { id: "a" },
      { id: "b" }
    ],
    portals: [{
      id: "door",
      transitionCost: 5,
      a: {
        kind: "local",
        layerId: "a",
        position: { x: 0, y: 0 },
        nodeId: "a-door"
      },
      b: {
        kind: "local",
        layerId: "b",
        position: { x: 10, y: 0 },
        nodeId: "b-door"
      }
    }]
  });
  const place = places.createPlace({
    id: "house",
    definitionId:
      "direct-portal-target"
  });
  const entity = {
    id: "hans",
    domainId:
      place.layerDomains.get("a"),
    position: { x: 0, y: 0 },
    mobility: { speed: 1 },
    journey: null
  };
  const targetDomain =
    place.layerDomains.get("b");
  const bridge = {
    getEntity() {
      return entity;
    },
    planLocalRoute() {
      throw new Error(
        "zero-distance plan must not query local routing"
      );
    },
    startLocalJourney() {
      throw new Error(
        "portal-only plan must not start a local journey"
      );
    },
    stopLocalJourney() {},
    transferEntity() {
      throw new Error(
        "transition delay should keep travel before transfer"
      );
    }
  };

  assert.ok(
    startTravel(
      places,
      bridge,
      "hans",
      {
        domainId: targetDomain,
        position: { x: 10, y: 0 }
      }
    )
  );

  const snapshot =
    serializePlaceCore(places);
  snapshot.activeTravels[0]
    .plan.resolvedTarget.nodeId =
      "invented-node";

  assert.throws(
    () =>
      validatePlaceCoreSnapshot(
        snapshot
      ),
    /resolved target no longer matches direct target/
  );
});


test("fresh snapshots bind portal-only plan endings to the resolved target", () => {
  const places = new PlaceRegistry();
  places.registerDefinition({
    id: "portal-exit-target",
    layers: [
      { id: "a" },
      { id: "b" }
    ],
    portals: [
      {
        id: "target-door",
        transitionCost: 5,
        a: {
          kind: "local",
          layerId: "a",
          position: { x: 0, y: 0 },
          nodeId: "a-target"
        },
        b: {
          kind: "local",
          layerId: "b",
          position: { x: 10, y: 0 },
          nodeId: "b-target"
        }
      },
      {
        id: "other-door",
        transitionCost: 5,
        a: {
          kind: "local",
          layerId: "a",
          position: { x: 0, y: 0 },
          nodeId: "a-other"
        },
        b: {
          kind: "local",
          layerId: "b",
          position: { x: 20, y: 0 },
          nodeId: "b-other"
        }
      }
    ],
    anchors: [{
      id: "exit",
      layerId: "b",
      position: { x: 10, y: 0 },
      nodeId: "b-target"
    }]
  });
  const place = places.createPlace({
    id: "house",
    definitionId:
      "portal-exit-target"
  });
  const entity = {
    id: "hans",
    domainId:
      place.layerDomains.get("a"),
    position: { x: 0, y: 0 },
    mobility: { speed: 1 },
    journey: null
  };
  const bridge = {
    getEntity() {
      return entity;
    },
    planLocalRoute({
      destinationNodeId
    }) {
      assert.equal(
        destinationNodeId,
        "b-target"
      );
      return {
        estimatedSeconds: 10
      };
    },
    startLocalJourney() {
      throw new Error(
        "portal-only plan must not start a local journey"
      );
    },
    stopLocalJourney() {},
    transferEntity() {
      throw new Error(
        "transition delay should keep travel before transfer"
      );
    }
  };

  assert.ok(
    startTravel(
      places,
      bridge,
      "hans",
      {
        placeId: "house",
        anchorId: "exit"
      }
    )
  );

  const snapshot =
    serializePlaceCore(places);
  const travel =
    snapshot.activeTravels[0];
  const original =
    travel.plan.steps.at(-1);

  assert.equal(
    original.type,
    "traverse-portal"
  );
  assert.equal(
    original.portalId,
    "target-door"
  );

  const other =
    places.findPortalEndpointsNear(
      place.layerDomains.get("a"),
      { x: 0, y: 0 },
      0
    ).find(
      (match) =>
        match.portal.id ===
          "other-door"
    )?.portal;

  assert.ok(other?.key);

  travel.plan.steps[
    travel.plan.steps.length - 1
  ] = {
    type: "traverse-portal",
    portalKey: other.key,
    placeId: "house",
    portalId: "other-door",
    fromDomainId:
      place.layerDomains.get("a"),
    toDomainId:
      place.layerDomains.get("b"),
    destinationPosition: {
      x: 20,
      y: 0
    },
    transitionCost: 5
  };
  travel.plan.legs =
    travel.plan.steps;

  assert.throws(
    () =>
      validatePlaceCoreSnapshot(
        snapshot
      ),
    /final portal step no longer matches resolved target/
  );
});

test("pending saved travel state uses full active-state validation", () => {
  const places = new PlaceRegistry();
  places.registerDefinition({
    id: "pending-state-validation",
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
    definitionId:
      "pending-state-validation"
  });
  const entity = {
    id: "hans",
    domainId:
      place.layerDomains.get("inside"),
    position: { x: 0, y: 0 },
    mobility: { speed: 1 },
    journey: null
  };
  const bridge = {
    getEntity() {
      return entity;
    },
    planLocalRoute() {
      return {
        estimatedSeconds: 5
      };
    },
    startLocalJourney() {
      entity.journey = {
        active: true
      };
      return true;
    },
    stopLocalJourney() {
      entity.journey = null;
    },
    transferEntity() {}
  };

  assert.ok(
    startTravel(
      places,
      bridge,
      "hans",
      {
        placeId: "house",
        anchorId: "target"
      }
    )
  );

  const snapshot =
    serializePlaceCore(places);
  const saved =
    structuredClone(
      snapshot.activeTravels[0]
    );
  snapshot.activeTravels = [];
  snapshot.pendingTravels = [{
    entityId: saved.entityId,
    target:
      structuredClone(saved.target),
    savedState: saved
  }];

  snapshot.pendingTravels[0]
    .savedState.plan.estimatedSeconds +=
      1;

  assert.throws(
    () =>
      validatePlaceCoreSnapshot(
        snapshot
      ),
    /estimatedSeconds.*mismatch|estimated.*step.*sum/i
  );
});


test("fresh travel snapshots cannot reference a missing target place", () => {
  const places = new PlaceRegistry();
  places.registerDefinition({
    id: "fresh-target-place",
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
    definitionId: "fresh-target-place"
  });
  const entity = {
    id: "hans",
    domainId:
      place.layerDomains.get("inside"),
    position: { x: 0, y: 0 },
    mobility: { speed: 1 },
    journey: null
  };
  const bridge = {
    getEntity() {
      return entity;
    },
    planLocalRoute() {
      return { estimatedSeconds: 5 };
    },
    startLocalJourney() {
      entity.journey = {
        destinationNodeId: "target"
      };
      return true;
    },
    stopLocalJourney() {
      entity.journey = null;
    },
    transferEntity() {}
  };

  assert.ok(
    startTravel(
      places,
      bridge,
      "hans",
      {
        placeId: "house",
        anchorId: "target"
      }
    )
  );

  const fresh =
    serializePlaceCore(places);
  assert.equal(
    fresh.activeTravels[0].planStale,
    false
  );

  const missingPlanStale =
    structuredClone(fresh);
  delete missingPlanStale
    .activeTravels[0].planStale;
  assert.throws(
    () =>
      validatePlaceCoreSnapshot(
        missingPlanStale
      ),
    /planStale must be a boolean/
  );

  const missingRejectedPairs =
    structuredClone(fresh);
  delete missingRejectedPairs
    .activeTravels[0]
    .plan.rejectedDomainPairs;
  assert.throws(
    () =>
      validatePlaceCoreSnapshot(
        missingRejectedPairs
      ),
    /missing required field rejectedDomainPairs/
  );

  for (const field of [
    "worldChangePolicy",
    "portalEntryTolerance"
  ]) {
    const missingOption =
      structuredClone(fresh);
    delete missingOption
      .activeTravels[0]
      .options[field];

    assert.throws(
      () =>
        validatePlaceCoreSnapshot(
          missingOption
        ),
      new RegExp(
        `options is missing required field ${field}`
      )
    );
  }

  fresh.instances = [];

  assert.throws(
    () =>
      validatePlaceCoreSnapshot(
        fresh
      ),
    /fresh plan references missing target place house/
  );

  const stale =
    serializePlaceCore(places);
  stale.activeTravels[0].planStale =
    true;
  stale.instances = [];

  assert.doesNotThrow(
    () =>
      validatePlaceCoreSnapshot(
        stale
      )
  );

  const pending =
    serializePlaceCore(
      deserializePlaceCore(
        serializePlaceCore(places),
        { restartTravels: false }
      )
    );
  assert.equal(
    pending.pendingTravels[0]
      .savedState.planStale,
    true
  );
  pending.pendingTravels[0]
    .savedState.planStale = false;

  assert.throws(
    () =>
      validatePlaceCoreSnapshot(
        pending
      ),
    /savedState\.planStale must be true/
  );
});


test("fresh travel snapshots require every portal step to still resolve", () => {
  const places = new PlaceRegistry();
  places.registerDefinition({
    id: "fresh-portal-plan",
    layers: [
      { id: "a" },
      { id: "b" }
    ],
    portals: [{
      id: "door",
      a: {
        kind: "local",
        layerId: "a",
        position: { x: 1, y: 0 },
        nodeId: "a-door"
      },
      b: {
        kind: "local",
        layerId: "b",
        position: { x: 0, y: 0 },
        nodeId: "b-door"
      }
    }],
    anchors: [{
      id: "target",
      layerId: "b",
      position: { x: 5, y: 0 },
      nodeId: "target"
    }]
  });
  const place = places.createPlace({
    id: "house",
    definitionId: "fresh-portal-plan"
  });
  const entity = {
    id: "hans",
    domainId:
      place.layerDomains.get("a"),
    position: { x: 0, y: 0 },
    mobility: { speed: 1 },
    journey: null
  };
  const positions = new Map([
    ["a-door", { x: 1, y: 0 }],
    ["b-door", { x: 0, y: 0 }],
    ["target", { x: 5, y: 0 }]
  ]);
  const bridge = {
    getEntity() {
      return entity;
    },
    planLocalRoute({
      position,
      destinationNodeId
    }) {
      const target =
        positions.get(
          destinationNodeId
        );
      if (!target) return null;
      return {
        estimatedSeconds:
          Math.abs(
            target.x - position.x
          ) +
          Math.abs(
            target.y - position.y
          )
      };
    },
    startLocalJourney(
      id,
      destinationNodeId
    ) {
      entity.journey = {
        destinationNodeId
      };
      return true;
    },
    stopLocalJourney() {
      entity.journey = null;
    },
    transferEntity() {}
  };

  assert.ok(
    startTravel(
      places,
      bridge,
      "hans",
      {
        placeId: "house",
        anchorId: "target"
      }
    )
  );

  const blocked =
    serializePlaceCore(places);
  blocked.instances[0]
    .portalOverrides.door = {
      locked: true
    };

  assert.throws(
    () =>
      validatePlaceCoreSnapshot(
        blocked
      ),
    /fresh plan step.*non-traversable portal door/
  );

  const wrongPortalEntry =
    serializePlaceCore(places);
  const portalIndex =
    wrongPortalEntry.activeTravels[0]
      .plan.steps.findIndex(
        (step) =>
          step.type ===
          "traverse-portal"
      );
  const entryStep =
    wrongPortalEntry.activeTravels[0]
      .plan.steps[portalIndex - 1];
  assert.equal(
    entryStep.type,
    "local-journey"
  );
  entryStep.destinationPosition.x +=
    1;
  wrongPortalEntry.activeTravels[0]
    .plan.legs =
      structuredClone(
        wrongPortalEntry.activeTravels[0]
          .plan.steps
      );

  assert.throws(
    () =>
      validatePlaceCoreSnapshot(
        wrongPortalEntry
      ),
    /local step before portal.*no longer matches portal entry/
  );

  const wrongFinalLeg =
    serializePlaceCore(places);
  const finalLeg =
    wrongFinalLeg.activeTravels[0]
      .plan.steps.at(-1);
  assert.equal(
    finalLeg.type,
    "local-journey"
  );
  finalLeg.destinationPosition.x +=
    1;
  wrongFinalLeg.activeTravels[0]
    .plan.legs =
      structuredClone(
        wrongFinalLeg.activeTravels[0]
          .plan.steps
      );

  assert.throws(
    () =>
      validatePlaceCoreSnapshot(
        wrongFinalLeg
      ),
    /final local step no longer matches resolved target/
  );

  const wrongCost =
    serializePlaceCore(places);
  const wrongCostStep =
    wrongCost.activeTravels[0]
      .plan.steps.find(
        (step) =>
          step.type ===
          "traverse-portal"
      );
  wrongCostStep.transitionCost += 1;
  wrongCost.activeTravels[0]
    .plan.estimatedSeconds += 1;
  wrongCost.activeTravels[0]
    .plan.legs =
      structuredClone(
        wrongCost.activeTravels[0]
          .plan.steps
      );

  assert.throws(
    () =>
      validatePlaceCoreSnapshot(
        wrongCost
      ),
    /portal transitionCost no longer matches snapshot state/
  );

  const fresh =
    serializePlaceCore(places);
  const portalStep =
    fresh.activeTravels[0]
      .plan.steps.find(
        (step) =>
          step.type ===
          "traverse-portal"
      );
  assert.ok(portalStep);
  portalStep.placeId = "missing-house";
  portalStep.portalKey =
    "6:string20:string:missing-house6:string4:door";
  fresh.activeTravels[0].plan.legs =
    structuredClone(
      fresh.activeTravels[0]
        .plan.steps
    );

  assert.throws(
    () =>
      validatePlaceCoreSnapshot(
        fresh
      ),
    /fresh plan step.*missing portal place/
  );

  const stale =
    serializePlaceCore(places);
  const stalePortal =
    stale.activeTravels[0]
      .plan.steps.find(
        (step) =>
          step.type ===
          "traverse-portal"
      );
  stale.activeTravels[0].planStale =
    true;
  stalePortal.placeId =
    "missing-house";
  stalePortal.portalKey =
    "6:string20:string:missing-house6:string4:door";
  stale.activeTravels[0].plan.legs =
    structuredClone(
      stale.activeTravels[0]
        .plan.steps
    );

  assert.doesNotThrow(
    () =>
      validatePlaceCoreSnapshot(
        stale
      )
  );
});


test("direct travel snapshot context does not require live place references", () => {
  const places = new PlaceRegistry();
  const entity = {
    id: "hans",
    domainId: "street",
    position: { x: 0, y: 0 },
    mobility: { speed: 1 },
    journey: null
  };
  const bridge = {
    getEntity() {
      return entity;
    },
    planLocalRoute() {
      return { estimatedSeconds: 5 };
    },
    startLocalJourney() {
      entity.journey = {
        destinationNodeId: "target"
      };
      return true;
    },
    stopLocalJourney() {
      entity.journey = null;
    },
    transferEntity() {}
  };

  assert.ok(
    startTravel(
      places,
      bridge,
      "hans",
      {
        domainId: "street",
        position: { x: 5, y: 0 },
        nodeId: "target",
        placeId: "context-only",
        anchorId: "context-anchor",
        spaceId: "context-space",
        layerId: "context-layer"
      }
    )
  );

  const snapshot =
    serializePlaceCore(places);
  assert.equal(
    snapshot.activeTravels[0]
      .planStale,
    false
  );

  assert.doesNotThrow(
    () =>
      validatePlaceCoreSnapshot(
        snapshot
      )
  );
});


test("fresh semantic travel target must still match its anchor", () => {
  const places = new PlaceRegistry();
  places.registerDefinition({
    id: "fresh-anchor-target",
    layers: [{ id: "inside" }],
    anchors: [{
      id: "target",
      layerId: "inside",
      position: { x: 5, y: 0 },
      nodeId: "target-node"
    }]
  });
  const place = places.createPlace({
    id: "house",
    definitionId:
      "fresh-anchor-target"
  });
  const entity = {
    id: "hans",
    domainId:
      place.layerDomains.get("inside"),
    position: { x: 0, y: 0 },
    mobility: { speed: 1 },
    journey: null
  };
  const bridge = {
    getEntity() {
      return entity;
    },
    planLocalRoute() {
      return { estimatedSeconds: 5 };
    },
    startLocalJourney() {
      entity.journey = {
        destinationNodeId:
          "target-node"
      };
      return true;
    },
    stopLocalJourney() {
      entity.journey = null;
    },
    transferEntity() {}
  };

  assert.ok(
    startTravel(
      places,
      bridge,
      "hans",
      {
        placeId: "house",
        anchorId: "target"
      }
    )
  );

  const snapshot =
    serializePlaceCore(places);
  snapshot.activeTravels[0]
    .plan.resolvedTarget.position.x =
      6;
  snapshot.activeTravels[0]
    .plan.steps.at(-1)
    .destinationPosition.x = 6;
  snapshot.activeTravels[0]
    .plan.legs =
      structuredClone(
        snapshot.activeTravels[0]
          .plan.steps
      );

  assert.throws(
    () =>
      validatePlaceCoreSnapshot(
        snapshot
      ),
    /target anchor no longer matches/
  );
});


test("fresh semantic travel target cannot remain in a disabled ancestor space", () => {
  const places = new PlaceRegistry();
  places.registerDefinition({
    id: "fresh-space-target",
    layers: [{ id: "inside" }],
    spaces: [
      {
        id: "floor",
        layerId: "inside",
        geometry: {
          type: "aabb",
          minX: 0,
          minY: -1,
          maxX: 10,
          maxY: 1
        }
      },
      {
        id: "room",
        parentSpaceId: "floor",
        layerId: "inside",
        geometry: {
          type: "aabb",
          minX: 0,
          minY: -1,
          maxX: 10,
          maxY: 1
        }
      }
    ],
    anchors: [{
      id: "target",
      layerId: "inside",
      spaceId: "room",
      position: { x: 5, y: 0 },
      nodeId: "target"
    }]
  });
  const place = places.createPlace({
    id: "house",
    definitionId: "fresh-space-target"
  });
  const entity = {
    id: "hans",
    domainId:
      place.layerDomains.get("inside"),
    position: { x: 0, y: 0 },
    mobility: { speed: 1 },
    journey: null
  };
  const bridge = {
    getEntity() {
      return entity;
    },
    planLocalRoute() {
      return { estimatedSeconds: 5 };
    },
    startLocalJourney() {
      entity.journey = {
        destinationNodeId: "target"
      };
      return true;
    },
    stopLocalJourney() {
      entity.journey = null;
    },
    transferEntity() {}
  };

  assert.ok(
    startTravel(
      places,
      bridge,
      "hans",
      {
        placeId: "house",
        anchorId: "target"
      }
    )
  );

  const snapshot =
    serializePlaceCore(places);
  snapshot.instances[0]
    .spaceOverrides.floor = {
      enabled: false
    };

  assert.throws(
    () =>
      validatePlaceCoreSnapshot(
        snapshot
      ),
    /target (?:anchor is in a disabled space|space is disabled)/
  );
});


test("fresh nearest travel target must still satisfy anchor filters", () => {
  const places = new PlaceRegistry();
  places.registerDefinition({
    id: "nearest-filter-place",
    layers: [{ id: "inside" }],
    anchors: [
      {
        id: "goal",
        layerId: "inside",
        position: { x: 5, y: 0 },
        nodeId: "target-node",
        tags: ["goal"],
        kind: "counter"
      },
      {
        id: "other",
        layerId: "inside",
        position: { x: 5, y: 0 },
        nodeId: "target-node",
        tags: ["other"],
        kind: "counter"
      }
    ]
  });
  const place = places.createPlace({
    id: "house",
    definitionId:
      "nearest-filter-place"
  });
  const entity = {
    id: "hans",
    domainId:
      place.layerDomains.get("inside"),
    position: { x: 0, y: 0 },
    mobility: { speed: 1 },
    journey: null
  };
  const bridge = {
    getEntity() {
      return entity;
    },
    planLocalRoute() {
      return { estimatedSeconds: 5 };
    },
    startLocalJourney() {
      entity.journey = {
        destinationNodeId:
          "target-node"
      };
      return true;
    },
    stopLocalJourney() {
      entity.journey = null;
    },
    transferEntity() {}
  };

  assert.ok(
    startTravel(
      places,
      bridge,
      "hans",
      {
        kind: "nearest",
        tag: "goal",
        anchorKind: "counter"
      }
    )
  );

  const snapshot =
    serializePlaceCore(places);
  snapshot.activeTravels[0]
    .plan.resolvedTarget.anchorId =
      "other";

  assert.throws(
    () =>
      validatePlaceCoreSnapshot(
        snapshot
      ),
    /nearest target anchor no longer matches tag goal/
  );
});




test("snapshot validation rejects portal road bindings in unrelated domains", () => {
  const places = new PlaceRegistry();

  places.registerDefinition({
    id: "snapshot-binding-domain-place",
    layers: [
      {
        id: "ground",
        navigation: {
          nodes: [
            { id: "ga", x: 0, y: 0 },
            { id: "gb", x: 1, y: 0 }
          ],
          roads: [{
            id: "ground-road",
            from: "ga",
            to: "gb"
          }]
        }
      },
      {
        id: "cellar",
        navigation: {
          nodes: [
            { id: "ca", x: 0, y: 0 },
            { id: "cb", x: 1, y: 0 }
          ],
          roads: [{
            id: "cellar-road",
            from: "ca",
            to: "cb"
          }]
        }
      }
    ]
  });

  const place = places.createPlace({
    id: "house",
    definitionId:
      "snapshot-binding-domain-place"
  });

  places.addPortal(
    "house",
    {
      id: "dynamic-door",
      a: {
        domainId: "street",
        position: { x: 10, y: 0 },
        nodeId: "street-door"
      },
      b: {
        domainId:
          place.layerDomains.get(
            "ground"
          ),
        position: { x: 0, y: 0 },
        nodeId: "ga"
      },
      roadBindings: [{
        layerId: "ground",
        roadId: "ground-road"
      }]
    }
  );

  const snapshot =
    serializePlaceCore(places);

  const dynamic =
    snapshot.instances[0]
      .dynamicPortals[0];
  dynamic.roadBindings = [{
    layerId: "cellar",
    roadId: "cellar-road"
  }];

  assert.throws(
    () =>
      validatePlaceCoreSnapshot(
        snapshot
      ),
    /road binding cellar-road belongs to unrelated domain house:cellar/
  );
});
