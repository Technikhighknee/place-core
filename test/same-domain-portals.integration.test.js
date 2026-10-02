import test from "node:test";
import assert from "node:assert/strict";

import {
  World,
  Navigation,
  NavigationRegistry,
  mobilityProfile,
  startJourney,
  stopJourney,
  stepSimulation,
  serializeWorldCore,
  deserializeWorldCore
} from "world-core";

import {
  PlaceRegistry,
  WorldCoreBridge,
  startTravel,
  stepPlaceSimulation,
  serializePlaceCore,
  deserializePlaceCore
} from "../src/index.js";

function roomDoorDefinition() {
  return {
    id: "same-domain-rooms",
    layers: [{
      id: "ground",
      navigation: {
        nodes: [
          { id: "start", x: -5, y: 0 },
          { id: "tap-door", x: 0, y: 0 },
          { id: "kitchen-door", x: 1, y: 0 },
          { id: "target", x: 6, y: 0 }
        ],
        roads: [
          {
            id: "tap-approach",
            from: "start",
            to: "tap-door",
            width: 2
          },
          {
            id: "room-threshold",
            from: "tap-door",
            to: "kitchen-door",
            width: 1
          },
          {
            id: "kitchen-approach",
            from: "kitchen-door",
            to: "target",
            width: 2
          }
        ]
      }
    }],
    spaces: [
      {
        id: "taproom",
        layerId: "ground",
        geometry: {
          type: "aabb",
          minX: -6,
          minY: -2,
          maxX: 0.5,
          maxY: 2
        }
      },
      {
        id: "kitchen",
        layerId: "ground",
        geometry: {
          type: "aabb",
          minX: 0.5,
          minY: -2,
          maxX: 7,
          maxY: 2
        },
        defaultAnchorId: "kitchen-target"
      }
    ],
    portals: [{
      id: "kitchen-door",
      kind: "door",
      a: {
        kind: "local",
        layerId: "ground",
        spaceId: "taproom",
        position: { x: 0, y: 0 },
        nodeId: "tap-door"
      },
      b: {
        kind: "local",
        layerId: "ground",
        spaceId: "kitchen",
        position: { x: 1, y: 0 },
        nodeId: "kitchen-door"
      },
      transitionCost: 2,
      roadBindings: [{
        layerId: "ground",
        roadId: "room-threshold"
      }]
    }],
    anchors: [{
      id: "kitchen-target",
      layerId: "ground",
      spaceId: "kitchen",
      position: { x: 6, y: 0 },
      nodeId: "target"
    }]
  };
}

function setup() {
  const world = new World({
    captureEvents: false
  });
  const navigation = new NavigationRegistry();
  const bridge = new WorldCoreBridge({
    world,
    navigation,
    Navigation,
    startJourney,
    stopJourney
  });
  const places = new PlaceRegistry({
    bridge,
    captureEvents: true
  });
  places.registerDefinition(roomDoorDefinition());
  const place = places.createPlace({
    id: "inn",
    definitionId: "same-domain-rooms"
  });

  world.addEntity({
    id: "hans",
    domainId: place.layerDomains.get("ground"),
    position: { x: -5, y: 0 },
    body: { radius: 0.3 },
    mobility: mobilityProfile("pedestrian")
  });
  places.updateEntityOccupancy(world.getEntity("hans"));
  places.drainEvents();

  return {
    world,
    navigation,
    bridge,
    places,
    place
  };
}

