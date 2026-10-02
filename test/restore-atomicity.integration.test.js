import test from "node:test";
import assert from "node:assert/strict";

import {
  World,
  Navigation,
  NavigationRegistry,
  startJourney,
  stopJourney
} from "world-core";

import {
  PlaceRegistry,
  WorldCoreBridge,
  compilePlace,
  deserializePlaceCore,
  serializePlaceCore,
  validatePlaceCoreSnapshot,
  startTravel,
  stepTravel
} from "../src/index.js";

function definition() {
  return compilePlace({
    id: "restore-atomic-place",
    layers: [{
      id: "inside",
      navigation: {
        nodes: [
          { id: "a", x: 0, y: 0 },
          { id: "target", x: 5, y: 0 }
        ],
        roads: [{
          id: "road",
          from: "a",
          to: "target"
        }]
      }
    }],
    anchors: [{
      id: "target",
      layerId: "inside",
      position: { x: 5, y: 0 },
      nodeId: "target"
    }]
  });
}

function sourceSnapshot({ withTravel = false } = {}) {
  const places = new PlaceRegistry();
  const compiled = definition();
  places.registerDefinition(compiled);

  const first = places.createPlace({
    id: "first",
    definitionId: compiled.id
  });
  places.createPlace({
    id: "second",
    definitionId: compiled.id
  });

  if (withTravel) {
    const entity = {
      id: "hans",
      domainId: first.layerDomains.get("inside"),
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
      stopLocalJourney() {
        entity.journey = null;
      },
      transferEntity() {}
    };

    startTravel(
      places,
      bridge,
      "hans",
      { placeId: "first", anchorId: "target" }
    );
  }

  return {
    compiled,
    snapshot: serializePlaceCore(places)
  };
}

function makeBridge(world, navigation, existingDomainPolicy = "reject") {
  return new WorldCoreBridge({
    world,
    navigation,
    Navigation,
    startJourney,
    stopJourney,
    existingDomainPolicy
  });
}

test("bridge failure during late restore materialization rolls earlier places back", () => {
  const { snapshot } = sourceSnapshot();
  const world = new World();
  const navigation = new NavigationRegistry();
  const bridge = makeBridge(world, navigation);

  const originalAddDomain = world.addDomain.bind(world);
  world.addDomain = (input) => {
    if (input.id === "second:inside") {
      throw new Error("synthetic restore materialization failure");
    }
    return originalAddDomain(input);
  };

  assert.throws(
    () => deserializePlaceCore(snapshot, { bridge }),
    /synthetic restore materialization failure/
  );

  world.addDomain = originalAddDomain;

  assert.equal(world.getDomain("first:inside"), undefined);
  assert.equal(world.getDomain("second:inside"), undefined);
  assert.equal(navigation.domainBindings.size, 0);
});

test("bridge-backed occupancy restore requires getEntity before materialization", () => {
  const places = new PlaceRegistry();
  const compiled = definition();
  places.registerDefinition(compiled);
  const instance = places.createPlace({
    id: "first",
    definitionId: compiled.id
  });
  places.updateEntityOccupancy({
    id: "idle",
    domainId:
      instance.layerDomains.get(
        "inside"
      ),
    position: { x: 0, y: 0 }
  });
  const snapshot =
    serializePlaceCore(places);

  let attached = false;
  let materialized = 0;
  const bridge = {
    attachRegistry() {
      attached = true;
    },
    materializePlace() {
      materialized += 1;
      return {};
    }
  };

  assert.throws(
    () =>
      deserializePlaceCore(
        snapshot,
        { bridge }
      ),
    /bridge\.getEntity must be a function/
  );
  assert.equal(attached, false);
  assert.equal(materialized, 0);
});


