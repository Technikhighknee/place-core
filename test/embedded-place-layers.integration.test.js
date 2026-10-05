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
  spaces: [
    {
      id: "square",
      layerId: "market",
      geometry: {
        type: "aabb",
        minX: 0,
        minY: 0,
        maxX: 10,
        maxY: 8
      }
    },
    {
      id: "annex",
      layerId: "market",
      enabled: false,
      geometry: {
        type: "aabb",
        minX: 12,
        minY: 0,
        maxX: 16,
        maxY: 4
      }
    }
  ],
  boundaries: [{
    id: "north-edge",
    layerId: "market",
    kind: "edge",
    a: { x: 0, y: 8 },
    b: { x: 10, y: 8 },
    tags: ["market-edge"]
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

test("embedded layers require explicit existing host domains and roll back cleanly", () => {
  const { places } = setup();

  assert.throws(
    () => places.createPlace({
      id: "missing-binding",
      definitionId: "embedded-market"
    }),
    /requires an explicit layerDomains binding/
  );
  assert.equal(
    places.getPlace("missing-binding"),
    null
  );

  assert.throws(
    () => places.createPlace({
      id: "missing-host",
      definitionId: "embedded-market",
      layerDomains: {
        market: "does-not-exist"
      },
      placement: {
        domainId: "does-not-exist",
        containment: "footprint"
      }
    }),
    /requires existing world-core domain does-not-exist/
  );
  assert.equal(
    places.getPlace("missing-host"),
    null
  );
  places.assertInternalConsistency();
});

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

  assert.deepEqual(
    places.getBoundariesForDomain(
      "default",
      { tag: "market-edge" }
    ).map((boundary) => [
      boundary.placeId,
      boundary.a,
      boundary.b
    ]),
    [
      [
        "north-market",
        { x: 100, y: 58 },
        { x: 110, y: 58 }
      ],
      [
        "south-market",
        { x: 200, y: 58 },
        { x: 210, y: 58 }
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

test("enabling an embedded space refreshes occupants outside the place footprint", () => {
  const { places } = setup();

  places.createPlace({
    id: "market",
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

  const entity = {
    id: "merchant",
    domainId: "default",
    position: { x: 114, y: 52 }
  };

  const before =
    places.updateEntityOccupancy(entity);
  assert.deepEqual(before.places, []);
  assert.deepEqual(before.spaces, []);

  places.setSpaceState(
    "market",
    "annex",
    { enabled: true }
  );

  const after =
    places.getEntityLocation("merchant");
  assert.ok(after);
  assert.deepEqual(
    after.places,
    ["market"]
  );
  assert.deepEqual(
    after.spaces.map(
      (space) => space.spaceId
    ),
    ["annex"]
  );

  places.assertInternalConsistency();
});

test("moving an embedded place updates resolved anchors and spatial lookup", () => {
  const { places } = setup();

  places.createPlace({
    id: "moving-market",
    definitionId: "embedded-market",
    layerDomains: {
      market: "default"
    },
    placement: {
      domainId: "default",
      containment: "footprint",
      transform: {
        x: 10,
        y: 20,
        rotation: 0,
        scale: 1
      }
    }
  });

  const revision =
    places.travelRevision;

  places.setPlacement(
    "moving-market",
    {
      domainId: "default",
      containment: "footprint",
      transform: {
        x: 40,
        y: 60,
        rotation: 0,
        scale: 1
      }
    }
  );

  assert.ok(
    places.travelRevision > revision
  );
  assert.deepEqual(
    places.resolveAnchor(
      "moving-market",
      "food-stall"
    )?.position,
    { x: 42, y: 63 }
  );
  assert.deepEqual(
    places.locate(
      "default",
      { x: 12, y: 23 }
    ).places,
    []
  );
  assert.deepEqual(
    places.locate(
      "default",
      { x: 42, y: 63 }
    ).places,
    ["moving-market"]
  );
  places.assertInternalConsistency();
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
