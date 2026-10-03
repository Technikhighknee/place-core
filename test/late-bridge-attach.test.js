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
  startTravel
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

  places.attachWorldCoreBridge(bridge);

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

test("normal late bridge attach does not reconstruct snapshot-only runtime state", () => {
  const places = new PlaceRegistry();
  places.registerDefinition(definition());
  places.createPlace({
    id: "house",
    definitionId: "late-attach-place"
  });

  const { bridge } = makeBridge();
  bridge._synchronizeRuntimeState = () => {
    throw new Error(
      "normal attach must not synchronize restored runtime state"
    );
  };

  assert.doesNotThrow(
    () =>
      places.attachWorldCoreBridge(
        bridge
      )
  );
  assert.equal(
    places.bridge,
    bridge
  );
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
    () => places.attachWorldCoreBridge(bridge),
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

test("failed late attach plus unsubscribe failure stays detached and reattachable", () => {
  const places = new PlaceRegistry();
  places.registerDefinition(definition());

  places.createPlace({
    id: "first",
    definitionId: "late-attach-place"
  });
  places.createPlace({
    id: "second",
    definitionId: "late-attach-place"
  });

  const {
    world,
    bridge
  } = makeBridge();

  const originalSubscribe =
    world.subscribeEvents.bind(world);
  let subscribeCalls = 0;
  let unsubscribeCalls = 0;

  world.subscribeEvents = (
    handler,
    options
  ) => {
    subscribeCalls += 1;
    const unsubscribe =
      originalSubscribe(
        handler,
        options
      );

    return () => {
      unsubscribeCalls += 1;
      if (unsubscribeCalls === 1) {
        throw new Error(
          "synthetic rollback unsubscribe failure"
        );
      }
      return unsubscribe();
    };
  };

  const originalSyncBoundary =
    bridge.syncBoundaryState.bind(
      bridge
    );
  let syncCalls = 0;
  bridge.syncBoundaryState = (
    ...args
  ) => {
    syncCalls += 1;
    if (syncCalls === 2) {
      throw new Error(
        "synthetic late-attach sync failure"
      );
    }
    return originalSyncBoundary(
      ...args
    );
  };

  let failure;
  try {
    places.attachWorldCoreBridge(
      bridge
    );
  } catch (error) {
    failure = error;
  }

  assert.ok(
    failure instanceof AggregateError
  );
  assert.ok(
    failure.errors.some(
      (error) =>
        /synthetic late-attach sync failure/.test(
          error.message
        )
    )
  );
  assert.ok(
    failure.errors.some(
      (error) =>
        /synthetic rollback unsubscribe failure/.test(
          error.message
        )
    )
  );

  assert.equal(
    places.bridge,
    null
  );
  assert.equal(
    subscribeCalls,
    1
  );
  assert.equal(
    unsubscribeCalls,
    1
  );

  bridge.syncBoundaryState =
    originalSyncBoundary;

  assert.equal(
    places.attachWorldCoreBridge(
      bridge
    ),
    places
  );

  assert.equal(
    unsubscribeCalls,
    2,
    "reattach must finish the pending unsubscribe before subscribing again"
  );
  assert.equal(
    subscribeCalls,
    2
  );
  assert.equal(
    places.bridge,
    bridge
  );
  places.assertInternalConsistency();
});

test("attaching a different bridge after one is active is rejected", () => {
  const places = new PlaceRegistry();
  const one = makeBridge();
  const two = makeBridge();

  places.attachWorldCoreBridge(one.bridge);
  assert.equal(places.attachWorldCoreBridge(one.bridge), places);

  assert.throws(
    () => places.attachWorldCoreBridge(two.bridge),
    /different bridge/
  );
  assert.equal(places.bridge, one.bridge);
});


test("one WorldCoreBridge cannot be silently hijacked by another registry", () => {
  const one = new PlaceRegistry();
  const two = new PlaceRegistry();
  const { bridge } = makeBridge();

  one.attachWorldCoreBridge(bridge);

  assert.throws(
    () => two.attachWorldCoreBridge(bridge),
    /already attached to a different PlaceRegistry/
  );

  assert.equal(one.bridge, bridge);
  assert.equal(two.bridge, null);

  bridge.dispose();
  assert.equal(
    one.bridge,
    null,
    "disposing a bridge must detach the registry side too"
  );

  assert.equal(two.attachWorldCoreBridge(bridge), two);
  assert.equal(two.bridge, bridge);
  assert.equal(one.bridge, null);
});


test("world event error reporting tolerates hostile thrown values", () => {
  let onError;

  const world = {
    subscribeEvents(_handler, options) {
      onError = options.onError;
      return () => true;
    }
  };

  const bridge = new WorldCoreBridge({
    world,
    navigation: {},
    startJourney() {},
    stopJourney() {}
  });
  const places = new PlaceRegistry({
    captureEvents: true
  });

  places.attachWorldCoreBridge(
    bridge
  );

  const thrown =
    new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new Error(
            "prototype lookup must not escape world event error reporting"
          );
        },
        get(_target, key) {
          if (
            key === Symbol.toPrimitive ||
            key === "toString" ||
            key === "valueOf"
          ) {
            throw new Error(
              "string conversion must not escape world event error reporting"
            );
          }
          return undefined;
        }
      }
    );

  const hostileEvent =
    new Proxy(
      {},
      {
        get(_target, key) {
          if (key === "type") {
            throw new Error(
              "event type lookup must not escape world event error reporting"
            );
          }
          return undefined;
        }
      }
    );

  assert.doesNotThrow(
    () => onError(
      thrown,
      hostileEvent
    )
  );

  const events =
    places.drainEvents();
  assert.deepEqual(
    events.map((event) => ({
      type: event.type,
      worldEventType:
        event.worldEventType,
      message: event.message
    })),
    [{
      type:
        "world-event-bridge-error",
      worldEventType: null,
      message:
        "[unprintable thrown value]"
    }]
  );

  bridge.dispose();
});


