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
  deserializePlaceCore,
  serializePlaceCore
} from "../src/index.js";

test("invalid snapshot fails before any world-core materialization", () => {
  const source = new PlaceRegistry();
  source.registerDefinition({
    id: "snapshot-preflight-place",
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
          to: "b"
        }]
      }
    }],
    spaces: [{
      id: "room",
      layerId: "inside",
      geometry: {
        type: "aabb",
        minX: 0,
        minY: 0,
        maxX: 2,
        maxY: 2
      }
    }]
  });

  source.createPlace({
    id: "first",
    definitionId: "snapshot-preflight-place"
  });
  source.createPlace({
    id: "second",
    definitionId: "snapshot-preflight-place"
  });

  const snapshot = serializePlaceCore(source);
  snapshot.instances.find((item) => item.id === "second")
    .spaceOverrides.room = { enabled: "false" };

  const world = new World({
    domains: [{ id: "outside" }]
  });
  const navigation = new NavigationRegistry();
  const bridge = new WorldCoreBridge({
    world,
    navigation,
    Navigation,
    startJourney,
    stopJourney
  });

  assert.throws(
    () => deserializePlaceCore(snapshot, { bridge }),
    /enabled must be a boolean/
  );

  assert.equal(world.getDomain("first:inside"), undefined);
  assert.equal(world.getDomain("second:inside"), undefined);
  assert.equal(navigation.domainBindings.size, 0);
  assert.equal(navigation.topologies.size, 0);
  assert.ok(world.getDomain("outside"));
});
