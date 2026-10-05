import test from "node:test";
import assert from "node:assert/strict";

import {
  Navigation,
  NavigationRegistry,
  World,
  startJourney,
  stopJourney
} from "world-core";

import {
  PlaceRegistry,
  WorldCoreBridge,
  serializePlaceCore,
  deserializePlaceCore
} from "../src/index.js";

const MARKET = {
  id: "embedded-market",
  footprint: {
    type: "aabb",
    minX: 0,
    minY: 0,
    maxX: 10,
    maxY: 8
  },
  layers: [{
    id: "market",
    spatialMode: "embedded"
  }],
  spaces: [{
    id: "square",
    layerId: "market",
    geometry: {
      type: "aabb",
      minX: 0,
      minY: 0,
      maxX: 10,
      maxY: 8
    }
  }],
  anchors: [{
    id: "food-stall",
    kind: "market-stall",
    layerId: "market",
    spaceId: "square",
    position: { x: 2, y: 3 },
    tags: ["market", "food"]
  }]
};

function setup() {
  const world = new World();
  const navigation =
    new NavigationRegistry();
  const bridge = new WorldCoreBridge({
    world,
    navigation,
    Navigation,
    startJourney,
    stopJourney
  });
  const places =
    new PlaceRegistry({ bridge });
  places.registerDefinition(MARKET);
  return { world, navigation, bridge, places };
}

test("embedded places share a host domain without owning it", () => {
  const { world, places } = setup();
  const host =
    world.getDomain("default");

  places.createPlace({
    id: "north-market",
    definitionId: "embedded-market",
    layerDomains: {
      market: "default"
    },
    placement: {
      domainId: "default",
      containment: "footprint",
      transform: {
        x: 100,
        y: 50,
        rotation: 0,
        scale: 1
      }
    }
  });
  places.createPlace({
    id: "south-market",
    definitionId: "embedded-market",
    layerDomains: {
      market: "default"
    },
    placement: {
      domainId: "default",
      containment: "footprint",
      transform: {
        x: 200,
        y: 50,
        rotation: 0,
        scale: 1
      }
    }
  });

  assert.equal(
    places.getDomainBinding("default"),
    null
  );
  assert.equal(
    world.getDomain("default"),
    host
  );

  assert.deepEqual(
    places.resolveAnchor(
      "north-market",
      "food-stall"
    )?.position,
    { x: 102, y: 53 }
  );

  const location = places.locate(
    "default",
    { x: 102, y: 53 }
  );
  assert.deepEqual(
    location.places,
    ["north-market"]
  );
  assert.deepEqual(
    location.spaces.map(
      (space) => space.spaceId
    ),
    ["square"]
  );

  assert.deepEqual(
    places.getAnchorsForDomain(
      "default",
      { tag: "food" }
    ).map((anchor) => [
      anchor.placeId,
      anchor.position
    ]),
    [
      [
        "north-market",
        { x: 102, y: 53 }
      ],
      [
        "south-market",
        { x: 202, y: 53 }
      ]
    ]
  );

  places.assertInternalConsistency();

  places.removePlace("north-market");
  places.removePlace("south-market");

  assert.equal(
    world.getDomain("default"),
    host
  );
});

test("embedded host-domain sharing survives place-core snapshots", () => {
  const { places } = setup();

  for (const [id, x] of [
    ["market-a", 10],
    ["market-b", 30]
  ]) {
    places.createPlace({
      id,
      definitionId: "embedded-market",
      layerDomains: {
        market: "default"
      },
      placement: {
        domainId: "default",
        containment: "footprint",
        transform: {
          x,
          y: 5,
          rotation: 0,
          scale: 1
        }
      }
    });
  }

  const snapshot =
    serializePlaceCore(places);
  const restored =
    deserializePlaceCore(snapshot);

  assert.deepEqual(
    restored.getAnchorsForDomain(
      "default",
      { tag: "food" }
    ).map((anchor) => [
      anchor.placeId,
      anchor.position
    ]),
    [
      ["market-a", { x: 12, y: 8 }],
      ["market-b", { x: 32, y: 8 }]
    ]
  );
  restored.assertInternalConsistency();
});