test("same-domain portal transition cost becomes physical world-core road delay", () => {
  const {
    world,
    navigation,
    bridge,
    places,
    place
  } = setup();

  const domainId = place.layerDomains.get("ground");
  const domainNavigation = navigation.navigationForDomain(domainId);
  const topologyId = places.getDefinition("same-domain-rooms")
    .getLayer("ground").topologyId;
  const sharedTopology = navigation.topologies.get(topologyId);
  const mobility = world.getEntity("hans").mobility;

  assert.equal(
    domainNavigation.roadTraversalDelaySeconds("room-threshold"),
    2
  );

  const sharedRoute = sharedTopology.findRoute(
    "start",
    "target",
    mobility
  );
  const domainRoute = domainNavigation.findRoute(
    "start",
    "target",
    mobility
  );

  assert.ok(sharedRoute);
  assert.ok(domainRoute);
  assert.ok(
    Math.abs(
      domainRoute.estimatedSeconds -
      sharedRoute.estimatedSeconds -
      2
    ) < 1e-9
  );

  const state = startTravel(
    places,
    bridge,
    "hans",
    {
      placeId: "inn",
      anchorId: "kitchen-target"
    }
  );

  assert.ok(state);
  assert.ok(
    Math.abs(
      state.plan.estimatedSeconds -
      domainRoute.estimatedSeconds
    ) < 1e-9
  );
});

test("same-domain room doors emit semantic portal traversal events from world-core roads", () => {
  const {
    world,
    navigation,
    bridge,
    places,
    place
  } = setup();

  const state = startTravel(
    places,
    bridge,
    "hans",
    {
      placeId: "inn",
      anchorId: "kitchen-target"
    }
  );

  assert.ok(state);
  assert.deepEqual(
    state.plan.steps.map((step) => step.type),
    ["local-journey"],
    "same-domain room traversal stays one world-core journey"
  );

  let ticks = 0;
  while (places.activeTravels.has("hans") && ticks < 100) {
    stepSimulation(world, navigation, 0.25);
    stepPlaceSimulation(places, bridge, 0.25);
    ticks += 1;
  }

  assert.ok(ticks < 100);
  const hans = world.getEntity("hans");
  assert.equal(hans.domainId, place.layerDomains.get("ground"));
  assert.ok(Math.abs(hans.position.x - 6) < 1e-6);

  const location = places.getEntityLocation("hans");
  assert.equal(location.deepestSpace?.id, "kitchen");

  const portalEvents = places.drainEvents()
    .filter((event) =>
      event.portalId === "kitchen-door" &&
      event.sameDomain === true
    );

  assert.deepEqual(
    portalEvents.map((event) => event.type),
    ["portal-enter", "portal-traverse", "portal-exit"]
  );

  for (const event of portalEvents) {
    assert.equal(event.roadId, "room-threshold");
    assert.equal(event.fromDomainId, place.layerDomains.get("ground"));
    assert.equal(event.toDomainId, place.layerDomains.get("ground"));
    assert.equal(event.fromSpaceId, "taproom");
    assert.equal(event.toSpaceId, "kitchen");
  }

  assert.deepEqual(world.peekEvents(), []);
});