test("resumeWorldCoreState checks entity coverage before bridge materialization", () => {
  const { snapshot } = sourceSnapshot({ withTravel: true });
  const world = new World();
  const navigation = new NavigationRegistry();
  const bridge = makeBridge(world, navigation);

  assert.throws(
    () => deserializePlaceCore(snapshot, {
      bridge,
      resumeWorldCoreState: true
    }),
    /missing world entity hans/
  );

  assert.equal(world.getDomain("first:inside"), undefined);
  assert.equal(world.getDomain("second:inside"), undefined);
  assert.equal(navigation.domainBindings.size, 0);
});

test("resumeWorldCoreState rejects invalid restored entity state before materialization", () => {
  const { snapshot } = sourceSnapshot({
    withTravel: true
  });

  let materialized = 0;
  const bridge = {
    getEntity(id) {
      if (id !== "hans") return null;
      return {
        id: "impostor",
        domainId: "first:inside",
        position: { x: 0, y: 0 },
        mobility: { speed: 1 }
      };
    },
    attachRegistry() {},
    materializePlace() {
      materialized += 1;
      return {};
    },
    rollbackMaterializePlace() {}
  };

  assert.throws(
    () =>
      deserializePlaceCore(snapshot, {
        bridge,
        resumeWorldCoreState: true
      }),
    /restored world entity.*identity|entity.*mismatch/i
  );

  assert.equal(
    materialized,
    0,
    "resume preflight must reject invalid entities before materialization"
  );
});

test("resumeWorldCoreState requires a bridge and restore booleans are strict", () => {
  const { snapshot } = sourceSnapshot({ withTravel: true });

  assert.throws(
    () => deserializePlaceCore(snapshot, {
      resumeWorldCoreState: true
    }),
    /requires a WorldCoreBridge/
  );

  assert.throws(
    () => deserializePlaceCore(snapshot, {
      restartTravels: "false"
    }),
    /restartTravels must be a boolean/
  );

  assert.throws(
    () => deserializePlaceCore(snapshot, {
      resumeWorldCoreState: 1
    }),
    /resumeWorldCoreState must be a boolean/
  );
});

test("matching restored world-core domains are reusable only through explicit adopt policy", () => {
  const { compiled, snapshot } = sourceSnapshot();
  const world = new World();
  const navigation = new NavigationRegistry();
  const bridge = makeBridge(world, navigation, "adopt");

  bridge.ensureLayerTopology(
    compiled,
    compiled.getLayer("inside")
  );

  for (const id of ["first", "second"]) {
    const domainId = `${id}:inside`;
    world.addDomain({ id: domainId });
    navigation.bindDomain(
      domainId,
      compiled.getLayer("inside").topologyId
    );
  }

  const restored = deserializePlaceCore(snapshot, { bridge });

  assert.ok(restored.getPlace("first"));
  assert.ok(restored.getPlace("second"));
  assert.equal(restored.bridge, bridge);
  assert.ok(world.getDomain("first:inside"));
  assert.ok(world.getDomain("second:inside"));
  assert.equal(
    navigation.domainBindings.get("first:inside"),
    compiled.getLayer("inside").topologyId
  );
});

test("restart mode preserves missing-entity travel intent instead of dropping it", () => {
  const { snapshot } = sourceSnapshot({ withTravel: true });
  const world = new World();
  const navigation = new NavigationRegistry();
  const bridge = makeBridge(world, navigation);

  const restored = deserializePlaceCore(snapshot, {
    bridge,
    restartTravels: true
  });

  assert.equal(restored.activeTravels.size, 0);
  assert.equal(restored.pendingTravels.length, 1);
  assert.equal(restored.pendingTravels[0].entityId, "hans");
  assert.deepEqual(
    restored.pendingTravels[0].target,
    { placeId: "first", anchorId: "target" }
  );
  assert.equal(
    restored.getEntityLocation("hans"),
    null,
    "missing world entities must not survive as snapshot ghost occupancy"
  );
});


