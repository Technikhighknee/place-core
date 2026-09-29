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
  startTravel
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
  assert.equal(secondNav.overrideEffectCount, 0);
});