test("direct bridge attachment cannot bypass registry ownership", () => {
  const places = new PlaceRegistry();
  const { bridge } = makeBridge();

  assert.throws(
    () => bridge.attachRegistry(places),
    /PlaceRegistry\.attachWorldCoreBridge/
  );
  assert.equal(places.bridge, null);
});

test("disposing an active bridge with materialized places is rejected", () => {
  const places = new PlaceRegistry();
  places.registerDefinition(definition());
  const place = places.createPlace({
    id: "house",
    definitionId: "late-attach-place"
  });
  const { world, bridge } = makeBridge();

  places.attachWorldCoreBridge(bridge);
  const domainId = place.layerDomains.get("inside");
  assert.ok(world.getDomain(domainId));

  assert.throws(
    () => bridge.dispose(),
    /materialized places/
  );
  assert.equal(places.bridge, bridge);
  assert.ok(world.getDomain(domainId));
});


test("disposing a bridge with active direct-domain travel is rejected", () => {
  const places = new PlaceRegistry();
  const {
    world,
    navigation,
    bridge
  } = makeBridge();

  const nav = new Navigation();
  nav.addNode({ id: "a", x: 0, y: 0 });
  nav.addNode({ id: "b", x: 5, y: 0 });
  nav.addRoad({
    id: "road",
    from: "a",
    to: "b"
  });
  navigation.registerTopology(
    "outside-topology",
    nav
  );
  navigation.bindDomain(
    "outside",
    "outside-topology"
  );

  world.addEntity({
    id: "hans",
    domainId: "outside",
    position: { x: 0, y: 0 },
    body: { radius: 0.25 },
    mobility
  });

  places.attachWorldCoreBridge(bridge);

  assert.ok(
    startTravel(
      places,
      bridge,
      "hans",
      {
        domainId: "outside",
        position: { x: 5, y: 0 },
        nodeId: "b"
      }
    )
  );
  assert.equal(
    places.activeTravels.has("hans"),
    true
  );

  assert.throws(
    () => bridge.dispose(),
    /active travel/
  );
  assert.equal(
    places.bridge,
    bridge
  );
  assert.equal(
    places.activeTravels.has("hans"),
    true
  );
});