test("failed adopt restore preserves pre-existing domains bindings and road overrides", () => {
  const compiled = compilePlace({
    id: "adopt-rollback-place",
    layers: [{
      id: "inside",
      navigation: {
        nodes: [
          { id: "a", x: 0, y: 0 },
          { id: "b", x: 5, y: 0 }
        ],
        roads: [{
          id: "road",
          from: "a",
          to: "b"
        }]
      }
    }],
    boundaries: [{
      id: "wall",
      layerId: "inside",
      enabled: true,
      a: { x: 0, y: -1 },
      b: { x: 0, y: 1 },
      roadBindings: [{ roadId: "road" }]
    }]
  });

  const source = new PlaceRegistry();
  source.registerDefinition(compiled);
  source.createPlace({
    id: "first",
    definitionId: compiled.id
  });
  source.createPlace({
    id: "second",
    definitionId: compiled.id
  });
  const snapshot = serializePlaceCore(source);

  const world = new World();
  const navigation = new NavigationRegistry();
  const bridge = makeBridge(world, navigation, "adopt");
  bridge.ensureLayerTopology(
    compiled,
    compiled.getLayer("inside")
  );

  for (const id of ["first", "second"]) {
    const domainId = `${id}:inside`;
    world.addDomain({ id: domainId });
    navigation.bindDomain(
      domainId,
      compiled.getLayer("inside").topologyId
    );
  }

  navigation.setDomainRoadEffect(
    "first:inside",
    "foreign-effect",
    "road",
    { costMultiplier: 2 }
  );

  const originalSync = bridge.syncBoundaryState.bind(bridge);
  let calls = 0;
  bridge.syncBoundaryState = (...args) => {
    const result = originalSync(...args);
    calls += 1;
    if (calls === 2) {
      throw new Error("synthetic adopted sync failure");
    }
    return result;
  };

  assert.throws(
    () => deserializePlaceCore(snapshot, { bridge }),
    /synthetic adopted sync failure/
  );

  for (const id of ["first", "second"]) {
    const domainId = `${id}:inside`;
    assert.ok(
      world.getDomain(domainId),
      `${domainId} must survive failed adoption`
    );
    assert.equal(
      navigation.domainBindings.get(domainId),
      compiled.getLayer("inside").topologyId
    );
  }

  const firstNav = navigation.navigationForDomain("first:inside");
  assert.equal(firstNav.roadCostMultiplier("road"), 2);
  assert.equal(firstNav.roadTraversalDelaySeconds("road"), 0);
  assert.equal(firstNav.overrideEffectCount, 1);
  assert.ok(
    firstNav.roadEffects.get("road")?.has("foreign-effect")
  );
  assert.equal(
    [...(firstNav.roadEffects.get("road")?.keys() ?? [])]
      .some((id) => String(id).startsWith("place-core")),
    false
  );

  const secondNav = navigation.navigationForDomain("second:inside");
  assert.equal(secondNav.roadCostMultiplier("road"), 1);
  assert.equal(secondNav.roadTraversalDelaySeconds("road"), 0);
  assert.equal(navigation.domainInstances.has("second:inside"), false);
  assert.equal(navigation.getDiagnostics().overrideEffectCount, 1);
});


test("restart mode retains travel intent when route planning throws", () => {
  const { snapshot } =
    sourceSnapshot({ withTravel: true });

  const entity = {
    id: "hans",
    domainId: "first:inside",
    position: { x: 0, y: 0 },
    mobility: { speed: 1 },
    journey: null
  };

  let entityLookups = 0;
  const bridge = {
    registry: null,
    attachRegistry(registry, onDispose) {
      this.registry = registry;
      this.onDispose = onDispose;
      return this;
    },
    materializePlace() {
      return {};
    },
    syncBoundaryState() {},
    syncPortalState() {},
    syncDynamicPortal() {},
    getEntity(id) {
      entityLookups += 1;
      if (entityLookups > 1) {
        throw new Error(
          "entity lookup must be stable within one restore"
        );
      }
      return id === "hans"
        ? entity
        : null;
    },
    planLocalRoute() {
      throw new Error(
        "synthetic restart planning failure"
      );
    },
    startLocalJourney() {
      throw new Error(
        "journey must not start after planning failure"
      );
    },
    stopLocalJourney() {
      entity.journey = null;
    },
    transferEntity() {}
  };

  const restored = deserializePlaceCore(
    snapshot,
    {
      bridge,
      restartTravels: true
    }
  );

  assert.equal(
    restored.activeTravels.size,
    0
  );
  assert.equal(
    restored.pendingTravels.length,
    1
  );
  assert.equal(
    restored.pendingTravels[0]
      .restartError?.message,
    "synthetic restart planning failure"
  );
  assert.ok(
    restored.getEntityLocation(
      "hans"
    )
  );
  assert.deepEqual(
    restored.getEntityLocation(
      "hans"
    ).places,
    ["first"]
  );
  assert.equal(
    entityLookups,
    1,
    "occupancy reconciliation and travel restart must share one world lookup"
  );
});


