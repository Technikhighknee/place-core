import test from "node:test";
import assert from "node:assert/strict";

import {
  World,
  Navigation,
  NavigationRegistry,
  mobilityProfile,
  startJourney,
  stopJourney,
  stepSimulation
} from "world-core";

import {
  PlaceRegistry,
  WorldCoreBridge,
  startTravel,
  stepPlaceSimulation
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