test("restored world journeys retain an in-progress same-domain portal lifecycle", () => {
  const {
    world,
    navigation,
    bridge,
    places
  } = setup();

  const state = startTravel(
    places,
    bridge,
    "hans",
    {
      placeId: "inn",
      anchorId: "kitchen-target"
    }
  );
  assert.ok(state);

  let entered = false;
  for (let i = 0; i < 100 && !entered; i += 1) {
    stepSimulation(
      world,
      navigation,
      0.1
    );
    stepPlaceSimulation(
      places,
      bridge,
      0.1
    );
    entered = places.peekEvents().some(
      (event) =>
        event.type === "portal-enter" &&
        event.portalId === "kitchen-door"
    );
  }

  assert.equal(entered, true);
  assert.equal(
    places.peekEvents().some(
      (event) =>
        event.type === "portal-traverse" &&
        event.portalId === "kitchen-door"
    ),
    false
  );
  assert.equal(
    world.getEntity("hans")
      .journey?.roadEntered,
    true
  );

  const worldSnapshot =
    serializeWorldCore(
      world,
      navigation
    );
  const placeSnapshot =
    serializePlaceCore(
      places
    );

  const restoredWorld =
    deserializeWorldCore(
      worldSnapshot
    );
  const restoredEntity =
    restoredWorld.world.getEntity(
      "hans"
    );
  assert.equal(
    restoredEntity.journey?.roadEntered,
    true
  );
  const restoredLeg =
    restoredEntity.journey?.prefixLeg ??
    restoredEntity.journey?.route?.legs?.[
      restoredEntity.journey?.legIndex
    ] ??
    null;
  assert.equal(
    restoredLeg?.roadId,
    "room-threshold"
  );

  const restoredBridge =
    new WorldCoreBridge({
      world: restoredWorld.world,
      navigation:
        restoredWorld.navigation,
      Navigation,
      startJourney,
      stopJourney,
      existingDomainPolicy: "adopt"
    });
  const synchronizeRuntimeState =
    restoredBridge.synchronizeRuntimeState
      .bind(restoredBridge);
  let synchronizedCrossings = null;
  restoredBridge.synchronizeRuntimeState =
    () => {
      synchronizedCrossings =
        synchronizeRuntimeState();
      return synchronizedCrossings;
    };

  const restoredPlaces =
    deserializePlaceCore(
      placeSnapshot,
      {
        bridge: restoredBridge,
        resumeWorldCoreState: true
      }
    );

  assert.equal(
    restoredPlaces.getPortalsForRoad(
      restoredEntity.domainId,
      "room-threshold"
    ).length,
    1
  );
  assert.equal(
    synchronizedCrossings,
    1
  );

  let ticks = 0;
  while (
    restoredPlaces.activeTravels.has(
      "hans"
    ) &&
    ticks < 100
  ) {
    stepSimulation(
      restoredWorld.world,
      restoredWorld.navigation,
      0.1
    );
    stepPlaceSimulation(
      restoredPlaces,
      restoredBridge,
      0.1
    );
    ticks += 1;
  }

  assert.ok(ticks < 100);
  const events =
    restoredPlaces.drainEvents()
      .filter(
        (event) =>
          event.portalId ===
            "kitchen-door" &&
          event.sameDomain === true
      );

  assert.deepEqual(
    events.map((event) =>
      event.type
    ),
    [
      "portal-traverse",
      "portal-exit"
    ]
  );
});

test("reverse same-domain room traversal reports reversed semantic direction", () => {
  const {
    world,
    navigation,
    bridge,
    places,
    place
  } = setup();

  const hans = world.getEntity("hans");
  world.setPosition("hans", { x: 6, y: 0 });
  places.updateEntityOccupancy(hans);
  places.drainEvents();

  const nav = navigation.navigationForDomain(
    place.layerDomains.get("ground")
  );
  assert.ok(nav);

  const ok = bridge.startLocalJourney("hans", "start");
  assert.equal(ok, true);

  let ticks = 0;
  while (hans.journey && ticks < 100) {
    stepSimulation(world, navigation, 0.25);
    places.updateEntityOccupancy(hans);
    ticks += 1;
  }

  assert.ok(ticks < 100);

  const portalEvents = places.drainEvents()
    .filter((event) =>
      event.portalId === "kitchen-door" &&
      event.sameDomain === true
    );

  assert.deepEqual(
    portalEvents.map((event) => event.type),
    ["portal-enter", "portal-traverse", "portal-exit"]
  );
  for (const event of portalEvents) {
    assert.equal(event.fromSpaceId, "kitchen");
    assert.equal(event.toSpaceId, "taproom");
  }
});

test("locking a same-domain room door blocks the bound world-core threshold road", () => {
  const {
    world,
    navigation,
    bridge,
    places,
    place
  } = setup();

  places.setPortalState("inn", "kitchen-door", {
    locked: true
  });

  const nav = navigation.navigationForDomain(
    place.layerDomains.get("ground")
  );
  assert.equal(
    nav.findRoute(
      "start",
      "target",
      world.getEntity("hans").mobility
    ),
    null
  );

  assert.equal(
    startTravel(
      places,
      bridge,
      "hans",
      {
        placeId: "inn",
        anchorId: "kitchen-target"
      }
    ),
    null
  );

  assert.equal(
    places.drainEvents().some((event) =>
      event.type === "portal-enter" &&
      event.portalId === "kitchen-door"
    ),
    false
  );
});

