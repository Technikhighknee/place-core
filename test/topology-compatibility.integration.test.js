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
  compilePlace
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

function placesDefinitionForRollback() {
  return compilePlace({
    id: "rollback-ownership",
    layers: [{
      id: "inside",
      topologyId:
        "rollback-owned-topology",
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
    }]
  });
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


test("explicit external topology references reuse a pre-registered topology", () => {
  const world = new World();
  const navigation = new NavigationRegistry();
  const external = new Navigation();

  external.addNode({
    id: "a",
    x: 0,
    y: 0
  });
  external.addNode({
    id: "b",
    x: 1,
    y: 0
  });
  external.addRoad({
    id: "road",
    from: "a",
    to: "b"
  });
  navigation.registerTopology(
    "external-topology",
    external
  );

  const bridge = new WorldCoreBridge({
    world,
    navigation,
    startJourney,
    stopJourney
  });
  const places = new PlaceRegistry({
    bridge
  });

  places.registerDefinition({
    id: "external-topology-place",
    layers: [{
      id: "inside",
      topologyId: "external-topology"
    }]
  });

  const place = places.createPlace({
    id: "house",
    definitionId:
      "external-topology-place"
  });

  assert.ok(
    world.getDomain(
      place.layerDomains.get("inside")
    )
  );
  assert.equal(
    navigation.domainBindings.get(
      place.layerDomains.get("inside")
    ),
    "external-topology"
  );
  assert.equal(
    navigation.topologies.get(
      "external-topology"
    ),
    external
  );
});


test("missing external topology reference fails before domain creation", () => {
  const world = new World();
  const navigation =
    new NavigationRegistry();
  const bridge = new WorldCoreBridge({
    world,
    navigation,
    startJourney,
    stopJourney
  });
  const places = new PlaceRegistry({
    bridge
  });

  places.registerDefinition({
    id: "missing-external-topology",
    layers: [{
      id: "inside",
      topologyId: "not-registered"
    }]
  });

  assert.throws(
    () =>
      places.createPlace({
        id: "house",
        definitionId:
          "missing-external-topology"
      }),
    /topology not-registered.*not registered/
  );

  assert.equal(
    world.getDomain("house:inside"),
    undefined
  );
  assert.equal(
    navigation.domainBindings.has(
      "house:inside"
    ),
    false
  );
});


test("missing external topology does not require topology rollback capability", () => {
  const world = new World();
  const realNavigation =
    new NavigationRegistry();
  const navigation = {
    topologies:
      realNavigation.topologies,
    domainBindings:
      realNavigation.domainBindings,
    domainInstances:
      realNavigation.domainInstances,
    bindDomain:
      realNavigation.bindDomain.bind(
        realNavigation
      ),
    unbindDomain:
      realNavigation.unbindDomain.bind(
        realNavigation
      ),
    clearDomainOverrides:
      realNavigation.clearDomainOverrides.bind(
        realNavigation
      ),
    setDomainRoadEffect:
      realNavigation.setDomainRoadEffect.bind(
        realNavigation
      )
  };

  const bridge = new WorldCoreBridge({
    world,
    navigation,
    startJourney,
    stopJourney
  });
  const definition = {
    id: "missing-external-preflight",
    layers: [{
      id: "inside",
      topologyId: "not-registered",
      navigation: null
    }],
    boundaries: [],
    portals: []
  };
  const instance = {
    id: "house",
    layerDomains: new Map([
      ["inside", "house:inside"]
    ]),
    dynamicPortals: new Map()
  };

  assert.throws(
    () =>
      bridge.materializePlace(
        instance,
        definition
      ),
    /topology not-registered.*not registered/
  );

  assert.equal(
    world.getDomain("house:inside"),
    undefined
  );
});


test("removing a definition releases its bridge-owned topology for replacement", () => {
  const {
    navigation,
    places
  } = setup();

  const first =
    makeDefinition("replaceable");
  places.registerDefinition(first);
  places.createPlace({
    id: "first-place",
    definitionId: "replaceable"
  });

  assert.equal(
    places.removePlace("first-place"),
    true
  );
  assert.ok(
    navigation.topologies.has(
      "shared-interior-topology"
    )
  );
  assert.equal(
    places.removeDefinition(
      "replaceable"
    ),
    true
  );
  assert.equal(
    navigation.topologies.has(
      "shared-interior-topology"
    ),
    false
  );

  const replacement =
    makeDefinition(
      "replaceable",
      {
        road: {
          width: 3
        }
      }
    );
  places.registerDefinition(
    replacement
  );

  assert.doesNotThrow(
    () =>
      places.createPlace({
        id: "second-place",
        definitionId: "replaceable"
      })
  );
  assert.equal(
    navigation.topologies
      .get("shared-interior-topology")
      .roads.get("road").width,
    3
  );
});


test("definition removal never deletes an externally registered topology", () => {
  const world = new World();
  const navigation =
    new NavigationRegistry();
  const external = new Navigation();

  external.addNode({
    id: "a",
    x: 0,
    y: 0
  });
  external.addNode({
    id: "b",
    x: 1,
    y: 0
  });
  external.addRoad({
    id: "road",
    from: "a",
    to: "b"
  });
  navigation.registerTopology(
    "external-owned",
    external
  );

  const bridge = new WorldCoreBridge({
    world,
    navigation,
    startJourney,
    stopJourney
  });
  const places = new PlaceRegistry({
    bridge
  });

  places.registerDefinition({
    id: "external-ref",
    layers: [{
      id: "inside",
      topologyId: "external-owned"
    }]
  });
  places.createPlace({
    id: "house",
    definitionId: "external-ref"
  });

  assert.equal(
    places.removePlace("house"),
    true
  );
  assert.equal(
    places.removeDefinition(
      "external-ref"
    ),
    true
  );
  assert.equal(
    navigation.topologies.get(
      "external-owned"
    ),
    external
  );
});


test("owned shared topology survives until the last referencing definition is removed", () => {
  const {
    navigation,
    places
  } = setup();

  places.registerDefinition(
    makeDefinition("house")
  );
  places.registerDefinition(
    makeDefinition("shop")
  );
  places.createPlace({
    id: "house-1",
    definitionId: "house"
  });

  assert.equal(
    places.removePlace("house-1"),
    true
  );
  assert.equal(
    places.removeDefinition("house"),
    true
  );
  assert.ok(
    navigation.topologies.has(
      "shared-interior-topology"
    )
  );

  assert.equal(
    places.removeDefinition("shop"),
    true
  );
  assert.equal(
    navigation.topologies.has(
      "shared-interior-topology"
    ),
    false
  );
});


test("definition topology release rolls back partial removal failures", () => {
  const {
    navigation,
    places
  } = setup();

  const layer = (
    id,
    topologyId
  ) => ({
    id,
    topologyId,
    navigation: {
      nodes: [
        {
          id: "a",
          x: 0,
          y: 0
        },
        {
          id: "b",
          x: 1,
          y: 0
        }
      ],
      roads: [{
        id: "road",
        from: "a",
        to: "b"
      }]
    }
  });

  places.registerDefinition({
    id: "release-rollback",
    layers: [
      layer(
        "first",
        "release-first"
      ),
      layer(
        "second",
        "release-second"
      )
    ]
  });
  places.createPlace({
    id: "house",
    definitionId: "release-rollback"
  });
  assert.equal(
    places.removePlace("house"),
    true
  );

  const originalRemoveTopology =
    navigation.removeTopology.bind(
      navigation
    );
  let removals = 0;
  navigation.removeTopology = (
    topologyId
  ) => {
    removals += 1;
    if (removals === 2) {
      throw new Error(
        "synthetic topology release failure"
      );
    }
    return originalRemoveTopology(
      topologyId
    );
  };

  assert.throws(
    () =>
      places.removeDefinition(
        "release-rollback"
      ),
    /synthetic topology release failure/
  );

  navigation.removeTopology =
    originalRemoveTopology;

  assert.ok(
    places.getDefinition(
      "release-rollback"
    )
  );
  assert.ok(
    navigation.topologies.has(
      "release-first"
    )
  );
  assert.ok(
    navigation.topologies.has(
      "release-second"
    )
  );

  assert.equal(
    places.removeDefinition(
      "release-rollback"
    ),
    true
  );
  assert.equal(
    navigation.topologies.has(
      "release-first"
    ),
    false
  );
  assert.equal(
    navigation.topologies.has(
      "release-second"
    ),
    false
  );
});


test("definition cleanup never deletes a foreign replacement under an owned topology id", () => {
  const {
    navigation,
    places
  } = setup();

  places.registerDefinition(
    makeDefinition("replace-owner")
  );
  places.createPlace({
    id: "house",
    definitionId: "replace-owner"
  });

  assert.equal(
    places.removePlace("house"),
    true
  );

  const topologyId =
    "shared-interior-topology";
  const owned =
    navigation.topologies.get(
      topologyId
    );
  assert.ok(owned);

  assert.equal(
    navigation.removeTopology(
      topologyId
    ),
    true
  );

  const foreign = new Navigation();
  foreign.addNode({
    id: "x",
    x: 0,
    y: 0
  });
  navigation.registerTopology(
    topologyId,
    foreign
  );

  assert.equal(
    places.removeDefinition(
      "replace-owner"
    ),
    true
  );
  assert.equal(
    navigation.topologies.get(
      topologyId
    ),
    foreign
  );
});


test("materialization rollback never deletes a foreign replacement topology", () => {
  const {
    world,
    navigation,
    bridge
  } = setup();

  const compiled =
    placesDefinitionForRollback();

  const layer =
    compiled.layers[0];
  const instance = {
    id: "house",
    layerDomains: new Map([
      [layer.id, "house:inside"]
    ]),
    dynamicPortals: new Map()
  };

  const originalBindDomain =
    navigation.bindDomain.bind(
      navigation
    );
  let replaced = false;

  navigation.bindDomain = (
    domainId,
    topologyId
  ) => {
    const owned =
      navigation.topologies.get(
        topologyId
      );
    if (!replaced && owned) {
      replaced = true;
      navigation.topologies.delete(
        topologyId
      );
      const foreign = new Navigation();
      foreign.addNode({
        id: "foreign",
        x: 0,
        y: 0
      });
      navigation.topologies.set(
        topologyId,
        foreign
      );
    }
    throw new Error(
      "synthetic bind failure after replacement"
    );
  };

  assert.throws(
    () =>
      bridge.materializePlace(
        instance,
        compiled
      ),
    /synthetic bind failure after replacement/
  );

  navigation.bindDomain =
    originalBindDomain;

  const remaining =
    navigation.topologies.get(
      layer.topologyId
    );
  assert.ok(remaining);
  assert.ok(
    remaining.nodes.has("foreign")
  );
  assert.equal(
    world.getDomain(
      "house:inside"
    ),
    undefined
  );
});


test("external topology road bindings are validated before domain mutation", () => {
  const world = new World();
  const navigation =
    new NavigationRegistry();
  const external = new Navigation();

  external.addNode({
    id: "a",
    x: 0,
    y: 0
  });
  external.addNode({
    id: "b",
    x: 1,
    y: 0
  });
  external.addRoad({
    id: "real-road",
    from: "a",
    to: "b"
  });
  navigation.registerTopology(
    "external-road-topology",
    external
  );

  const bridge = new WorldCoreBridge({
    world,
    navigation,
    startJourney,
    stopJourney
  });
  const places = new PlaceRegistry({
    bridge
  });

  places.registerDefinition({
    id: "external-road-binding-place",
    layers: [{
      id: "inside",
      topologyId:
        "external-road-topology"
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
        position: { x: 1, y: 0 },
        nodeId: "b"
      },
      roadBindings: [{
        layerId: "inside",
        roadId: "missing-road"
      }]
    }]
  });

  assert.throws(
    () =>
      places.createPlace({
        id: "house",
        definitionId:
          "external-road-binding-place"
      }),
    /portal door road binding references unknown road missing-road in external topology external-road-topology/
  );

  assert.equal(
    world.getDomain("house:inside"),
    undefined
  );
  assert.equal(
    navigation.domainBindings.has(
      "house:inside"
    ),
    false
  );
  assert.equal(
    navigation.topologies.get(
      "external-road-topology"
    ),
    external
  );
});


