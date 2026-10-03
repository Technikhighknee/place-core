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
    id: "transaction-remove-place",
    layers: [
      {
        id: "a",
        navigation: {
          nodes: [
            { id: "a0", x: 0, y: 0 },
            { id: "a1", x: 5, y: 0 }
          ],
          roads: [{
            id: "a-road",
            from: "a0",
            to: "a1",
            width: 2
          }]
        }
      },
      {
        id: "b",
        navigation: {
          nodes: [
            { id: "b0", x: 0, y: 0 },
            { id: "b1", x: 5, y: 0 }
          ],
          roads: [{
            id: "b-road",
            from: "b0",
            to: "b1",
            width: 2
          }]
        }
      }
    ],
    boundaries: [{
      id: "b-wall",
      layerId: "b",
      enabled: true,
      a: { x: 1, y: -1 },
      b: { x: 1, y: 1 },
      roadBindings: [{
        roadId: "b-road"
      }]
    }],
    portals: [{
      id: "locked-door",
      locked: true,
      a: {
        kind: "local",
        layerId: "a",
        position: { x: 0, y: 0 },
        nodeId: "a0"
      },
      b: {
        kind: "local",
        layerId: "a",
        position: { x: 5, y: 0 },
        nodeId: "a1"
      },
      roadBindings: [{
        layerId: "a",
        roadId: "a-road"
      }]
    }]
  };
}

function setup() {
  const world = new World({ domains: [{ id: "outside" }] });
  const navigation = new NavigationRegistry();
  const bridge = new WorldCoreBridge({
    world,
    navigation,
    Navigation,
    startJourney,
    stopJourney
  });
  const places = new PlaceRegistry({ bridge, captureEvents: true });
  places.registerDefinition(definition());
  const place = places.createPlace({
    id: "house",
    definitionId: "transaction-remove-place"
  });
  places.drainEvents();
  return { world, navigation, bridge, places, place };
}

test("partial world-core removal failure restores domains bindings and effects", () => {
  const { world, navigation, places, place } = setup();
  const domainA = place.layerDomains.get("a");
  const domainB = place.layerDomains.get("b");

  assert.ok(world.getDomain(domainA));
  assert.ok(world.getDomain(domainB));
  assert.equal(
    navigation.navigationForDomain(domainA).findRoute("a0", "a1", mobility),
    null,
    "locked portal should block the road before removal"
  );

  const originalRemoveDomain = world.removeDomain.bind(world);
  let removeCalls = 0;
  world.removeDomain = (domainId) => {
    removeCalls += 1;
    if (removeCalls === 2) {
      throw new Error("synthetic second-domain removal failure");
    }
    return originalRemoveDomain(domainId);
  };

  const stateRevision = places.stateRevision;
  const travelRevision = places.travelRevision;

  assert.throws(
    () => places.removePlace("house"),
    /synthetic second-domain removal failure/
  );

  world.removeDomain = originalRemoveDomain;

  assert.ok(places.getPlace("house"), "registry place must remain");
  assert.ok(world.getDomain(domainA), "first/remaining domain must exist");
  assert.ok(world.getDomain(domainB), "already removed domain must be restored");
  assert.equal(navigation.domainBindings.get(domainA), "transaction-remove-place:a");
  assert.equal(navigation.domainBindings.get(domainB), "transaction-remove-place:b");

  assert.equal(
    navigation.navigationForDomain(domainA).findRoute("a0", "a1", mobility),
    null,
    "portal road effect must be restored"
  );

  assert.equal(places.stateRevision, stateRevision);
  assert.equal(places.travelRevision, travelRevision);
  assert.deepEqual(places.drainEvents(), []);
  places.assertInternalConsistency();
});

test("WorldCoreBridge preserves falsy rollback throws during removal", () => {
  const {
    world,
    bridge,
    places,
    place
  } = setup();

  const definition =
    places.getDefinition(
      place.definitionId
    );
  const originalRemoveDomain =
    world.removeDomain.bind(world);

  let removeCalls = 0;
  world.removeDomain = (domainId) => {
    removeCalls += 1;
    if (removeCalls === 2) {
      throw new Error(
        "synthetic removal failure"
      );
    }
    return originalRemoveDomain(domainId);
  };

  bridge.rollbackMaterializePlace = () => {
    throw undefined;
  };

  assert.throws(
    () =>
      bridge.unmaterializePlace(
        place,
        definition
      ),
    (error) => {
      assert.ok(
        error instanceof AggregateError
      );
      assert.equal(
        error.errors.length,
        2
      );
      assert.match(
        error.errors[0].message,
        /synthetic removal failure/
      );
      assert.equal(
        error.errors[1],
        undefined
      );
      return true;
    }
  );
});


test("successful removal still removes all materialized state", () => {
  const { world, navigation, places, place } = setup();
  const domainA = place.layerDomains.get("a");
  const domainB = place.layerDomains.get("b");

  assert.equal(places.removePlace("house"), true);

  assert.equal(places.getPlace("house"), null);
  assert.equal(world.getDomain(domainA), undefined);
  assert.equal(world.getDomain(domainB), undefined);
  assert.equal(navigation.domainBindings.has(domainA), false);
  assert.equal(navigation.domainBindings.has(domainB), false);
  places.assertInternalConsistency();
});


test("failed removal rollback restores sparse boundary overrides", () => {
  const { world, navigation, places, place } = setup();
  const domainB = place.layerDomains.get("b");

  places.setBoundaryState(
    "house",
    "b-wall",
    { enabled: false }
  );

  assert.ok(
    navigation
      .navigationForDomain(domainB)
      .findRoute("b0", "b1", mobility),
    "disabled boundary should leave the road traversable"
  );

  const originalRemoveDomain = world.removeDomain.bind(world);
  let removeCalls = 0;
  world.removeDomain = (domainId) => {
    removeCalls += 1;
    if (removeCalls === 2) {
      throw new Error("synthetic rollback failure point");
    }
    return originalRemoveDomain(domainId);
  };

  assert.throws(
    () => places.removePlace("house"),
    /synthetic rollback failure point/
  );
  world.removeDomain = originalRemoveDomain;

  assert.equal(
    places.resolveBoundary("house", "b-wall").enabled,
    false
  );
  assert.ok(
    navigation
      .navigationForDomain(domainB)
      .findRoute("b0", "b1", mobility),
    "rollback must restore the disabled boundary override"
  );
});
