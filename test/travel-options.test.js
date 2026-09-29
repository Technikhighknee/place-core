import test from "node:test";
import assert from "node:assert/strict";

import {
  PlaceRegistry,
  deserializePlaceCore,
  planTravel,
  serializePlaceCore,
  startTravel,
  stepPlaceSimulation,
  stepTravel
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

  places.setPortalState("trigger-shop", "door", { locked: true });
  stepTravel(places, bridge, "hans");

  assert.equal(travel.replans, 1);
  assert.equal(travel.plan.resolvedTarget.placeId, "open-shop");
  assert.equal(travel.options.anchorPredicate, predicate);
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
