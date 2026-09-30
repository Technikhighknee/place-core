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

function makeDefinition(id, patch = {}) {
  const road = {
    id: "road",
    from: "a",
    to: "b",
    width: 2,
    surface: "stone",
    bidirectional: true,
    enabled: true,
    allowedProfiles: ["pedestrian"],
    blockedProfiles: ["cart"],
    tags: ["interior"],
    shape: [{ x: 0.5, y: 0.25 }],
    ...(patch.road ?? {})
  };

  return {
    id,
    layers: [{
      id: "inside",
      topologyId: "shared-interior-topology",
      navigation: {
        regions: [{ id: "main" }],
        nodes: [
          {
            id: "a",
            x: 0,
            y: 0,
            junctionRadius: 0.2,
            regionId: "main"
          },
          {
            id: "b",
            x: 1,
            y: 0,
            junctionRadius: 0.3,
            regionId: "main"
          }
        ],
        roads: [road]
      }
    }]
  };
}

function setup() {
  const world = new World();
  const navigation = new NavigationRegistry();
  const bridge = new WorldCoreBridge({
    world,
    navigation,
    Navigation,
    startJourney,
    stopJourney
  });
  const places = new PlaceRegistry({ bridge });
  return { world, navigation, bridge, places };
}

test("different definitions may deliberately share an identical explicit topology", () => {
  const { world, navigation, places } = setup();

  places.registerDefinition(makeDefinition("house"));
  places.registerDefinition(makeDefinition("shop"));

  places.createPlace({
    id: "house-1",
    definitionId: "house"
  });
  places.createPlace({
    id: "shop-1",
    definitionId: "shop"
  });

  assert.equal(navigation.topologies.size, 1);
  assert.equal(
    navigation.domainBindings.get("house-1:inside"),
    "shared-interior-topology"
  );
  assert.equal(
    navigation.domainBindings.get("shop-1:inside"),
    "shared-interior-topology"
  );
  assert.ok(world.getDomain("house-1:inside"));
  assert.ok(world.getDomain("shop-1:inside"));
});

test("shared topology ID rejects different routing semantics before domain creation", () => {
  const cases = [
    ["width", { road: { width: 3 } }],
    ["surface", { road: { surface: "mud" } }],
    ["directionality", { road: { bidirectional: false } }],
    ["enabled state", { road: { enabled: false } }],
    ["allowedProfiles", { road: { allowedProfiles: ["horse"] } }],
    ["blockedProfiles", { road: { blockedProfiles: [] } }],
    ["tags", { road: { tags: ["outside"] } }],
    ["shape", { road: { shape: [{ x: 0.5, y: -0.25 }] } }]
  ];

  for (const [label, patch] of cases) {
    const { world, navigation, places } = setup();
    places.registerDefinition(makeDefinition("base"));
    places.registerDefinition(makeDefinition("conflict", patch));

    places.createPlace({
      id: "base-place",
      definitionId: "base"
    });

    assert.throws(
      () => places.createPlace({
        id: "conflict-place",
        definitionId: "conflict"
      }),
      /navigation topology shared-interior-topology is incompatible/
    );

    assert.equal(
      world.getDomain("conflict-place:inside"),
      undefined,
      `${label} mismatch must fail before world-domain creation`
    );
    assert.equal(places.getPlace("conflict-place"), null);
    assert.equal(navigation.topologies.size, 1);
  }
});

test("shared topology ID rejects node and region mismatches", () => {
  const { world, places } = setup();

  places.registerDefinition(makeDefinition("base"));

  const nodeMismatch = makeDefinition("node-conflict");
  nodeMismatch.layers[0].navigation.nodes[1].x = 2;
  places.registerDefinition(nodeMismatch);

  const regionMismatch = makeDefinition("region-conflict");
  regionMismatch.layers[0].navigation.regions.push({ id: "other" });
  places.registerDefinition(regionMismatch);

  places.createPlace({
    id: "base-place",
    definitionId: "base"
  });

  assert.throws(
    () => places.createPlace({
      id: "node-place",
      definitionId: "node-conflict"
    }),
    /node b position differs/
  );
  assert.throws(
    () => places.createPlace({
      id: "region-place",
      definitionId: "region-conflict"
    }),
    /region set differs/
  );

  assert.equal(world.getDomain("node-place:inside"), undefined);
  assert.equal(world.getDomain("region-place:inside"), undefined);
});

test("externally mutated shared topology cannot be silently reused", () => {
  const { navigation, places } = setup();

  places.registerDefinition(makeDefinition("house"));
  places.createPlace({
    id: "house-1",
    definitionId: "house"
  });

  navigation.topologies
    .get("shared-interior-topology")
    .setRoadWidth("road", 9);

  assert.throws(
    () => places.createPlace({
      id: "house-2",
      definitionId: "house"
    }),
    /road road width differs/
  );

  assert.equal(places.getPlace("house-2"), null);
});


test("shared topology ID rejects different navigation runtime options", () => {
  const { world, places } = setup();

  const first = makeDefinition("base");
  first.layers[0].navigation.options = {
    spatialCellSize: 50,
    routeCacheSize: 5000
  };

  const second = makeDefinition("conflict");
  second.layers[0].navigation.options = {
    spatialCellSize: 25,
    routeCacheSize: 5000
  };

  places.registerDefinition(first);
  places.registerDefinition(second);
  places.createPlace({
    id: "base-place",
    definitionId: "base"
  });

  assert.throws(
    () => places.createPlace({
      id: "conflict-place",
      definitionId: "conflict"
    }),
    /navigation option spatialCellSize differs/
  );

  assert.equal(world.getDomain("conflict-place:inside"), undefined);
  assert.equal(places.getPlace("conflict-place"), null);
});


test("failed multi-layer materialization removes newly registered topologies", () => {
  const { world, navigation, places } = setup();

  const layer = (id, topologyId) => ({
    id,
    topologyId,
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
  });

  places.registerDefinition({
    id: "two-layer-place",
    layers: [
      layer("ground", "topology-ground"),
      layer("upper", "topology-upper")
    ]
  });

  const originalBindDomain =
    navigation.bindDomain.bind(navigation);
  let bindCalls = 0;
  navigation.bindDomain = (
    domainId,
    topologyId
  ) => {
    bindCalls += 1;
    if (bindCalls === 2) {
      throw new Error(
        "synthetic second-layer bind failure"
      );
    }
    return originalBindDomain(
      domainId,
      topologyId
    );
  };

  assert.throws(
    () => places.createPlace({
      id: "house",
      definitionId: "two-layer-place"
    }),
    /synthetic second-layer bind failure/
  );

  navigation.bindDomain = originalBindDomain;

  assert.equal(
    places.getPlace("house"),
    null
  );
  assert.equal(
    world.getDomain("house:ground"),
    undefined
  );
  assert.equal(
    world.getDomain("house:upper"),
    undefined
  );
  assert.equal(
    navigation.topologies.has(
      "topology-ground"
    ),
    false
  );
  assert.equal(
    navigation.topologies.has(
      "topology-upper"
    ),
    false
  );
});