test("road-bound bridge sync requires road-effect capabilities on demand", () => {
  const world = new World({
    domains: [{ id: "inside-domain" }]
  });
  const instance = {
    id: "house",
    layerDomains: new Map([
      ["inside", "inside-domain"]
    ])
  };
  const boundary = {
    id: "wall",
    layerId: "inside",
    enabled: true,
    roadBindings: [{
      layerId: "inside",
      roadId: "road"
    }]
  };

  const missingSet = new WorldCoreBridge({
    world,
    navigation: {},
    startJourney,
    stopJourney
  });

  assert.throws(
    () =>
      missingSet.syncBoundaryState(
        instance,
        boundary
      ),
    /setDomainRoadEffect/
  );

  const missingRemove =
    new WorldCoreBridge({
      world,
      navigation: {
        setDomainRoadEffect() {}
      },
      startJourney,
      stopJourney
    });

  assert.throws(
    () =>
      missingRemove.syncBoundaryState(
        instance,
        {
          ...boundary,
          enabled: false
        }
      ),
    /removeDomainRoadEffect/
  );
});


test("materialization preflights domain rollback capability before mutation", () => {
  const domains = new Map();
  const world = {
    subscribeEvents() {
      return () => {};
    },
    getDomain(id) {
      return domains.get(id);
    },
    addDomain({ id }) {
      const domain = { id, entityCount: 0 };
      domains.set(id, domain);
      return domain;
    }
  };

  const bridge = new WorldCoreBridge({
    world,
    navigation: {},
    startJourney,
    stopJourney
  });

  const instance = {
    id: "house",
    layerDomains: new Map([
      ["one", "house:one"],
      ["two", "house:two"]
    ])
  };
  const placeDefinition = {
    id: "two-layer-place",
    layers: [
      {
        id: "one",
        topologyId: null,
        navigation: null
      },
      {
        id: "two",
        topologyId: null,
        navigation: null
      }
    ],
    portals: [],
    boundaries: []
  };

  assert.throws(
    () =>
      bridge.materializePlace(
        instance,
        placeDefinition
      ),
    /removeDomain.*transaction|rollback.*removeDomain/i
  );

  assert.equal(
    domains.size,
    0,
    "preflight must fail before any domain is created"
  );
});


test("unmaterialization preflights domain removal capability before mutation", () => {
  const domains = new Map([
    ["house:inside", {
      id: "house:inside",
      entityCount: 0
    }]
  ]);

  const world = {
    subscribeEvents() {
      return () => {};
    },
    getDomain(id) {
      return domains.get(id);
    },
    addDomain({ id }) {
      const domain = {
        id,
        entityCount: 0
      };
      domains.set(id, domain);
      return domain;
    }
  };

  const bridge = new WorldCoreBridge({
    world,
    navigation: {},
    startJourney,
    stopJourney
  });

  const instance = {
    id: "house",
    layerDomains: new Map([
      ["inside", "house:inside"]
    ]),
    dynamicPortals: new Map()
  };
  const placeDefinition = {
    id: "single-layer-place",
    layers: [{
      id: "inside",
      topologyId: null,
      navigation: null
    }],
    portals: [],
    boundaries: []
  };

  assert.throws(
    () =>
      bridge.unmaterializePlace(
        instance,
        placeDefinition
      ),
    /removeDomain.*unmaterial|removeDomain.*rollback|World\.removeDomain/i
  );

  assert.ok(
    domains.has("house:inside"),
    "preflight must fail before the domain can be removed or local cleanup proceeds"
  );
});


test("rollbackMaterializePlace does not hide missing cleanup capabilities", () => {
  const domains = new Map([
    ["leaked-domain", {
      id: "leaked-domain",
      entityCount: 0
    }]
  ]);

  const world = {
    subscribeEvents() {
      return () => {};
    },
    getDomain(id) {
      return domains.get(id);
    }
  };

  const bridge = new WorldCoreBridge({
    world,
    navigation: {},
    startJourney,
    stopJourney
  });

  assert.throws(
    () =>
      bridge.rollbackMaterializePlace(
        {
          id: "house",
          layerDomains: new Map()
        },
        {
          id: "place",
          layers: [],
          portals: [],
          boundaries: []
        },
        {
          domains: [{
            domainId: "leaked-domain",
            existed: false,
            previousBinding: null,
            roadEffects: []
          }],
          newTopologyIds: []
        }
      ),
    /removeDomain/
  );

  assert.ok(
    domains.has("leaked-domain")
  );
});


