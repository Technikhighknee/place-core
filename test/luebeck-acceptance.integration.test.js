import test from "node:test";
import assert from "node:assert/strict";

import {
  Navigation,
  computeWorldCoreStateHash,
  deserializeWorldCore,
  serializeWorldCore,
  startJourney,
  stopJourney
} from "world-core";

import {
  WorldCoreBridge,
  computePlaceCoreStateHash,
  deserializePlaceCore,
  serializePlaceCore
} from "../src/index.js";

import {
  STREET_DOMAIN,
  buildLuebeckScenario,
  runTravelToCompletion,
  startHansToBarrel,
  stepScenario
} from "./support/luebeck-scenario.js";

test("P90 Lübeck acceptance covers shared interiors, semantic DAG, room portals and moving places", () => {
  const scenario = buildLuebeckScenario();
  const {
    world,
    navigation,
    places,
    definitions,
    houses,
    home,
    tavern,
    ship
  } = scenario;

  assert.equal(houses.length, 50);
  assert.equal(places.instances.size, 59);

  const houseGroundTopology =
    definitions.house.getLayer("ground").topologyId;
  const houseUpperTopology =
    definitions.house.getLayer("upper").topologyId;

  assert.ok(navigation.topologies.has(houseGroundTopology));
  assert.ok(navigation.topologies.has(houseUpperTopology));
  assert.equal(
    [...navigation.domainBindings.values()]
      .filter((id) => id === houseGroundTopology)
      .length,
    50
  );
  assert.equal(
    [...navigation.domainBindings.values()]
      .filter((id) => id === houseUpperTopology)
      .length,
    50
  );

  const startLocation = places.locateEntity(
    world.getEntity("hans")
  );
  assert.equal(startLocation.placeId, "house-17");
  assert.equal(startLocation.deepestSpace.id, "bedroom");
  assert.ok(
    startLocation.semanticPlaces.includes("tax-ward-3")
  );
  assert.ok(
    startLocation.semanticPlaces.includes("luebeck")
  );

  const sailorBefore = {
    domainId: world.getEntity("sailor").domainId,
    position: { ...world.getEntity("sailor").position }
  };

  places.setPlacement("cog-hildegard", {
    domainId: STREET_DOMAIN,
    transform: {
      x: 260,
      y: 18,
      rotation: 0.2,
      scale: 1
    },
    containment: "footprint"
  });
  places.setAttachment("cog-hildegard", "quay", {
    domainId: STREET_DOMAIN,
    position: { x: 260, y: 0 },
    nodeId: "quay-b"
  });

  assert.deepEqual(
    {
      domainId: world.getEntity("sailor").domainId,
      position: world.getEntity("sailor").position
    },
    sailorBefore,
    "moving the ship exterior must not move an occupant in local deck coordinates"
  );

  const travel = startHansToBarrel(scenario);
  assert.ok(travel);
  assert.ok(
    travel.plan.steps.some((step) =>
      step.type === "traverse-portal" &&
      step.portalId === "stairs" &&
      step.placeId === "house-17"
    )
  );
  assert.ok(
    travel.plan.steps.some((step) =>
      step.type === "traverse-portal" &&
      step.portalId === "cellar-main" &&
      step.placeId === "golden-goose"
    )
  );

  const ticks = runTravelToCompletion(scenario);
  assert.ok(ticks > 0);

  const hans = world.getEntity("hans");
  assert.equal(
    hans.domainId,
    tavern.layerDomains.get("cellar")
  );
  assert.ok(Math.abs(hans.position.x - 4) < 1e-6);
  assert.ok(Math.abs(hans.position.y) < 1e-6);

  const finalLocation = places.locateEntity(hans);
  assert.equal(finalLocation.placeId, "golden-goose");
  assert.equal(finalLocation.deepestSpace.id, "cellar-room");

  const events = places.drainEvents();
  assert.ok(events.some((event) =>
    event.type === "portal-traverse" &&
    event.placeId === "house-17" &&
    event.portalId === "bedroom-door" &&
    event.sameDomain === true
  ));
  assert.ok(events.some((event) =>
    event.type === "travel-complete" &&
    event.entityId === "hans"
  ));

  places.assertInternalConsistency();
  navigation.assertInternalConsistency();
  world.assertInternalConsistency();

  assert.equal(home.definitionId, "burgher-house");
  assert.equal(ship.definitionId, "cog");
});

