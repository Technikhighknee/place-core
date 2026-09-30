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
  planTravel,
  startTravel,
  stepPlaceSimulation
} from "../src/index.js";
import { tavernBlueprint } from "./fixtures.js";

function buildIntegratedWorld() {
  const world = new World({ domains: [{ id: "street" }] });
  const navigation = new NavigationRegistry();

  const street = new Navigation();
  street.addNode({ id: "street-home", x: 0, y: 0 });
  street.addNode({ id: "street-goose", x: 40, y: 0 });
  street.addRoad({
    id: "street-main",
    from: "street-home",
    to: "street-goose",
    width: 5,
    surface: "road"
  });
  navigation.registerTopology("street", street);
  navigation.bindDomain("street", "street");

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
  places.registerDefinition(tavernBlueprint());

  const home = places.createPlace({
    id: "home",
    definitionId: "tavern",
    attachments: {
      street: {
        domainId: "street",
        position: { x: 0, y: 0 },
        nodeId: "street-home"
      }
    }
  });

  const goose = places.createPlace({
    id: "golden-goose",
    definitionId: "tavern",
    attachments: {
      street: {
        domainId: "street",
        position: { x: 40, y: 0 },
        nodeId: "street-goose"
      }
    }
  });

  world.addEntity({
    id: "hans",
    domainId: home.layerDomains.get("ground"),
    position: { x: 5, y: 0 },
    body: { radius: 0.3 },
    mobility: mobilityProfile("pedestrian")
  });
  places.updateEntityOccupancy(world.getEntity("hans"));

  return { world, navigation, bridge, places, home, goose };
}

test("real world-core executes cross-domain travel through shared interiors", () => {
  const { world, navigation, bridge, places, goose } = buildIntegratedWorld();

  assert.equal(navigation.topologies.size, 3);
  assert.equal(navigation.domainBindings.size, 5);
  assert.equal(places.definitions.size, 1);
  assert.equal(places.instances.size, 2);

  const plan = planTravel(
    places,
    bridge,
    "hans",
    { placeId: "golden-goose", anchorId: "barrel" }
  );

  assert.ok(plan);
  assert.deepEqual(
    plan.legs.map((leg) => leg.type),
    ["local-journey", "traverse-portal", "local-journey", "traverse-portal", "local-journey", "traverse-portal", "local-journey"]
  );

  const state = startTravel(
    places,
    bridge,
    "hans",
    { placeId: "golden-goose", anchorId: "barrel" }
  );
  assert.ok(state);

  let ticks = 0;
  while (places.activeTravels?.has("hans") && ticks < 300) {
    stepSimulation(world, navigation, 1);
    stepPlaceSimulation(places, bridge, 1);
    ticks += 1;
  }

  assert.ok(ticks < 300, "travel should complete");
  const hans = world.getEntity("hans");
  assert.equal(hans.domainId, goose.layerDomains.get("cellar"));
  assert.ok(Math.abs(hans.position.x - 6) < 1e-6);
  assert.ok(Math.abs(hans.position.y) < 1e-6);

  const context = places.locateEntity(hans);
  assert.equal(context.placeId, "golden-goose");
  assert.equal(context.deepestSpace.id, "cellar-room");
});

test("locked portal invalidates an active plan and deterministic replan fails cleanly", () => {
  const { world, navigation, bridge, places } = buildIntegratedWorld();

  const state = startTravel(
    places,
    bridge,
    "hans",
    { placeId: "golden-goose", anchorId: "barrel" },
    { worldChangePolicy: "eager" }
  );
  assert.ok(state);

  places.setPortalState("golden-goose", "cellar-stairs", { locked: true });

  stepSimulation(world, navigation, 1);
  stepPlaceSimulation(places, bridge, 1);

  assert.equal(places.activeTravels.has("hans"), false);
  const events = places.drainEvents();
  assert.ok(events.some((event) =>
    event.type === "travel-failed" &&
    event.reason === "no-route-after-world-change"
  ));
});


test("encounter policy discovers a locked portal only when the traveler reaches it", () => {
  const { world, navigation, bridge, places } = buildIntegratedWorld();

  const state = startTravel(
    places,
    bridge,
    "hans",
    { placeId: "golden-goose", anchorId: "barrel" },
    { worldChangePolicy: "encounter" }
  );
  assert.ok(state);
  assert.equal(state.worldChangePolicy, "encounter");

  places.setPortalState("golden-goose", "cellar-stairs", { locked: true });

  stepSimulation(world, navigation, 1);
  stepPlaceSimulation(places, bridge, 1);

  assert.equal(
    places.activeTravels.has("hans"),
    true,
    "encounter policy must not telepathically invalidate the trip"
  );

  let ticks = 1;
  while (places.activeTravels.has("hans") && ticks < 300) {
    stepSimulation(world, navigation, 1);
    stepPlaceSimulation(places, bridge, 1);
    ticks += 1;
  }

  assert.ok(ticks < 300);
  assert.equal(places.activeTravels.has("hans"), false);

  const events = places.drainEvents();
  const obstacle = events.find((event) =>
    event.type === "travel-obstacle-encountered" &&
    event.portalId === "cellar-stairs"
  );
  assert.ok(obstacle, "traveler should encounter the locked cellar stairs");
  assert.equal(obstacle.state.locked, true);
  assert.ok(events.some((event) =>
    event.type === "travel-failed" &&
    event.reason === "no-route-after-world-change"
  ));
});


test("external world-core domain transfers refresh tracked place occupancy", () => {
  const { world, places } = buildIntegratedWorld();

  assert.equal(
    places.getEntityLocation("hans")?.placeId,
    "home"
  );

  world.transferEntity(
    "hans",
    {
      domainId: "street",
      position: { x: 20, y: 0 }
    }
  );

  const location =
    places.getEntityLocation("hans");
  assert.ok(location);
  assert.equal(location.domainId, "street");
  assert.equal(location.placeId, null);
  assert.equal(
    places.entitiesInPlace("home").has("hans"),
    false
  );
});

test("world-core entity removal clears occupancy and active travel", () => {
  const {
    world,
    bridge,
    places
  } = buildIntegratedWorld();

  assert.ok(
    startTravel(
      places,
      bridge,
      "hans",
      {
        placeId: "golden-goose",
        anchorId: "barrel"
      }
    )
  );
  assert.equal(
    places.activeTravels.has("hans"),
    true
  );
  assert.ok(
    places.getEntityLocation("hans")
  );

  assert.equal(
    world.removeEntity("hans"),
    true
  );

  assert.equal(
    places.activeTravels.has("hans"),
    false
  );
  assert.equal(
    places.getEntityLocation("hans"),
    null
  );
  assert.equal(
    places.entitiesInPlace("home").has("hans"),
    false
  );

  const events = places.drainEvents();
  assert.ok(events.some((event) =>
    event.type === "travel-failed" &&
    event.entityId === "hans" &&
    event.reason === "entity-removed"
  ));
});