test("road-effect cleanup attempts every binding after individual failures", () => {
  const removed = [];
  const navigation = {
    removeDomainRoadEffect(
      domainId,
      effectId,
      roadId
    ) {
      removed.push([domainId, effectId, roadId]);
      if (roadId === "one") {
        throw new Error(
          "synthetic road cleanup failure"
        );
      }
    }
  };
  const world = new World({
    domains: [{ id: "inside-domain" }]
  });
  const bridge = new WorldCoreBridge({
    world,
    navigation,
    startJourney,
    stopJourney
  });
  const instance = {
    id: "house",
    layerDomains: new Map([
      ["inside", "inside-domain"]
    ])
  };

  assert.throws(
    () =>
      bridge.clearPortalEffects(
        instance,
        {
          id: "door",
          roadBindings: [
            { layerId: "inside", roadId: "one" },
            { layerId: "inside", roadId: "two" }
          ]
        }
      ),
    /synthetic road cleanup failure/
  );

  assert.deepEqual(
    removed.map((entry) => entry[2]),
    ["one", "two"]
  );

  removed.length = 0;

  assert.throws(
    () =>
      bridge.clearBoundaryEffects(
        instance,
        {
          id: "wall",
          layerId: "inside",
          roadBindings: [
            { roadId: "one" },
            { roadId: "two" }
          ]
        }
      ),
    /synthetic road cleanup failure/
  );

  assert.deepEqual(
    removed.map((entry) => entry[2]),
    ["one", "two"]
  );
});


test("road-effect sync attempts every binding after individual failures", () => {
  const applied = [];
  const navigation = {
    setDomainRoadEffect(
      domainId,
      effectId,
      roadId
    ) {
      applied.push([domainId, effectId, roadId]);
      if (roadId === "one") {
        throw new Error(
          "synthetic road sync failure"
        );
      }
    },
    removeDomainRoadEffect(
      domainId,
      effectId,
      roadId
    ) {
      applied.push([domainId, effectId, roadId]);
      if (roadId === "one") {
        throw new Error(
          "synthetic road remove failure"
        );
      }
    }
  };
  const world = new World({
    domains: [{ id: "inside-domain" }]
  });
  const bridge = new WorldCoreBridge({
    world,
    navigation,
    startJourney,
    stopJourney
  });
  const instance = {
    id: "house",
    layerDomains: new Map([
      ["inside", "inside-domain"]
    ])
  };

  assert.throws(
    () =>
      bridge.syncBoundaryState(
        instance,
        {
          id: "wall",
          layerId: "inside",
          enabled: true,
          roadBindings: [
            { roadId: "one" },
            { roadId: "two" }
          ]
        }
      ),
    /synthetic road sync failure/
  );

  assert.deepEqual(
    applied.map((entry) => entry[2]),
    ["one", "two"]
  );

  applied.length = 0;

  assert.throws(
    () =>
      bridge.syncPortalState(
        instance,
        {
          id: "door",
          roadBindings: [
            { layerId: "inside", roadId: "one" },
            { layerId: "inside", roadId: "two" }
          ]
        },
        {
          connected: true,
          a: {
            domainId: "inside-domain"
          },
          b: {
            domainId: "inside-domain"
          },
          transitionCost: 0,
          enabled: true,
          open: true,
          locked: false,
          blocked: false,
          destroyed: false,
          blocksWhenClosed: false
        }
      ),
    /synthetic road remove failure/
  );

  assert.deepEqual(
    applied.map((entry) => entry[2]),
    ["one", "two"]
  );
});