test("P90 eager travel replans around a newly locked cellar path, fails when all alternatives close, and recovers when reopened", () => {
  const scenario = buildLuebeckScenario();
  const { places, world, tavern } = scenario;

  const travel = startHansToBarrel(
    scenario,
    { worldChangePolicy: "eager" }
  );
  assert.ok(travel);
  assert.ok(
    travel.plan.steps.some((step) =>
      step.type === "traverse-portal" &&
      step.portalId === "cellar-main"
    )
  );

  places.setPortalState(
    "golden-goose",
    "cellar-main",
    { locked: true }
  );
  stepScenario(scenario);

  const activeAfterFirstLock =
    places.activeTravels.get("hans");
  assert.ok(activeAfterFirstLock);
  assert.ok(activeAfterFirstLock.replans >= 1);
  assert.ok(
    activeAfterFirstLock.plan.steps.some((step) =>
      step.type === "traverse-portal" &&
      step.portalId === "cellar-service"
    )
  );
  assert.equal(
    activeAfterFirstLock.plan.steps.some((step) =>
      step.type === "traverse-portal" &&
      step.portalId === "cellar-main"
    ),
    false
  );

  places.setPortalState(
    "golden-goose",
    "cellar-service",
    { locked: true }
  );
  stepScenario(scenario);

  assert.equal(
    places.activeTravels.has("hans"),
    false
  );
  let events = places.drainEvents();
  assert.ok(events.some((event) =>
    event.type === "travel-replan" &&
    event.entityId === "hans"
  ));
  assert.ok(events.some((event) =>
    event.type === "travel-failed" &&
    event.entityId === "hans" &&
    event.reason === "no-route-after-world-change"
  ));

  places.setPortalState(
    "golden-goose",
    "cellar-service",
    { locked: false }
  );

  const retry = startHansToBarrel(
    scenario,
    { worldChangePolicy: "eager" }
  );
  assert.ok(retry);
  runTravelToCompletion(scenario);

  const hans = world.getEntity("hans");
  assert.equal(
    hans.domainId,
    tavern.layerDomains.get("cellar")
  );
  assert.ok(Math.abs(hans.position.x - 4) < 1e-6);

  events = places.drainEvents();
  assert.ok(events.some((event) =>
    event.type === "travel-complete" &&
    event.entityId === "hans"
  ));

  places.assertInternalConsistency();
});

test("P90 world-core and place-core snapshots resume the same active trip deterministically", () => {
  const original = buildLuebeckScenario();

  const travel = startHansToBarrel(
    original,
    { worldChangePolicy: "eager" }
  );
  assert.ok(travel);

  for (let i = 0; i < 8; i += 1) {
    stepScenario(original, 0.5);
  }
  assert.ok(original.places.activeTravels.has("hans"));

  original.places.setPortalState(
    "golden-goose",
    "cellar-main",
    { locked: true }
  );
  stepScenario(original, 0.5);

  const worldHashBefore =
    computeWorldCoreStateHash(
      original.world,
      original.navigation
    );
  const placeHashBefore =
    computePlaceCoreStateHash(original.places);

  const worldSnapshot = JSON.parse(JSON.stringify(
    serializeWorldCore(
      original.world,
      original.navigation
    )
  ));
  const placeSnapshot = JSON.parse(JSON.stringify(
    serializePlaceCore(original.places)
  ));

  const restoredWorld =
    deserializeWorldCore(worldSnapshot);
  const restoredBridge = new WorldCoreBridge({
    world: restoredWorld.world,
    navigation: restoredWorld.navigation,
    Navigation,
    startJourney,
    stopJourney,
    existingDomainPolicy: "adopt"
  });
  const restoredPlaces = deserializePlaceCore(
    placeSnapshot,
    {
      bridge: restoredBridge,
      resumeWorldCoreState: true,
      restartTravels: false,
      captureEvents: true,
      eventQueueLimit: 10000
    }
  );

  const restored = {
    world: restoredWorld.world,
    navigation: restoredWorld.navigation,
    bridge: restoredBridge,
    places: restoredPlaces
  };

  assert.equal(
    computeWorldCoreStateHash(
      restored.world,
      restored.navigation
    ),
    worldHashBefore
  );
  assert.equal(
    computePlaceCoreStateHash(restored.places),
    placeHashBefore
  );
  assert.ok(restored.places.activeTravels.has("hans"));

  let ticks = 0;
  while (
    (original.places.activeTravels.has("hans") ||
     restored.places.activeTravels.has("hans")) &&
    ticks < 2000
  ) {
    stepScenario(original, 0.5);
    stepScenario(restored, 0.5);

    assert.equal(
      computeWorldCoreStateHash(
        restored.world,
        restored.navigation
      ),
      computeWorldCoreStateHash(
        original.world,
        original.navigation
      )
    );
    assert.equal(
      computePlaceCoreStateHash(restored.places),
      computePlaceCoreStateHash(original.places)
    );
    ticks += 1;
  }

  assert.ok(ticks < 2000);
  assert.equal(original.places.activeTravels.has("hans"), false);
  assert.equal(restored.places.activeTravels.has("hans"), false);

  assert.equal(
    computeWorldCoreStateHash(
      restored.world,
      restored.navigation
    ),
    computeWorldCoreStateHash(
      original.world,
      original.navigation
    )
  );
  assert.equal(
    computePlaceCoreStateHash(restored.places),
    computePlaceCoreStateHash(original.places)
  );

  original.places.assertInternalConsistency();
  restored.places.assertInternalConsistency();
  original.navigation.assertInternalConsistency();
  restored.navigation.assertInternalConsistency();
  original.world.assertInternalConsistency();
  restored.world.assertInternalConsistency();
});