test("cancelled threshold traversal emits portal-abort rather than traverse", () => {
  const {
    world,
    navigation,
    bridge,
    places
  } = setup();

  const hans = world.getEntity("hans");
  assert.equal(
    bridge.startLocalJourney("hans", "target"),
    true
  );

  let entered = false;
  for (let i = 0; i < 100 && !entered; i += 1) {
    stepSimulation(world, navigation, 0.1);
    entered = places.peekEvents().some((event) =>
      event.type === "portal-enter" &&
      event.portalId === "kitchen-door"
    );
  }
  assert.equal(entered, true);

  bridge.stopLocalJourney("hans");

  const events = places.drainEvents()
    .filter((event) => event.portalId === "kitchen-door");

  assert.deepEqual(
    events.map((event) => event.type),
    ["portal-enter", "portal-abort"]
  );
  assert.equal(events[1].reason, "cancelled");
});


test("external domain transfer aborts an open same-domain portal crossing", () => {
  const {
    world,
    navigation,
    bridge,
    places
  } = setup();

  world.addDomain({ id: "escape" });

  assert.equal(
    bridge.startLocalJourney("hans", "target"),
    true
  );

  let entered = false;
  for (let i = 0; i < 100 && !entered; i += 1) {
    stepSimulation(world, navigation, 0.1);
    entered = places.peekEvents().some((event) =>
      event.type === "portal-enter" &&
      event.portalId === "kitchen-door"
    );
  }
  assert.equal(entered, true);

  world.transferEntity(
    "hans",
    {
      domainId: "escape",
      position: { x: 0, y: 0 }
    }
  );

  const events = places.drainEvents()
    .filter((event) =>
      event.portalId === "kitchen-door"
    );

  assert.deepEqual(
    events.map((event) => event.type),
    ["portal-enter", "portal-abort"]
  );
  assert.equal(
    events[1].reason,
    "domain-transfer"
  );
  assert.equal(
    places.getEntityLocation("hans")?.domainId,
    "escape"
  );
});


test("external journey cancellation cannot falsely complete a local travel leg", () => {
  const {
    world,
    bridge,
    places
  } = setup();

  world.addDomain({ id: "escape" });

  const state = startTravel(
    places,
    bridge,
    "hans",
    {
      placeId: "inn",
      anchorId: "kitchen-target"
    }
  );
  assert.ok(state);
  assert.equal(
    places.activeTravels.has("hans"),
    true
  );

  world.transferEntity(
    "hans",
    {
      domainId: "escape",
      position: { x: 0, y: 0 }
    }
  );

  stepPlaceSimulation(
    places,
    bridge,
    0.1
  );

  assert.equal(
    places.activeTravels.has("hans"),
    false
  );

  const events = places.drainEvents();
  assert.equal(
    events.some((event) =>
      event.type === "travel-complete" &&
      event.entityId === "hans"
    ),
    false
  );
  assert.ok(events.some((event) =>
    event.type === "travel-failed" &&
    event.entityId === "hans" &&
    event.reason === "no-route-after-world-change"
  ));
});


