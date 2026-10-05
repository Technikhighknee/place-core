import test from "node:test";
import assert from "node:assert/strict";

import {
  Navigation,
  NavigationRegistry,
  World,
  mobilityProfile,
  startJourney,
  stopJourney
} from "world-core";

import {
  PlaceRegistry,
  WorldCoreBridge,
  planTravel,
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
  anchors: [
    {
      id: "food-stall",
      kind: "market-stall",
      layerId: "market",
      spaceId: "square",
      position: { x: 2, y: 3 },
      tags: ["market", "food"]
    },
    {
      id: "annex-stall",
      kind: "market-stall",
      layerId: "market",
      spaceId: "annex",
      position: { x: 14, y: 2 },
      tags: ["market", "annex"]
    }
  ]
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

test("embedded routable anchors bind explicitly to host navigation nodes", () => {
  const world = new World();
  const navigation =
    new NavigationRegistry();
  const city = new Navigation();

  city.addNode({
    id: "start",
    x: 0,
    y: 0
  });
  city.addNode({
    id: "stall-node",
    x: 12,
    y: 8
  });
  city.addRoad({
    id: "market-road",
    from: "start",
    to: "stall-node",
    width: 2
  });
  navigation.registerTopology(
    "city",
    city
  );
  navigation.bindDomain(
    "default",
    "city"
  );

  const bridge = new WorldCoreBridge({
    world,
    navigation,
    Navigation,
    startJourney,
    stopJourney
  });
  const places =
    new PlaceRegistry({ bridge });

  places.registerDefinition({
    id: "routable-market",
    layers: [{
      id: "market",
      spatialMode: "embedded"
    }],
    anchors: [{
      id: "stall",
      layerId: "market",
      position: { x: 2, y: 3 }
    }]
  });

  places.createPlace({
    id: "market",
    definitionId: "routable-market",
    layerDomains: {
      market: "default"
    },
    embeddedNodeBindings: {
      anchors: {
        stall: "stall-node"
      }
    },
    placement: {
      domainId: "default",
      containment: "none",
      transform: {
        x: 10,
        y: 5,
        rotation: 0,
        scale: 1
      }
    }
  });

  world.addEntity({
    id: "buyer",
    domainId: "default",
    position: { x: 0, y: 0 },
    mobility:
      mobilityProfile("pedestrian")
  });

  const plan = planTravel(
    places,
    bridge,
    "buyer",
    {
      placeId: "market",
      anchorId: "stall"
    }
  );

  assert.ok(plan);
  assert.deepEqual(
    plan.resolvedTarget.position,
    { x: 12, y: 8 }
  );
  assert.equal(
    plan.resolvedTarget.nodeId,
    "stall-node"
  );

  assert.throws(
    () => places.setPlacement(
      "market",
      {
        domainId: "default",
        containment: "none",
        transform: {
          x: 20,
          y: 5,
          rotation: 0,
          scale: 1
        }
      }
    ),
    /position does not match host navigation node stall-node/
  );
  assert.deepEqual(
    places.resolveAnchor(
      "market",
      "stall"
    )?.position,
    { x: 12, y: 8 }
  );

  assert.throws(
    () => places.createPlace({
      id: "misaligned-market",
      definitionId: "routable-market",
      layerDomains: {
        market: "default"
      },
      embeddedNodeBindings: {
        anchors: {
          stall: "stall-node"
        }
      },
      placement: {
        domainId: "default",
        containment: "none",
        transform: {
          x: 20,
          y: 5,
          rotation: 0,
          scale: 1
        }
      }
    }),
    /position does not match host navigation node stall-node/
  );
  assert.equal(
    places.getPlace(
      "misaligned-market"
    ),
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
  assert.equal(
    location.layerId,
    "market"
  );

  assert.deepEqual(
    places.findAnchors({
      placeId: "north-market",
      tag: "food"
    }).map((anchor) => [
      anchor.domainId,
      anchor.position
    ]),
    [
      [
        "default",
        { x: 102, y: 53 }
      ]
    ]
  );
  assert.deepEqual(
    places.findAnchors({
      placeId: "north-market",
      tag: "annex"
    }).map((anchor) =>
      anchor.position
    ),
    [{ x: 114, y: 52 }]
  );
  assert.deepEqual(
    places.findAnchors({
      placeId: "north-market",
      tag: "annex",
      enabledOnly: true
    }),
    []
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
  assert.deepEqual(
    places.placesInBounds(
      "default",
      {
        minX: 113,
        minY: 51,
        maxX: 115,
        maxY: 53
      }
    ),
    []
  );

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
  assert.deepEqual(
    places.placesInBounds(
      "default",
      {
        minX: 113,
        minY: 51,
        maxX: 115,
        maxY: 53
      }
    ).map((place) => place.id),
    ["market"]
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