test("restart mode retains travel intent when entity lookup throws", () => {
  const { snapshot } =
    sourceSnapshot({
      withTravel: true
    });

  const bridge = {
    registry: null,
    attachRegistry(
      registry,
      onDispose
    ) {
      this.registry = registry;
      this.onDispose = onDispose;
      return this;
    },
    materializePlace() {
      return {};
    },
    syncBoundaryState() {},
    syncPortalState() {},
    syncDynamicPortal() {},
    getEntity() {
      throw new Error(
        "synthetic entity lookup failure"
      );
    },
    planLocalRoute() {
      throw new Error(
        "planning must not run"
      );
    },
    startLocalJourney() {
      throw new Error(
        "journey must not start"
      );
    },
    stopLocalJourney() {},
    transferEntity() {}
  };

  const restored =
    deserializePlaceCore(
      snapshot,
      {
        bridge,
        restartTravels: true
      }
    );

  assert.equal(
    restored.activeTravels.size,
    0
  );
  assert.equal(
    restored.pendingTravels.length,
    1
  );
  assert.equal(
    restored.pendingTravels[0]
      .restartError?.message,
    "synthetic entity lookup failure"
  );
  assert.equal(
    bridge.registry,
    restored
  );
  assert.equal(
    restored.getEntityLocation("hans"),
    null,
    "unreadable live entities must not retain stale snapshot occupancy"
  );
  restored.assertInternalConsistency();
});


test("stationary occupancy lookup failure aborts before bridge attachment", () => {
  const places = new PlaceRegistry();
  places.updateEntityOccupancy({
    id: "idle",
    domainId: "snapshot-domain",
    position: { x: 1, y: 2 }
  });
  const snapshot =
    serializePlaceCore(places);

  let attached = false;
  const bridge = {
    attachRegistry() {
      attached = true;
    },
    getEntity() {
      throw new Error(
        "synthetic stationary lookup failure"
      );
    }
  };

  assert.throws(
    () =>
      deserializePlaceCore(
        snapshot,
        { bridge }
      ),
    /synthetic stationary lookup failure/
  );
  assert.equal(
    attached,
    false,
    "failed stationary lookup must abort before bridge attachment"
  );
});


test("bridge-backed restore re-derives selective occupancy from live world state", () => {
  const places = new PlaceRegistry();
  places.updateEntityOccupancy({
    id: "idle",
    domainId: "snapshot-domain",
    position: { x: 1, y: 2 }
  });
  const snapshot =
    serializePlaceCore(places);

  const liveEntity = {
    id: "idle",
    domainId: "live-domain",
    position: { x: 9, y: 4 }
  };
  const bridge = {
    registry: null,
    attachRegistry(registry) {
      this.registry = registry;
      return this;
    },
    getEntity(entityId) {
      if (entityId === "idle") {
        return liveEntity;
      }
      if (entityId === "untracked") {
        return {
          id: "untracked",
          domainId: "live-domain",
          position: { x: 0, y: 0 }
        };
      }
      return null;
    }
  };

  const restored =
    deserializePlaceCore(
      snapshot,
      { bridge }
    );

  assert.deepEqual(
    restored.getEntityLocation("idle"),
    {
      domainId: "live-domain",
      position: { x: 9, y: 4 },
      places: [],
      semanticPlaces: [],
      spaces: [],
      placeId: null,
      layerId: null,
      deepestSpace: null
    }
  );
  assert.equal(
    restored.getEntityLocation("untracked"),
    null,
    "restore must not expand selective occupancy to all live entities"
  );
});


