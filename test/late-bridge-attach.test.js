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
  WorldCoreBridge
} from "../src/index.js";

const mobility = {
  speed: 1,
  surfaceMultipliers: {},
  requiredRoadWidth: 0,
  requiredRoadTags: [],
  blockedRoadTags: []
};

function definition() {
  return {
    id: "late-attach-place",
    layers: [{
      id: "inside",
      navigation: {
        nodes: [
          { id: "a", x: 0, y: 0 },
          { id: "b", x: 5, y: 0 }
        ],
        roads: [{
          id: "door-road",
          from: "a",
          to: "b",
          width: 2
        }]
      }
    }],
    portals: [{
      id: "door",
      a: {
        kind: "local",
        layerId: "inside",
        position: { x: 0, y: 0 },
        nodeId: "a"
      },
      b: {
        kind: "local",
        layerId: "inside",
        position: { x: 5, y: 0 },
        nodeId: "b"
      },
      roadBindings: [{
        layerId: "inside",
        roadId: "door-road"
      }]
    }],
    boundaries: [{
      id: "wall",
      layerId: "inside",
      a: { x: 0, y: -1 },
      b: { x: 0, y: 1 }
    }]
  };
}

function makeBridge() {
  const world = new World({ domains: [{ id: "outside" }] });
  const navigation = new NavigationRegistry();
  const bridge = new WorldCoreBridge({
    world,
    navigation,
    Navigation,
    startJourney,
    stopJourney
  });
  return { world, navigation, bridge };
}

test("late bridge attach materializes existing places and sparse road effects", () => {
  const places = new PlaceRegistry();
  places.registerDefinition(definition());

  const a = places.createPlace({
    id: "a-house",
    definitionId: "late-attach-place"
  });
  const b = places.createPlace({
    id: "b-house",
    definitionId: "late-attach-place"
  });
  places.setPortalState("b-house", "door", { locked: true });

  const { world, navigation, bridge } = makeBridge();

  places.attachBridge(bridge);

  const domainA = a.layerDomains.get("inside");
  const domainB = b.layerDomains.get("inside");

  assert.ok(world.getDomain(domainA));
  assert.ok(world.getDomain(domainB));
  assert.equal(navigation.domainBindings.get(domainA), "late-attach-place:inside");
  assert.equal(navigation.domainBindings.get(domainB), "late-attach-place:inside");

  assert.ok(
    navigation.navigationForDomain(domainA).findRoute("a", "b", mobility),
    "unlocked place should remain traversable"
  );
  assert.equal(
    navigation.navigationForDomain(domainB).findRoute("a", "b", mobility),
    null,
    "pre-existing sparse lock state must materialize into world-core"
  );

  assert.equal(places.bridge, bridge);
  places.assertInternalConsistency();
});

test("late bridge attach rolls every materialized place back on failure", () => {
  const places = new PlaceRegistry();
  places.registerDefinition(definition());

  const first = places.createPlace({
    id: "first",
    definitionId: "late-attach-place"
  });
  const second = places.createPlace({
    id: "second",
    definitionId: "late-attach-place"
  });

  const { world, navigation, bridge } = makeBridge();
  const originalSyncBoundary = bridge.syncBoundaryState.bind(bridge);
  let syncCalls = 0;
  bridge.syncBoundaryState = (...args) => {
    syncCalls += 1;
    if (syncCalls === 2) {
      throw new Error("synthetic late-attach sync failure");
    }
    return originalSyncBoundary(...args);
  };

  assert.throws(
    () => places.attachBridge(bridge),
    /synthetic late-attach sync failure/
  );

  for (const place of [first, second]) {
    const domainId = place.layerDomains.get("inside");
    assert.equal(world.getDomain(domainId), undefined);
    assert.equal(navigation.domainBindings.has(domainId), false);
  }

  assert.equal(places.bridge, null);
  assert.ok(places.getPlace("first"));
  assert.ok(places.getPlace("second"));
  places.assertInternalConsistency();
});

test("attaching a different bridge after one is active is rejected", () => {
  const places = new PlaceRegistry();
  const one = makeBridge();
  const two = makeBridge();

  places.attachBridge(one.bridge);
  assert.equal(places.attachBridge(one.bridge), places);

  assert.throws(
    () => places.attachBridge(two.bridge),
    /different bridge/
  );
  assert.equal(places.bridge, one.bridge);
});
