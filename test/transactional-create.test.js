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

function definition() {
  return {
    id: "transaction-place",
    layers: [{
      spatialMode: "owned",
      id: "inside",
      navigation: {
        nodes: [
          { id: "a", x: 0, y: 0 },
          { id: "b", x: 1, y: 0 }
        ],
        roads: [{
          id: "road",
          from: "a",
          to: "b",
          width: 2
        }]
      }
    }],
    boundaries: [{
      id: "wall",
      layerId: "inside",
      a: { x: 0, y: 0 },
      b: { x: 1, y: 0 }
    }]
  };
}

test("failed bridge sync rolls place creation back atomically", () => {
  const world = new World({ domains: [{ id: "street" }] });
  const navigation = new NavigationRegistry();
  const bridge = new WorldCoreBridge({
    world,
    navigation,
    Navigation,
    startJourney,
    stopJourney
  });

  const originalSyncBoundary = bridge.syncBoundaryState.bind(bridge);
  bridge.syncBoundaryState = () => {
    throw new Error("synthetic boundary sync failure");
  };

  const places = new PlaceRegistry({
    bridge,
    captureEvents: true
  });
  places.registerDefinition(definition());

  const stateRevision = places.stateRevision;
  const travelRevision = places.travelRevision;

  assert.throws(
    () => places.createPlace({
      id: "broken",
      definitionId: "transaction-place"
    }),
    /synthetic boundary sync failure/
  );

  const domainId = "broken:inside";
  assert.equal(places.getPlace("broken"), null);
  assert.equal(places.getDomainBinding(domainId), null);
  assert.equal(world.getDomain(domainId), undefined);
  assert.equal(navigation.domainBindings.has(domainId), false);
  assert.equal(places.stateRevision, stateRevision);
  assert.equal(places.travelRevision, travelRevision);
  assert.deepEqual(places.drainEvents(), []);
  places.assertInternalConsistency();

  bridge.syncBoundaryState = originalSyncBoundary;
  const place = places.createPlace({
    id: "healthy",
    definitionId: "transaction-place"
  });
  assert.ok(place);
  assert.ok(world.getDomain("healthy:inside"));
});

test("internal rollback still completes when bridge cleanup itself fails", () => {
  const bridge = {
    attachRegistry() {},
    materializePlace() {},
    syncBoundaryState() {
      throw new Error("sync failed");
    },
    syncPortalState() {},
    unmaterializePlace() {
      throw new Error("cleanup failed");
    }
  };

  const places = new PlaceRegistry({
    bridge,
    captureEvents: true
  });
  places.registerDefinition(definition());

  assert.throws(
    () => places.createPlace({
      id: "broken",
      definitionId: "transaction-place"
    }),
    (error) => {
      assert.ok(error instanceof AggregateError);
      assert.match(error.message, /rollback bridge state/);
      assert.equal(error.errors.length, 2);
      return true;
    }
  );

  assert.equal(places.getPlace("broken"), null);
  assert.equal(places.getDomainBinding("broken:inside"), null);
  assert.equal(places.stateRevision, 0);
  assert.equal(places.travelRevision, 0);
  assert.deepEqual(places.drainEvents(), []);
  places.assertInternalConsistency();
});


test("create rollback preserves falsy bridge cleanup throws", () => {
  const bridge = {
    attachRegistry() {},
    materializePlace() {},
    syncBoundaryState() {
      throw new Error("sync failed");
    },
    syncPortalState() {},
    unmaterializePlace() {
      throw undefined;
    }
  };

  const places = new PlaceRegistry({
    bridge,
    captureEvents: true
  });
  places.registerDefinition(definition());

  assert.throws(
    () => places.createPlace({
      id: "broken",
      definitionId: "transaction-place"
    }),
    (error) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.errors.length, 2);
      assert.match(
        error.errors[0].message,
        /sync failed/
      );
      assert.equal(
        error.errors[1],
        undefined
      );
      return true;
    }
  );

  assert.equal(
    places.getPlace("broken"),
    null
  );
  places.assertInternalConsistency();
});


test("derived exterior overflow cannot leave a partially created place", () => {
  const places = new PlaceRegistry({
    captureEvents: true
  });
  places.registerDefinition({
    id: "overflow-footprint-place",
    layers: [{
      spatialMode: "owned",
      id: "inside"
    }],
    footprint: {
      type: "aabb",
      minX: 0,
      minY: 0,
      maxX: 1e308,
      maxY: 1
    }
  });

  const stateRevision = places.stateRevision;
  const travelRevision = places.travelRevision;

  assert.throws(
    () => places.createPlace({
      id: "broken",
      definitionId: "overflow-footprint-place",
      placement: {
        domainId: "street",
        containment: "footprint",
        transform: {
          scale: 2
        }
      }
    }),
    /finite Vec2|finite.*transform|transform.*finite/i
  );

  assert.equal(places.getPlace("broken"), null);
  assert.equal(
    places.getDomainBinding("broken:inside"),
    null
  );
  assert.deepEqual(
    places.placesInBounds(
      "street",
      {
        minX: -1,
        minY: -1,
        maxX: 1,
        maxY: 1
      }
    ),
    []
  );
  assert.equal(places.stateRevision, stateRevision);
  assert.equal(places.travelRevision, travelRevision);
  assert.deepEqual(places.drainEvents(), []);
  places.assertInternalConsistency();
});