test("resume preserves eager stale-plan semantics across snapshots", () => {
  const places = new PlaceRegistry();
  places.registerDefinition({
    id: "stale-resume-place",
    layers: [{ id: "inside" }],
    spaces: [{
      id: "room",
      layerId: "inside",
      geometry: {
        type: "aabb",
        minX: 0,
        minY: -1,
        maxX: 6,
        maxY: 1
      }
    }],
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
    definitionId:
      "stale-resume-place"
  });

  const entity = {
    id: "hans",
    domainId:
      place.layerDomains.get("inside"),
    position: { x: 0, y: 0 },
    mobility: { speed: 1 },
    journey: null
  };

  const sourceBridge = {
    getEntity(id) {
      return id === "hans"
        ? entity
        : null;
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
      sourceBridge,
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

  places.setSpaceState(
    "house",
    "room",
    { enabled: false }
  );

  const snapshot =
    serializePlaceCore(places);
  assert.equal(
    snapshot.activeTravels[0]
      .planStale,
    true
  );

  // A stale plan must remain stale across a current-schema
  // snapshot/restore round trip so eager policy revalidates it.
  const restoredEntity = {
    ...entity,
    journey: null
  };
  const restoreBridge = {
    registry: null,
    attachRegistry(registry) {
      this.registry = registry;
      return this;
    },
    materializePlace() {
      return {};
    },
    syncBoundaryState() {},
    syncPortalState() {},
    syncDynamicPortal() {},
    getEntity(id) {
      return id === "hans"
        ? restoredEntity
        : null;
    },
    planLocalRoute() {
      return { estimatedSeconds: 5 };
    },
    startLocalJourney() {
      restoredEntity.journey = {
        destinationNodeId: "target"
      };
      return true;
    },
    stopLocalJourney() {
      restoredEntity.journey = null;
    },
    transferEntity() {}
  };

  const restored =
    deserializePlaceCore(
      snapshot,
      {
        bridge: restoreBridge,
        resumeWorldCoreState: true
      }
    );

  assert.ok(
    restored.getEntityLocation(
      "hans"
    )
  );
  assert.deepEqual(
    restored.getEntityLocation(
      "hans"
    ).places,
    ["house"]
  );

  const resumed =
    restored.activeTravels.get(
      "hans"
    );
  assert.notEqual(
    resumed.travelRevision,
    restored.travelRevision
  );
  assert.equal(
    resumed.plan.travelRevision,
    resumed.travelRevision
  );

  const result = stepTravel(
    restored,
    restoreBridge,
    "hans"
  );
  assert.equal(
    result.status,
    "failed"
  );
  assert.equal(
    result.failureReason,
    "target-unavailable-after-world-change"
  );
});


test("pending travel plans are marked stale before later structural mutations", () => {
  const { snapshot } =
    sourceSnapshot({
      withTravel: true
    });

  const restored =
    deserializePlaceCore(
      snapshot
    );

  assert.equal(
    restored.activeTravels.size,
    0
  );
  assert.equal(
    restored.pendingTravels.length,
    1
  );
  assert.equal(
    restored.pendingTravels[0]
      .savedState.planStale,
    true
  );

  const targetPlaceId =
    restored.pendingTravels[0]
      .savedState.plan.resolvedTarget
      .placeId;

  if (targetPlaceId != null) {
    assert.equal(
      restored.removeEntityOccupancy(
        restored.pendingTravels[0]
          .entityId
      ),
      true
    );
    assert.equal(
      restored.removePlace(
        targetPlaceId
      ),
      true
    );
  }

  const resnapshot =
    serializePlaceCore(restored);

  assert.doesNotThrow(
    () =>
      validatePlaceCoreSnapshot(
        resnapshot
      )
  );
});
