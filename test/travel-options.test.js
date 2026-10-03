import test from "node:test";
import assert from "node:assert/strict";

import {
  PlaceRegistry,
  deserializePlaceCore,
  domainPairKey,
  findDomainPortalPath,
  planTravel,
  serializePlaceCore,
  startTravel,
  stepPlaceSimulation,
  stepTravel,
  stopTravel
} from "../src/index.js";

function twoLayerDefinition() {
  return {
    id: "two-layer-travel",
    layers: [{ id: "a" }, { id: "b" }],
    portals: [{
      id: "stairs",
      a: {
        kind: "local",
        layerId: "a",
        position: { x: 5, y: 0 },
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
  };
}

function twoLayerRuntime() {
  const places = new PlaceRegistry();
  places.registerDefinition(twoLayerDefinition());
  const place = places.createPlace({
    id: "house",
    definitionId: "two-layer-travel"
  });

  const entity = {
    id: "hans",
    domainId: place.layerDomains.get("a"),
    position: { x: 0, y: 0 },
    mobility: { speed: 1 },
    journey: null,
    lastJourneyFailure: null
  };

  const nodes = new Map([
    ["a-door", { x: 5, y: 0 }],
    ["b-door", { x: 0, y: 0 }],
    ["target", { x: 5, y: 0 }]
  ]);
  const started = [];

  const bridge = {
    getEntity(id) {
      return id === "hans" ? entity : null;
    },
    planLocalRoute({ position, destinationNodeId }) {
      const target = nodes.get(destinationNodeId);
      if (!target) return null;
      return {
        estimatedSeconds:
          Math.abs(position.x - target.x) +
          Math.abs(position.y - target.y)
      };
    },
    startLocalJourney(id, destinationNodeId, options) {
      if (id !== "hans") return false;
      started.push({
        destinationNodeId,
        options: structuredClone(options ?? null)
      });
      entity.journey = { destinationNodeId };
      return true;
    },
    stopLocalJourney() {
      entity.journey = null;
    },
    transferEntity(id, endpoint) {
      assert.equal(id, "hans");
      entity.domainId = endpoint.domainId;
      entity.position = { ...endpoint.position };
      entity.journey = null;
      return entity;
    }
  };

  return { places, place, entity, bridge, started };
}

test("journey options survive portal transitions and later local legs", () => {
  const { places, entity, bridge, started } = twoLayerRuntime();
  const journeyOptions = {
    entryMaxDistance: 3,
    maxEntryCandidates: 7,
    custom: { avoid: "mud" }
  };

  const travel = startTravel(
    places,
    bridge,
    "hans",
    { placeId: "house", anchorId: "target" },
    { journeyOptions }
  );

  assert.ok(travel);
  assert.deepEqual(started, [{
    destinationNodeId: "a-door",
    options: journeyOptions
  }]);

  entity.position = { x: 5, y: 0 };
  entity.journey = null;
  stepTravel(places, bridge, "hans");

  assert.equal(entity.domainId, "house:b");
  assert.deepEqual(started, [
    { destinationNodeId: "a-door", options: journeyOptions },
    { destinationNodeId: "target", options: journeyOptions }
  ]);
  assert.deepEqual(travel.options.journeyOptions, journeyOptions);
});

test("bridge planning option mutation cannot alter retained travel state", () => {
  const {
    places,
    bridge
  } = twoLayerRuntime();

  const planLocalRoute =
    bridge.planLocalRoute.bind(bridge);

  bridge.planLocalRoute = (input) => {
    input.options.custom.avoid =
      "water";
    return planLocalRoute(input);
  };

  const travel = startTravel(
    places,
    bridge,
    "hans",
    {
      placeId: "house",
      anchorId: "target"
    },
    {
      journeyOptions: {
        custom: {
          avoid: "mud"
        }
      }
    }
  );

  assert.ok(travel);
  assert.deepEqual(
    travel.options.journeyOptions,
    {
      custom: {
        avoid: "mud"
      }
    }
  );
});


test("bridge journey option mutation cannot alter retained travel state", () => {
  const {
    places,
    bridge,
    entity
  } = twoLayerRuntime();

  bridge.startLocalJourney = (
    id,
    destinationNodeId,
    options
  ) => {
    assert.equal(id, "hans");
    options.custom.avoid = "water";
    entity.journey = {
      destinationNodeId
    };
    return true;
  };

  const travel = startTravel(
    places,
    bridge,
    "hans",
    {
      placeId: "house",
      anchorId: "target"
    },
    {
      journeyOptions: {
        custom: {
          avoid: "mud"
        }
      }
    }
  );

  assert.ok(travel);
  assert.deepEqual(
    travel.options.journeyOptions,
    {
      custom: {
        avoid: "mud"
      }
    }
  );
  assert.deepEqual(
    serializePlaceCore(places)
      .activeTravels[0]
      .options
      .journeyOptions,
    {
      custom: {
        avoid: "mud"
      }
    }
  );
});


test("anchor predicates survive eager replanning", () => {
  const places = new PlaceRegistry();
  places.registerDefinition({
    id: "service-place",
    layers: [{ id: "inside" }],
    portals: [{
      id: "door",
      a: { kind: "external", slot: "street" },
      b: {
        kind: "local",
        layerId: "inside",
        position: { x: 0, y: 0 },
        nodeId: "door"
      }
    }],
    anchors: [{
      id: "counter",
      layerId: "inside",
      tags: ["service"],
      position: { x: 1, y: 0 },
      nodeId: "counter"
    }]
  });

  for (const [id, x] of [
    ["closed-shop", 5],
    ["open-shop", 20],
    ["trigger-shop", 100]
  ]) {
    places.createPlace({
      id,
      definitionId: "service-place",
      attachments: {
        street: {
          domainId: "street",
          position: { x, y: 0 },
          nodeId: `${id}-street`
        }
      }
    });
  }

  const entity = {
    id: "hans",
    domainId: "street",
    position: { x: 0, y: 0 },
    mobility: { speed: 1 },
    journey: null,
    lastJourneyFailure: null
  };
  const nodeX = new Map([
    ["closed-shop-street", 5],
    ["open-shop-street", 20],
    ["trigger-shop-street", 100],
    ["door", 0],
    ["counter", 1]
  ]);
  const bridge = {
    getEntity(id) { return id === "hans" ? entity : null; },
    planLocalRoute({ position, destinationNodeId }) {
      const x = nodeX.get(destinationNodeId);
      return x == null ? null : { estimatedSeconds: Math.abs(position.x - x) };
    },
    startLocalJourney(id, destinationNodeId) {
      entity.journey = { destinationNodeId };
      return true;
    },
    stopLocalJourney() { entity.journey = null; },
    transferEntity() {}
  };

  const predicate = (anchor) => anchor.placeId === "open-shop";
  const travel = startTravel(
    places,
    bridge,
    "hans",
    { kind: "nearest", tag: "service" },
    {
      worldChangePolicy: "eager",
      anchorPredicate: predicate
    }
  );

  assert.ok(travel);
  assert.equal(travel.plan.resolvedTarget.placeId, "open-shop");

  places.setPortalState(
    "trigger-shop",
    "door",
    { locked: true }
  );
  const current = stepTravel(
    places,
    bridge,
    "hans"
  );

  assert.equal(current.replans, 1);
  assert.equal(
    current.plan.resolvedTarget.placeId,
    "open-shop"
  );
  assert.equal(
    current.options.anchorPredicate,
    predicate
  );
});

test("serializable retained travel options survive snapshot restart", () => {
  const { places, bridge, started } = twoLayerRuntime();
  const travel = startTravel(
    places,
    bridge,
    "hans",
    { placeId: "house", anchorId: "target" },
    {
      worldChangePolicy: "eager",
      portalEntryTolerance: 0.75,
      journeyOptions: { entryMaxDistance: 4 },
      maxDomainPathAttempts: 9
    }
  );
  assert.ok(travel);

  const snapshot = serializePlaceCore(places);
  const saved = snapshot.activeTravels[0];
  assert.deepEqual(saved.options, {
    journeyOptions: { entryMaxDistance: 4 },
    maxDomainPathAttempts: 9,
    portalEntryTolerance: 0.75,
    worldChangePolicy: "eager"
  });

  started.length = 0;
  const restored = deserializePlaceCore(snapshot, {
    bridge,
    restartTravels: true
  });
  const restarted = restored.activeTravels.get("hans");

  assert.ok(restarted);
  assert.equal(restarted.worldChangePolicy, "eager");
  assert.equal(restarted.options.portalEntryTolerance, 0.75);
  assert.deepEqual(restarted.options.journeyOptions, { entryMaxDistance: 4 });
  assert.equal(started[0].options.entryMaxDistance, 4);
});

test("snapshotting refuses to silently drop function predicates", () => {
  const places = new PlaceRegistry();
  places.registerDefinition({
    id: "predicate-place",
    layers: [{ id: "inside" }],
    anchors: [{
      id: "target",
      layerId: "inside",
      tags: ["service"],
      position: { x: 5, y: 0 },
      nodeId: "target"
    }]
  });
  const place = places.createPlace({
    id: "house",
    definitionId: "predicate-place"
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

  const travel = startTravel(
    places,
    bridge,
    "hans",
    { kind: "nearest", tag: "service" },
    { anchorPredicate: () => true }
  );
  assert.ok(travel);

  assert.throws(
    () => serializePlaceCore(places),
    /cannot serialize active travel with anchorPredicate/
  );
});


test("travel search limits reject invalid values consistently", () => {
  const { places, bridge } = twoLayerRuntime();

  const invalid = [
    ["maxDomainPathAttempts", 0],
    ["maxShortestDomainPaths", 1.5],
    ["maxConcreteStatesPerLayer", -1],
    ["maxNearestTargetExpansions", Number.NaN],
    ["maxCost", -1],
    ["allowPartialShortestPathSearch", "true"]
  ];

  for (const [key, value] of invalid) {
    assert.throws(
      () => planTravel(
        places,
        bridge,
        "hans",
        { placeId: "house", anchorId: "target" },
        { [key]: value }
      ),
      new RegExp(key)
    );

    assert.throws(
      () => startTravel(
        places,
        bridge,
        "hans",
        { placeId: "house", anchorId: "target" },
        { [key]: value }
      ),
      new RegExp(key)
    );
  }
});

test("maxCost zero still permits a zero-cost semantic target", () => {
  const places = new PlaceRegistry();
  places.registerDefinition({
    id: "zero-cost-place",
    layers: [{ id: "inside" }],
    anchors: [{
      id: "here",
      layerId: "inside",
      tags: ["service"],
      position: { x: 0, y: 0 },
      nodeId: "here"
    }]
  });
  const place = places.createPlace({
    id: "room",
    definitionId: "zero-cost-place"
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
      throw new Error("zero-cost target must not need local routing");
    },
    startLocalJourney() {
      throw new Error("zero-cost target must not start a journey");
    },
    stopLocalJourney() {},
    transferEntity() {}
  };

  const plan = planTravel(
    places,
    bridge,
    "hans",
    { kind: "nearest", tag: "service" },
    { maxCost: 0 }
  );

  assert.ok(plan);
  assert.equal(plan.estimatedSeconds, 0);
  assert.equal(plan.resolvedTarget.anchorId, "here");
});

test("immediate travel completion synchronizes live occupancy", () => {
  const places = new PlaceRegistry();
  places.registerDefinition({
    id: "immediate-complete-place",
    layers: [{ id: "inside" }],
    anchors: [{
      id: "here",
      layerId: "inside",
      position: { x: 0, y: 0 },
      nodeId: "here"
    }]
  });
  const place = places.createPlace({
    id: "room",
    definitionId:
      "immediate-complete-place"
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
      throw new Error(
        "immediate target must not need local routing"
      );
    },
    startLocalJourney() {
      throw new Error(
        "immediate target must not start a journey"
      );
    },
    stopLocalJourney() {},
    transferEntity() {}
  };

  const travel =
    startTravel(
      places,
      bridge,
      "hans",
      {
        placeId: "room",
        anchorId: "here"
      }
    );

  assert.equal(
    travel.status,
    "complete"
  );
  assert.equal(
    places.activeTravels.has("hans"),
    false
  );
  assert.ok(
    places.getEntityLocation("hans")
  );
  assert.deepEqual(
    places.getEntityLocation("hans").places,
    ["room"]
  );
});

test("deltaSeconds rejects invalid simulation deltas instead of clamping", () => {
  const { places, bridge } = twoLayerRuntime();

  const travel = startTravel(
    places,
    bridge,
    "hans",
    { placeId: "house", anchorId: "target" }
  );
  assert.ok(travel);

  for (const deltaSeconds of [
    -0.1,
    Number.NaN,
    Number.POSITIVE_INFINITY
  ]) {
    assert.throws(
      () => stepTravel(
        places,
        bridge,
        "hans",
        { deltaSeconds }
      ),
      /deltaSeconds must be a finite number >= 0/
    );

    assert.throws(
      () => stepPlaceSimulation(
        places,
        bridge,
        deltaSeconds
      ),
      /deltaSeconds must be a finite number >= 0/
    );
  }
});

test("explicit Infinity maxCost remains snapshot-safe by collapsing to the default", () => {
  const { places, bridge } = twoLayerRuntime();

  const travel = startTravel(
    places,
    bridge,
    "hans",
    { placeId: "house", anchorId: "target" },
    { maxCost: Infinity }
  );
  assert.ok(travel);
  assert.equal("maxCost" in travel.options, false);

  assert.doesNotThrow(() =>
    JSON.stringify(serializePlaceCore(places))
  );
});


test("travel options reject unknown fields and string-like exclusion lists", () => {
  const { places, bridge } = twoLayerRuntime();

  for (const call of [
    () => planTravel(
      places,
      bridge,
      "hans",
      { placeId: "house", anchorId: "target" },
      { maxDomianPathAttempts: 3 }
    ),
    () => startTravel(
      places,
      bridge,
      "hans",
      { placeId: "house", anchorId: "target" },
      { maxDomianPathAttempts: 3 }
    )
  ]) {
    assert.throws(
      call,
      /travel options contains unknown field maxDomianPathAttempts/
    );
  }

  for (const [key, value] of [
    ["excludedPortalKeys", "portal-key"],
    ["excludedDomainPairs", "domain-pair"],
    ["excludedPortalKeys", [123]],
    ["excludedDomainPairs", [null]]
  ]) {
    assert.throws(
      () => planTravel(
        places,
        bridge,
        "hans",
        { placeId: "house", anchorId: "target" },
        { [key]: value }
      ),
      new RegExp(key)
    );
  }
});

test("planning and start options reject deltaSeconds instead of silently ignoring it", () => {
  const { places, bridge } = twoLayerRuntime();

  assert.throws(
    () => planTravel(
      places,
      bridge,
      "hans",
      { placeId: "house", anchorId: "target" },
      { deltaSeconds: 1 }
    ),
    /travel options contains unknown field deltaSeconds/
  );

  assert.throws(
    () => startTravel(
      places,
      bridge,
      "hans",
      { placeId: "house", anchorId: "target" },
      { deltaSeconds: 1 }
    ),
    /travel options contains unknown field deltaSeconds/
  );
});

test("step options accept deltaSeconds but reject unknown fields even without active travel", () => {
  const { places, bridge } = twoLayerRuntime();

  assert.equal(
    stepTravel(
      places,
      bridge,
      "missing",
      { deltaSeconds: 0.5 }
    ),
    null
  );

  assert.throws(
    () => stepTravel(
      places,
      bridge,
      "missing",
      { deltSeconds: 0.5 }
    ),
    /travel step options contains unknown field deltSeconds/
  );

  assert.throws(
    () => stepPlaceSimulation(
      places,
      bridge,
      0.5,
      { deltSeconds: 1 }
    ),
    /travel step options contains unknown field deltSeconds/
  );
});

test("domain path API has its own strict exclusion-only option contract", () => {
  const { places, place } = twoLayerRuntime();
  const a = place.layerDomains.get("a");
  const b = place.layerDomains.get("b");
  const portal = places.getPortalsForDomain(a)[0];

  const directPath =
    findDomainPortalPath(
      places,
      a,
      b
    );
  assert.ok(directPath);
  assert.deepEqual(
    directPath.domains,
    [a, b]
  );

  const trivialPath =
    findDomainPortalPath(
      places,
      a,
      a
    );
  assert.deepEqual(
    trivialPath,
    []
  );
  assert.deepEqual(
    trivialPath.domains,
    [a]
  );

  assert.equal(
    findDomainPortalPath(
      places,
      a,
      b,
      {
        excludedPortalKeys: new Set([portal.key])
      }
    ),
    null
  );

  assert.equal(
    findDomainPortalPath(
      places,
      a,
      b,
      {
        excludedDomainPairs: new Set([
          domainPairKey(a, b)
        ])
      }
    ),
    null
  );

  assert.throws(
    () => findDomainPortalPath(
      places,
      a,
      b,
      { maxCost: 5 }
    ),
    /domain path options contains unknown field maxCost/
  );

  assert.throws(
    () => findDomainPortalPath(
      places,
      a,
      b,
      { excludedPortalKeys: portal.key }
    ),
    /excludedPortalKeys must be an iterable of non-empty strings/
  );
});

test("stopTravel accepts only bridge and a non-empty reason", () => {
  const { places, bridge } = twoLayerRuntime();

  assert.throws(
    () => stopTravel(
      places,
      "missing",
      { deltaSeconds: 1 }
    ),
    /stop travel options contains unknown field deltaSeconds/
  );

  assert.throws(
    () => stopTravel(
      places,
      "missing",
      { reason: "" }
    ),
    /reason must be a non-empty string/
  );

  assert.equal(
    stopTravel(
      places,
      "missing",
      { reason: "cancelled-by-test" }
    ),
    false
  );
});


test("delta-only step overrides preserve the travel's retained world-change policy", () => {
  const { places, bridge } = twoLayerRuntime();

  const travel = startTravel(
    places,
    bridge,
    "hans",
    { placeId: "house", anchorId: "target" },
    { worldChangePolicy: "eager" }
  );
  assert.ok(travel);
  assert.equal(travel.worldChangePolicy, "eager");

  places.setPortalState(
    "house",
    "stairs",
    { locked: true }
  );

  const current = stepTravel(
    places,
    bridge,
    "hans",
    { deltaSeconds: 0.5 }
  );

  assert.equal(current.replans, 1);
  assert.equal(current.status, "failed");
  assert.equal(
    current.failureReason,
    "no-route-after-world-change"
  );
});


test("public domain path API cannot bypass validation with internal option names", () => {
  const { places, place } = twoLayerRuntime();
  const a = place.layerDomains.get("a");
  const b = place.layerDomains.get("b");

  assert.throws(
    () => findDomainPortalPath(
      places,
      a,
      b,
      { excludedPairs: new Set() }
    ),
    /domain path options contains unknown field excludedPairs/
  );
});


test("failed replacement travel leaves the existing travel untouched", () => {
  const {
    places,
    entity,
    bridge
  } = twoLayerRuntime();

  const existing = startTravel(
    places,
    bridge,
    "hans",
    {
      placeId: "house",
      anchorId: "target"
    }
  );
  assert.ok(existing);

  const existingJourney =
    structuredClone(entity.journey);

  const replacement = startTravel(
    places,
    bridge,
    "hans",
    {
      domainId: "unreachable-domain",
      position: { x: 0, y: 0 },
      nodeId: "unreachable-node"
    }
  );

  assert.equal(replacement, null);
  assert.deepEqual(
    places.activeTravels.get("hans"),
    existing
  );
  assert.deepEqual(
    entity.journey,
    existingJourney
  );

  assert.throws(
    () => startTravel(
      places,
      bridge,
      "hans",
      {
        placeId: "missing-place"
      }
    ),
    /unknown target place/
  );
  assert.deepEqual(
    places.activeTravels.get("hans"),
    existing
  );
  assert.deepEqual(
    entity.journey,
    existingJourney
  );
});


test("domain pair keys cannot collide on embedded separators", () => {
  assert.notEqual(
    domainPairKey("a\u0000b", "c"),
    domainPairKey("a", "b\u0000c")
  );

  assert.throws(
    () => domainPairKey("", "b"),
    /fromDomainId/
  );
  assert.throws(
    () => domainPairKey("a", ""),
    /toDomainId/
  );
});


test("set-like travel exclusions are retained canonically across iterable order", () => {
  const one = twoLayerRuntime();
  const two = twoLayerRuntime();

  const first = startTravel(
    one.places,
    one.bridge,
    "hans",
    {
      placeId: "house",
      anchorId: "target"
    },
    {
      excludedPortalKeys:
        new Set(["z-unused", "a-unused"]),
      excludedDomainPairs:
        new Set(["z-unused", "a-unused"])
    }
  );
  const second = startTravel(
    two.places,
    two.bridge,
    "hans",
    {
      placeId: "house",
      anchorId: "target"
    },
    {
      excludedPortalKeys:
        new Set(["a-unused", "z-unused"]),
      excludedDomainPairs:
        new Set(["a-unused", "z-unused"])
    }
  );

  assert.ok(first);
  assert.ok(second);

  const firstSaved =
    serializePlaceCore(one.places)
      .activeTravels[0]
      .options;
  const secondSaved =
    serializePlaceCore(two.places)
      .activeTravels[0]
      .options;

  assert.deepEqual(firstSaved, secondSaved);
  assert.deepEqual(
    firstSaved.excludedPortalKeys,
    ["a-unused", "z-unused"]
  );
  assert.deepEqual(
    firstSaved.excludedDomainPairs,
    ["a-unused", "z-unused"]
  );
});


test("public travel state surfaces cannot mutate registry internals", () => {
  const {
    places,
    bridge
  } = twoLayerRuntime();

  const started = startTravel(
    places,
    bridge,
    "hans",
    {
      placeId: "house",
      anchorId: "target"
    },
    {
      journeyOptions: {
        custom: {
          avoid: "mud"
        }
      }
    }
  );
  assert.ok(started);

  assert.equal(
    typeof places.activeTravels.set,
    "undefined"
  );
  assert.equal(
    typeof places.activeTravels.delete,
    "undefined"
  );

  const viewed =
    places.activeTravels.get("hans");
  assert.ok(viewed);

  for (const value of [
    started,
    started.plan,
    started.options,
    started.options.journeyOptions,
    started.options.journeyOptions.custom,
    viewed,
    viewed.plan,
    viewed.options,
    viewed.options.journeyOptions,
    viewed.options.journeyOptions.custom
  ]) {
    assert.equal(
      Object.isFrozen(value),
      true,
      "public travel state must be deeply immutable"
    );
  }

  const pendingRegistry =
    deserializePlaceCore(
      serializePlaceCore(places)
    );
  const pending =
    pendingRegistry.pendingTravels;

  assert.equal(
    Object.isFrozen(pending),
    true
  );
  assert.equal(
    Object.isFrozen(pending[0]),
    true
  );
  assert.throws(
    () => pending.push({}),
    TypeError
  );
});


test("startTravel does not leak active state when initial journey start throws", () => {
  const {
    places,
    bridge,
    entity
  } = twoLayerRuntime();

  bridge.startLocalJourney = () => {
    throw new Error(
      "synthetic journey start failure"
    );
  };

  assert.throws(
    () => startTravel(
      places,
      bridge,
      "hans",
      {
        placeId: "house",
        anchorId: "target"
      }
    ),
    /synthetic journey start failure/
  );

  assert.equal(
    places.activeTravels.size,
    0
  );
  assert.equal(
    entity.journey,
    null
  );
});


test("failed travel state is removed even when local journey cleanup throws", () => {
  const {
    places,
    bridge
  } = twoLayerRuntime();

  const travel = startTravel(
    places,
    bridge,
    "hans",
    {
      placeId: "house",
      anchorId: "target"
    }
  );
  assert.ok(travel);

  bridge.getEntity = () => null;
  bridge.stopLocalJourney = () => {
    throw new Error(
      "synthetic stop cleanup failure"
    );
  };

  assert.throws(
    () =>
      stepTravel(
        places,
        bridge,
        "hans"
      ),
    /synthetic stop cleanup failure/
  );

  assert.equal(
    places.activeTravels.size,
    0
  );
});


test("stopTravel finalizes cancellation even when local cleanup throws", () => {
  const {
    places,
    bridge
  } = twoLayerRuntime();

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

  bridge.stopLocalJourney = () => {
    throw new Error(
      "synthetic cancellation cleanup failure"
    );
  };

  assert.throws(
    () =>
      stopTravel(
        places,
        bridge,
        "hans",
        { reason: "test-cancel" }
      ),
    /synthetic cancellation cleanup failure/
  );

  assert.equal(
    places.activeTravels.size,
    0
  );
});


test("stopTravel preserves falsy cleanup throws", () => {
  const falsyThrows = [
    undefined,
    null,
    false,
    0,
    ""
  ];

  for (const thrown of falsyThrows) {
    const {
      places,
      bridge
    } = twoLayerRuntime();

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

    bridge.stopLocalJourney = () => {
      throw thrown;
    };

    let didThrow = false;
    let caught;
    try {
      stopTravel(
        places,
        bridge,
        "hans",
        { reason: "test-cancel" }
      );
    } catch (error) {
      didThrow = true;
      caught = error;
    }

    assert.equal(didThrow, true);
    assert.equal(caught, thrown);
    assert.equal(
      places.activeTravels.size,
      0
    );
  }
});


test("replan preserves hostile thrown values while finalizing failure", () => {
  const {
    places,
    bridge
  } = twoLayerRuntime();

  assert.ok(
    startTravel(
      places,
      bridge,
      "hans",
      {
        placeId: "house",
        anchorId: "target"
      },
      {
        worldChangePolicy: "eager"
      }
    )
  );

  places.setEventCapture(true);
  places.drainEvents();
  places.setPortalState(
    "house",
    "stairs",
    { locked: true }
  );

  const thrown =
    new Proxy(
      {},
      {
        get(_target, key) {
          if (key === "code") {
            throw new Error(
              "code lookup must not mask the original thrown value"
            );
          }
          return undefined;
        }
      }
    );

  bridge.planLocalRoute = () => {
    throw thrown;
  };

  let caught;
  try {
    stepTravel(
      places,
      bridge,
      "hans"
    );
  } catch (error) {
    caught = error;
  }

  assert.equal(caught, thrown);
  assert.equal(
    places.activeTravels.size,
    0
  );
  assert.ok(
    places.drainEvents().some(
      (event) =>
        event.type === "travel-failed" &&
        event.reason === "replan-error"
    )
  );
});


test("replan cleanup failure does not leave travel active", () => {
  const {
    places,
    bridge
  } = twoLayerRuntime();

  assert.ok(
    startTravel(
      places,
      bridge,
      "hans",
      {
        placeId: "house",
        anchorId: "target"
      },
      {
        worldChangePolicy: "eager"
      }
    )
  );

  places.setPortalState(
    "house",
    "stairs",
    { locked: true }
  );

  bridge.stopLocalJourney = () => {
    throw new Error(
      "synthetic replan cleanup failure"
    );
  };

  assert.throws(
    () =>
      stepTravel(
        places,
        bridge,
        "hans"
      ),
    /synthetic replan cleanup failure/
  );

  assert.equal(
    places.activeTravels.size,
    0
  );
});


test("stepTravel fails cleanly when the live entity identity drifts", () => {
  const {
    places,
    entity,
    bridge
  } = twoLayerRuntime();

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

  bridge.getEntity = (id) => {
    if (id !== "hans") return null;
    return {
      ...entity,
      id: "impostor"
    };
  };

  const current =
    stepTravel(
      places,
      bridge,
      "hans"
    );

  assert.equal(current.status, "failed");
  assert.equal(
    current.failureReason,
    "invalid-entity-state"
  );
  assert.equal(
    places.activeTravels.has("hans"),
    false
  );
  assert.equal(
    places.getEntityLocation("impostor"),
    null
  );
  assert.equal(
    places.getEntityLocation("hans"),
    null
  );
});


test("stepTravel clears occupancy when the live entity disappears", () => {
  const {
    places,
    bridge
  } = twoLayerRuntime();

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

  assert.ok(
    places.getEntityLocation("hans")
  );

  bridge.getEntity = () => null;

  const current =
    stepTravel(
      places,
      bridge,
      "hans"
    );

  assert.equal(
    current.status,
    "failed"
  );
  assert.equal(
    current.failureReason,
    "entity-missing"
  );
  assert.equal(
    places.activeTravels.has("hans"),
    false
  );
  assert.equal(
    places.getEntityLocation("hans"),
    null
  );
});


test("stepTravel finalizes travel when a replanned local journey start throws", () => {
  const {
    places,
    bridge
  } = twoLayerRuntime();

  assert.ok(
    startTravel(
      places,
      bridge,
      "hans",
      {
        placeId: "house",
        anchorId: "target"
      },
      {
        worldChangePolicy: "eager"
      }
    )
  );

  places.setPortalState(
    "house",
    "stairs",
    { locked: true }
  );
  places.setPortalState(
    "house",
    "stairs",
    { locked: false }
  );

  bridge.startLocalJourney = () => {
    throw new Error(
      "synthetic replanned journey start failure"
    );
  };

  assert.throws(
    () =>
      stepTravel(
        places,
        bridge,
        "hans"
      ),
    /synthetic replanned journey start failure/
  );

  assert.equal(
    places.activeTravels.has("hans"),
    false
  );
});


test("stepPlaceSimulation orders active travels deterministically", () => {
  const run = (order) => {
    const places = new PlaceRegistry();
    const entities = new Map(
      ["a", "b"].map((id) => [
        id,
        {
          id,
          domainId: "world",
          position: { x: 0, y: 0 },
          mobility: { speed: 1 },
          journey: null
        }
      ])
    );
    const reads = [];

    const bridge = {
      getEntity(id) {
        reads.push(id);
        return entities.get(id) ?? null;
      },
      planLocalRoute() {
        return { estimatedSeconds: 10 };
      },
      startLocalJourney(
        id,
        destinationNodeId
      ) {
        entities.get(id).journey = {
          destinationNodeId
        };
        return true;
      },
      stopLocalJourney(id) {
        entities.get(id).journey = null;
      }
    };

    for (const id of order) {
      assert.ok(
        startTravel(
          places,
          bridge,
          id,
          {
            domainId: "world",
            position: { x: 10, y: 0 },
            nodeId: "target"
          }
        )
      );
    }

    reads.length = 0;
    stepPlaceSimulation(
      places,
      bridge,
      0
    );
    return reads;
  };

  assert.deepEqual(
    run(["a", "b"]),
    run(["b", "a"])
  );
});


test("stepPlaceSimulation continues later travels after one travel throws", () => {
  const places = new PlaceRegistry();
  const entities = new Map(
    ["a", "b"].map((id) => [
      id,
      {
        id,
        domainId: "world",
        position: { x: 0, y: 0 },
        mobility: { speed: 1 },
        journey: null
      }
    ])
  );
  const stepped = [];

  const bridge = {
    getEntity(id) {
      if (id === "a" && stepped.length === 0) {
        throw new Error(
          "synthetic travel-a step failure"
        );
      }
      stepped.push(id);
      return entities.get(id) ?? null;
    },
    planLocalRoute() {
      return { estimatedSeconds: 10 };
    },
    startLocalJourney(
      id,
      destinationNodeId
    ) {
      entities.get(id).journey = {
        destinationNodeId
      };
      return true;
    },
    stopLocalJourney(id) {
      entities.get(id).journey = null;
    }
  };

  // Avoid the synthetic step failure during setup.
  stepped.push("setup");
  for (const id of ["a", "b"]) {
    assert.ok(
      startTravel(
        places,
        bridge,
        id,
        {
          domainId: "world",
          position: { x: 10, y: 0 },
          nodeId: "target"
        }
      )
    );
    entities.get(id).journey = null;
  }
  stepped.length = 0;

  assert.throws(
    () =>
      stepPlaceSimulation(
        places,
        bridge,
        0
      ),
    /synthetic travel-a step failure/
  );

  assert.ok(
    stepped.includes("b"),
    "later travels must still be stepped"
  );
  assert.equal(
    places.activeTravels.has("a"),
    false
  );
});


test("active travel cannot be stepped through a different runtime bridge", () => {
  const {
    places,
    bridge,
    entity
  } = twoLayerRuntime();

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

  const before =
    places.activeTravels.get("hans");
  const originalJourney =
    structuredClone(entity.journey);

  const foreignBridge = {
    getEntity() {
      throw new Error(
        "foreign bridge must not execute"
      );
    },
    planLocalRoute() {
      throw new Error(
        "foreign bridge must not execute"
      );
    },
    startLocalJourney() {
      throw new Error(
        "foreign bridge must not execute"
      );
    },
    stopLocalJourney() {
      throw new Error(
        "foreign bridge must not execute"
      );
    },
    transferEntity() {
      throw new Error(
        "foreign bridge must not execute"
      );
    }
  };

  assert.throws(
    () =>
      stepTravel(
        places,
        foreignBridge,
        "hans"
      ),
    /WorldCoreBridge that owns the active travel/
  );

  assert.deepEqual(
    places.activeTravels.get("hans"),
    before
  );
  assert.deepEqual(
    entity.journey,
    originalJourney
  );
});


test("stopTravel without an explicit bridge cleans up through the active travel owner", () => {
  const {
    places,
    bridge,
    entity
  } = twoLayerRuntime();

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
  assert.notEqual(
    entity.journey,
    null
  );

  assert.equal(
    stopTravel(
      places,
      "hans"
    ),
    true
  );

  assert.equal(
    entity.journey,
    null
  );
  assert.equal(
    places.activeTravels.has("hans"),
    false
  );
});


test("attached registry bridge cannot be bypassed by an explicit travel bridge", () => {
  const {
    places,
    bridge
  } = twoLayerRuntime();

  places.attachWorldCoreBridge(bridge);

  const foreignBridge = {
    getEntity() {
      throw new Error(
        "foreign bridge must not execute"
      );
    },
    planLocalRoute() {
      throw new Error(
        "foreign bridge must not execute"
      );
    },
    startLocalJourney() {
      throw new Error(
        "foreign bridge must not execute"
      );
    },
    stopLocalJourney() {
      throw new Error(
        "foreign bridge must not execute"
      );
    },
    transferEntity() {
      throw new Error(
        "foreign bridge must not execute"
      );
    }
  };

  assert.throws(
    () =>
      startTravel(
        places,
        foreignBridge,
        "hans",
        {
          placeId: "house",
          anchorId: "target"
        }
      ),
    /different from the one attached to the PlaceRegistry/
  );

  assert.equal(
    places.activeTravels.size,
    0
  );
});


test("registry cannot mix active travel runtime bridges", () => {
  const places = new PlaceRegistry();
  const entity = {
    id: "a",
    domainId: "world",
    position: { x: 0, y: 0 },
    mobility: { speed: 1 },
    journey: null
  };

  const bridge = {
    getEntity(id) {
      return id === "a" ? entity : null;
    },
    planLocalRoute() {
      return { estimatedSeconds: 10 };
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
    }
  };

  assert.ok(
    startTravel(
      places,
      bridge,
      "a",
      {
        domainId: "world",
        position: { x: 10, y: 0 },
        nodeId: "target"
      }
    )
  );

  const foreignBridge = {
    getEntity() {
      throw new Error(
        "foreign bridge must not execute"
      );
    },
    planLocalRoute() {
      throw new Error(
        "foreign bridge must not execute"
      );
    },
    startLocalJourney() {
      throw new Error(
        "foreign bridge must not execute"
      );
    },
    stopLocalJourney() {
      throw new Error(
        "foreign bridge must not execute"
      );
    }
  };

  assert.throws(
    () =>
      startTravel(
        places,
        foreignBridge,
        "b",
        {
          domainId: "world",
          position: { x: 10, y: 0 },
          nodeId: "target"
        }
      ),
    /WorldCoreBridge that owns the active travel/
  );

  assert.equal(
    places.activeTravels.has("a"),
    true
  );
  assert.equal(
    places.activeTravels.has("b"),
    false
  );
  assert.notEqual(
    entity.journey,
    null
  );
});


test("stepPlaceSimulation rejects a foreign bridge even with no active travels", () => {
  const {
    places,
    bridge
  } = twoLayerRuntime();

  places.attachWorldCoreBridge(bridge);

  const foreignBridge = {
    getEntity() {
      throw new Error(
        "foreign bridge must not execute"
      );
    },
    planLocalRoute() {
      throw new Error(
        "foreign bridge must not execute"
      );
    }
  };

  assert.throws(
    () =>
      stepPlaceSimulation(
        places,
        foreignBridge,
        0
      ),
    /different from the one attached to the PlaceRegistry/
  );
});


test("attaching a different bridge cannot strand an active explicit travel", () => {
  const places = new PlaceRegistry();
  const entity = {
    id: "a",
    domainId: "world",
    position: { x: 0, y: 0 },
    mobility: { speed: 1 },
    journey: null
  };

  const bridge = {
    getEntity(id) {
      return id === "a" ? entity : null;
    },
    planLocalRoute() {
      return { estimatedSeconds: 10 };
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
    }
  };

  assert.ok(
    startTravel(
      places,
      bridge,
      "a",
      {
        domainId: "world",
        position: { x: 10, y: 0 },
        nodeId: "target"
      }
    )
  );

  let attachCalls = 0;
  const foreignBridge = {
    attachRegistry() {
      attachCalls += 1;
    }
  };

  assert.throws(
    () =>
      places.attachWorldCoreBridge(
        foreignBridge
      ),
    /different from the one owning active travel/
  );

  assert.equal(attachCalls, 0);
  assert.equal(places.bridge, null);
  assert.equal(
    stopTravel(
      places,
      "a"
    ),
    true
  );
  assert.equal(entity.journey, null);
});


test("replan failure does not stop the same local journey twice", () => {
  const {
    places,
    bridge
  } = twoLayerRuntime();

  assert.ok(
    startTravel(
      places,
      bridge,
      "hans",
      {
        placeId: "house",
        anchorId: "target"
      },
      {
        worldChangePolicy: "eager"
      }
    )
  );

  places.setPortalState(
    "house",
    "stairs",
    { locked: true }
  );

  let stops = 0;
  bridge.stopLocalJourney = () => {
    stops += 1;
    if (stops > 1) {
      throw new Error(
        "local journey stopped twice"
      );
    }
  };

  const result = stepTravel(
    places,
    bridge,
    "hans"
  );

  assert.equal(result.status, "failed");
  assert.equal(
    result.failureReason,
    "no-route-after-world-change"
  );
  assert.equal(stops, 1);
  assert.equal(
    places.activeTravels.size,
    0
  );
});


test("replan planning exception is finalized without duplicate cleanup", () => {
  const {
    places,
    bridge
  } = twoLayerRuntime();

  assert.ok(
    startTravel(
      places,
      bridge,
      "hans",
      {
        placeId: "house",
        anchorId: "target"
      },
      {
        worldChangePolicy: "eager"
      }
    )
  );

  places.setPortalState(
    "house",
    "stairs",
    { locked: true }
  );
  places.setPortalState(
    "house",
    "stairs",
    { locked: false }
  );

  let stops = 0;
  bridge.stopLocalJourney = () => {
    stops += 1;
    if (stops > 1) {
      throw new Error(
        "local journey stopped twice"
      );
    }
  };
  bridge.planLocalRoute = () => {
    throw new Error(
      "synthetic replan planning failure"
    );
  };

  assert.throws(
    () =>
      stepTravel(
        places,
        bridge,
        "hans"
      ),
    /synthetic replan planning failure/
  );

  assert.equal(stops, 1);
  assert.equal(
    places.activeTravels.size,
    0
  );
});


test("eager replan clears stale occupancy when entity disappears before replanning", () => {
  const {
    places,
    bridge
  } = twoLayerRuntime();

  assert.ok(
    startTravel(
      places,
      bridge,
      "hans",
      {
        placeId: "house",
        anchorId: "target"
      },
      {
        worldChangePolicy: "eager"
      }
    )
  );

  assert.ok(
    places.getEntityLocation("hans")
  );

  places.setPortalState(
    "house",
    "stairs",
    { locked: true }
  );
  bridge.getEntity = () => null;

  const current =
    stepTravel(
      places,
      bridge,
      "hans"
    );

  assert.equal(
    current.status,
    "failed"
  );
  assert.equal(
    current.failureReason,
    "entity-missing"
  );
  assert.equal(
    places.getEntityLocation("hans"),
    null
  );
  assert.equal(
    places.activeTravels.has("hans"),
    false
  );
});


test("active local travel replans immediately after an external domain change", () => {
  const {
    places,
    place,
    entity,
    bridge,
    started
  } = twoLayerRuntime();

  let travel = startTravel(
    places,
    bridge,
    "hans",
    {
      placeId: "house",
      anchorId: "target"
    }
  );

  assert.ok(travel);
  assert.equal(
    entity.journey?.destinationNodeId,
    "a-door"
  );

  entity.domainId =
    place.layerDomains.get("b");
  entity.position = { x: 0, y: 0 };

  travel = stepTravel(
    places,
    bridge,
    "hans"
  );

  assert.equal(travel.replans, 1);
  assert.equal(travel.status, "active");
  assert.equal(
    entity.journey?.destinationNodeId,
    "target"
  );
  assert.deepEqual(
    started.map((entry) =>
      entry.destinationNodeId
    ),
    ["a-door", "target"]
  );
});

test("active local travel replans when its world journey is replaced", () => {
  const {
    places,
    entity,
    bridge,
    started
  } = twoLayerRuntime();

  let travel = startTravel(
    places,
    bridge,
    "hans",
    {
      placeId: "house",
      anchorId: "target"
    }
  );

  assert.ok(travel);
  assert.equal(
    entity.journey?.destinationNodeId,
    "a-door"
  );

  entity.journey = {
    destinationNodeId: "foreign-node"
  };

  travel = stepTravel(
    places,
    bridge,
    "hans"
  );

  assert.equal(travel.replans, 1);
  assert.equal(travel.status, "active");
  assert.equal(
    entity.journey?.destinationNodeId,
    "a-door"
  );
  assert.deepEqual(
    started.map((entry) =>
      entry.destinationNodeId
    ),
    ["a-door", "a-door"]
  );
});


test("internal consistency covers active and pending travel runtime state", () => {
  const {
    places,
    bridge
  } = twoLayerRuntime();

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

  assert.doesNotThrow(
    () =>
      places.assertInternalConsistency()
  );

  const snapshot = serializePlaceCore(
    places
  );

  const restored =
    deserializePlaceCore(
      snapshot,
      {
        restartTravels: false
      }
    );

  assert.equal(
    restored.pendingTravels.length,
    1
  );
  assert.doesNotThrow(
    () =>
      restored.assertInternalConsistency()
  );
});