test("removing a same-domain dynamic portal mid-crossing aborts instead of emitting stale traversal", () => {
  const world = new World();
  const navigation = new NavigationRegistry();
  const bridge = new WorldCoreBridge({
    world,
    navigation,
    Navigation,
    startJourney,
    stopJourney
  });
  const places = new PlaceRegistry({
    bridge,
    captureEvents: true
  });

  places.registerDefinition({
    id: "dynamic-threshold-place",
    layers: [{
      id: "ground",
      navigation: {
        nodes: [
          { id: "a", x: 0, y: 0 },
          { id: "b", x: 4, y: 0 }
        ],
        roads: [{
          id: "threshold",
          from: "a",
          to: "b"
        }]
      }
    }],
    spaces: [
      {
        id: "left",
        layerId: "ground",
        geometry: {
          type: "aabb",
          minX: -1,
          minY: -1,
          maxX: 2,
          maxY: 1
        }
      },
      {
        id: "right",
        layerId: "ground",
        geometry: {
          type: "aabb",
          minX: 2,
          minY: -1,
          maxX: 5,
          maxY: 1
        }
      }
    ]
  });

  const place = places.createPlace({
    id: "hall",
    definitionId: "dynamic-threshold-place"
  });
  const domainId =
    place.layerDomains.get("ground");

  places.addPortal("hall", {
    id: "temporary-door",
    a: {
      domainId,
      position: { x: 0, y: 0 },
      nodeId: "a",
      placeId: "hall",
      layerId: "ground",
      spaceId: "left"
    },
    b: {
      domainId,
      position: { x: 4, y: 0 },
      nodeId: "b",
      placeId: "hall",
      layerId: "ground",
      spaceId: "right"
    },
    roadBindings: [{
      layerId: "ground",
      roadId: "threshold"
    }]
  });

  world.addEntity({
    id: "hans",
    domainId,
    position: { x: 0, y: 0 },
    body: { radius: 0.25 },
    mobility: {
      speed: 1,
      surfaceMultipliers: {},
      requiredRoadWidth: 0,
      requiredRoadTags: [],
      blockedRoadTags: []
    }
  });

  assert.equal(
    bridge.startLocalJourney("hans", "b"),
    true
  );

  let entered = false;
  for (let i = 0; i < 20 && !entered; i += 1) {
    stepSimulation(
      world,
      navigation,
      0.05
    );
    entered = places.peekEvents().some(
      (event) =>
        event.type === "portal-enter" &&
        event.portalId === "temporary-door"
    );
  }
  assert.equal(entered, true);

  assert.equal(
    places.removePortal(
      "hall",
      "temporary-door"
    ),
    true
  );

  for (let i = 0; i < 200 && world.getEntity("hans").journey; i += 1) {
    stepSimulation(
      world,
      navigation,
      0.05
    );
  }

  const portalEvents = places
    .drainEvents()
    .filter(
      (event) =>
        event.portalId ===
          "temporary-door"
    );

  assert.deepEqual(
    portalEvents.map((event) =>
      event.type
    ),
    [
      "portal-added",
      "portal-enter",
      "portal-removed",
      "portal-abort"
    ]
  );
  assert.equal(
    portalEvents.at(-1).reason,
    "portal-changed"
  );
  assert.equal(
    portalEvents.some((event) =>
      event.type === "portal-traverse"
    ),
    false
  );
  assert.equal(
    portalEvents.some((event) =>
      event.type === "portal-exit"
    ),
    false
  );
});


test("same-domain road exit read failure aborts an open portal lifecycle", () => {
  const {
    world,
    navigation,
    bridge,
    places
  } = setup();

  const hans =
    world.getEntity("hans");

  assert.equal(
    bridge.startLocalJourney(
      "hans",
      "target"
    ),
    true
  );

  let entered = false;
  for (
    let i = 0;
    i < 100 && !entered;
    i += 1
  ) {
    stepSimulation(
      world,
      navigation,
      0.1
    );
    entered = places.peekEvents().some(
      (event) =>
        event.type === "portal-enter" &&
        event.portalId === "kitchen-door"
    );
  }
  assert.equal(entered, true);

  const originalGetEntity =
    world.getEntity.bind(world);
  world.getEntity = () => {
    throw new Error(
      "synthetic road-exit world read failure"
    );
  };

  for (
    let i = 0;
    i < 100 && hans.journey;
    i += 1
  ) {
    stepSimulation(
      world,
      navigation,
      0.1
    );
  }

  world.getEntity =
    originalGetEntity;

  const events =
    places.drainEvents();
  const portalEvents =
    events.filter(
      (event) =>
        event.portalId === "kitchen-door"
    );

  assert.deepEqual(
    portalEvents.map((event) =>
      event.type
    ),
    [
      "portal-enter",
      "portal-abort"
    ]
  );
  assert.equal(
    portalEvents[1].reason,
    "world-state-error"
  );
  assert.equal(
    portalEvents.some((event) =>
      event.type === "portal-traverse"
    ),
    false
  );
  assert.equal(
    portalEvents.some((event) =>
      event.type === "portal-exit"
    ),
    false
  );
  assert.ok(
    events.some(
      (event) =>
        event.type ===
          "world-event-bridge-error" &&
        event.worldEventType ===
          "roadLeft" &&
        /synthetic road-exit world read failure/.test(
          event.message
        )
    )
  );
});