test("external topology threshold road must connect portal endpoint nodes", () => {
  const world = new World();
  const navigation =
    new NavigationRegistry();
  const external = new Navigation();

  external.addNode({
    id: "a",
    x: 0,
    y: 0
  });
  external.addNode({
    id: "b",
    x: 1,
    y: 0
  });
  external.addNode({
    id: "c",
    x: 2,
    y: 0
  });
  external.addRoad({
    id: "threshold",
    from: "a",
    to: "b"
  });
  navigation.registerTopology(
    "external-threshold",
    external
  );

  const bridge = new WorldCoreBridge({
    world,
    navigation,
    startJourney,
    stopJourney
  });
  const places = new PlaceRegistry({
    bridge
  });

  places.registerDefinition({
    id: "external-threshold-place",
    layers: [{
      id: "inside",
      topologyId:
        "external-threshold"
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
        position: { x: 2, y: 0 },
        nodeId: "c"
      },
      roadBindings: [{
        layerId: "inside",
        roadId: "threshold"
      }]
    }]
  });

  assert.throws(
    () =>
      places.createPlace({
        id: "house",
        definitionId:
          "external-threshold-place"
      }),
    /portal door road binding threshold does not connect its endpoint nodes/
  );

  assert.equal(
    world.getDomain("house:inside"),
    undefined
  );
  assert.equal(
    navigation.domainBindings.has(
      "house:inside"
    ),
    false
  );
});