test("disposing a detached-empty registry releases bridge-owned topologies", () => {
  const places = new PlaceRegistry();
  places.registerDefinition(
    definition()
  );

  const {
    navigation,
    bridge
  } = makeBridge();

  places.attachWorldCoreBridge(
    bridge
  );
  places.createPlace({
    id: "house",
    definitionId:
      "late-attach-place"
  });

  const topologyId =
    places.getDefinition(
      "late-attach-place"
    ).layers[0].topologyId;

  assert.ok(
    navigation.topologies.has(
      topologyId
    )
  );
  assert.equal(
    places.removePlace("house"),
    true
  );

  bridge.dispose();

  assert.equal(places.bridge, null);
  assert.equal(
    navigation.topologies.has(
      topologyId
    ),
    false
  );

  assert.equal(
    places.removeDefinition(
      "late-attach-place"
    ),
    true
  );

  const replacement =
    definition();
  replacement.layers[0]
    .navigation.roads[0].width = 3;

  places.registerDefinition(
    replacement
  );
  places.attachWorldCoreBridge(
    bridge
  );

  assert.doesNotThrow(
    () =>
      places.createPlace({
        id: "replacement-house",
        definitionId:
          "late-attach-place"
      })
  );
  assert.equal(
    navigation.topologies
      .get(topologyId)
      .roads.get("door-road")
      .width,
    3
  );
});


test("failed world-event unsubscribe detaches logically and remains cleanup-retryable", () => {
  let subscribeCalls = 0;
  let unsubscribeCalls = 0;
  let activeSubscription = true;

  const world = {
    subscribeEvents() {
      subscribeCalls += 1;
      activeSubscription = true;
      return () => {
        unsubscribeCalls += 1;
        if (unsubscribeCalls === 1) {
          throw new Error(
            "synthetic unsubscribe failure"
          );
        }
        activeSubscription = false;
        return true;
      };
    }
  };

  const bridge = new WorldCoreBridge({
    world,
    navigation: {},
    startJourney() {},
    stopJourney() {}
  });
  const places = new PlaceRegistry();

  places.attachWorldCoreBridge(
    bridge
  );

  assert.throws(
    () => bridge.dispose(),
    /synthetic unsubscribe failure/
  );

  assert.equal(
    places.bridge,
    null
  );
  assert.equal(
    activeSubscription,
    true
  );
  assert.equal(
    subscribeCalls,
    1
  );
  assert.equal(
    unsubscribeCalls,
    1
  );

  places.attachWorldCoreBridge(
    bridge
  );

  assert.equal(
    unsubscribeCalls,
    2,
    "reattach must clear the old pending subscription first"
  );
  assert.equal(
    subscribeCalls,
    2
  );
  assert.equal(
    places.bridge,
    bridge
  );
  assert.equal(
    activeSubscription,
    true
  );

  assert.equal(
    bridge.dispose(),
    true
  );
  assert.equal(
    unsubscribeCalls,
    3
  );
  assert.equal(
    activeSubscription,
    false
  );
  assert.equal(
    places.bridge,
    null
  );
});


test("reattach retries failed owned topology cleanup before binding a new registry", () => {
  const first = new PlaceRegistry();
  first.registerDefinition(
    definition()
  );

  const {
    navigation,
    bridge
  } = makeBridge();

  first.attachWorldCoreBridge(
    bridge
  );
  const place = first.createPlace({
    id: "house",
    definitionId: "late-attach-place"
  });
  const topologyId =
    first.getDefinition(
      "late-attach-place"
    ).layers[0].topologyId;

  assert.ok(
    navigation.topologies.has(
      topologyId
    )
  );
  assert.equal(
    first.removePlace(
      place.id
    ),
    true
  );

  const originalRemoveTopology =
    navigation.removeTopology.bind(
      navigation
    );
  let removeCalls = 0;
  navigation.removeTopology = (
    id
  ) => {
    removeCalls += 1;
    if (removeCalls === 1) {
      throw new Error(
        "synthetic topology cleanup failure"
      );
    }
    return originalRemoveTopology(
      id
    );
  };

  assert.throws(
    () => bridge.dispose(),
    /synthetic topology cleanup failure/
  );

  assert.equal(
    first.bridge,
    null
  );
  assert.equal(
    navigation.topologies.has(
      topologyId
    ),
    true
  );

  const second =
    new PlaceRegistry();

  assert.equal(
    second.attachWorldCoreBridge(
      bridge
    ),
    second
  );

  assert.equal(
    removeCalls,
    2
  );
  assert.equal(
    navigation.topologies.has(
      topologyId
    ),
    false
  );
  assert.equal(
    second.bridge,
    bridge
  );

  navigation.removeTopology =
    originalRemoveTopology;
  bridge.dispose();
});