test("connected portal road binding cannot target an unrelated layer domain", () => {
  const world = new World({
    domains: [{ id: "street" }]
  });
  const navigation =
    new NavigationRegistry();
  const bridge = new WorldCoreBridge({
    world,
    navigation,
    Navigation,
    startJourney,
    stopJourney
  });
  const places = new PlaceRegistry({
    bridge
  });

  places.registerDefinition({
    id: "unrelated-binding-place",
    layers: [
      {
        id: "ground",
        navigation: {
          nodes: [
            {
              id: "ground-door",
              x: 0,
              y: 0
            },
            {
              id: "ground-room",
              x: 1,
              y: 0
            }
          ],
          roads: [{
            id: "ground-road",
            from: "ground-door",
            to: "ground-room"
          }]
        }
      },
      {
        id: "cellar",
        navigation: {
          nodes: [
            {
              id: "cellar-a",
              x: 0,
              y: 0
            },
            {
              id: "cellar-b",
              x: 1,
              y: 0
            }
          ],
          roads: [{
            id: "cellar-road",
            from: "cellar-a",
            to: "cellar-b"
          }]
        }
      }
    ],
    portals: [{
      id: "front-door",
      a: {
        kind: "external",
        slot: "street"
      },
      b: {
        kind: "local",
        layerId: "ground",
        position: {
          x: 0,
          y: 0
        },
        nodeId: "ground-door"
      },
      roadBindings: [{
        layerId: "cellar",
        roadId: "cellar-road"
      }]
    }]
  });

  assert.throws(
    () =>
      places.createPlace({
        id: "house",
        definitionId:
          "unrelated-binding-place",
        attachments: {
          street: {
            domainId: "street",
            position: {
              x: 10,
              y: 0
            },
            nodeId: "street-house"
          }
        }
      }),
    /road binding cellar-road belongs to unrelated domain house:cellar/
  );

  assert.equal(
    places.getPlace("house"),
    null
  );
  assert.equal(
    world.getDomain("house:ground"),
    undefined
  );
  assert.equal(
    world.getDomain("house:cellar"),
    undefined
  );
});
