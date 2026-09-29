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
  serializePlaceCore,
  startTravel
} from "../src/index.js";

import {
  STREET_DOMAIN,
  buildLuebeckScenario,
  stepScenario
} from "./support/luebeck-scenario.js";

function rng(seed) {
  let x = seed >>> 0;
  return () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return (x >>> 0) / 0x1_0000_0000;
  };
}

function runIntegratedChurn(seed) {
  const random = rng(seed);
  const scenario = buildLuebeckScenario({
    captureEvents: false
  });
  const {
    world,
    navigation,
    places,
    definitions,
    houses
  } = scenario;

  const temporaryPlaces = new Set();

  for (let step = 0; step < 1000; step += 1) {
    const houseIndex = Math.floor(random() * 45);
    const houseId = `house-${houseIndex}`;
    const op = Math.floor(random() * 7);

    if (op === 0) {
      places.setPortalState(
        houseId,
        "bedroom-door",
        { locked: random() < 0.5 }
      );
    } else if (op === 1) {
      const hasMembership =
        places.getPlace(houseId).getMembership(
          "harbor",
          "temporary-zone"
        ) != null;

      if (hasMembership) {
        places.removeMembership(
          houseId,
          "harbor",
          "temporary-zone"
        );
      } else {
        places.addMembership(
          houseId,
          {
            parentPlaceId: "harbor",
            kind: "temporary-zone"
          }
        );
      }
    } else if (op === 2) {
      const useSecondQuay = random() < 0.5;
      places.setAttachment(
        "cog-hildegard",
        "quay",
        {
          domainId: STREET_DOMAIN,
          position: {
            x: useSecondQuay ? 260 : 248,
            y: 0
          },
          nodeId:
            useSecondQuay ? "quay-b" : "quay-a"
        }
      );
    } else if (op === 3) {
      places.setPlacement(
        "cog-hildegard",
        {
          domainId: STREET_DOMAIN,
          transform: {
            x: 240 + random() * 30,
            y: 8 + random() * 12,
            rotation: (random() - 0.5) * 0.6,
            scale: 1
          },
          containment: "footprint"
        }
      );
    } else if (op === 4) {
      const portalId =
        `churn-breach-${Math.floor(random() * 3)}`;
      const instance = places.getPlace(houseId);
      if (instance.dynamicPortals.has(portalId)) {
        places.removePortal(
          houseId,
          portalId
        );
      } else {
        places.addPortal(
          houseId,
          {
            id: portalId,
            kind: "breach",
            a: {
              domainId:
                houses[houseIndex]
                  .layerDomains.get("ground"),
              position: { x: 2, y: 1 }
            },
            b: {
              domainId: STREET_DOMAIN,
              position: {
                x: 10 + houseIndex * 4,
                y: 1
              }
            }
          }
        );
      }
    } else if (op === 5) {
      const tempId =
        `temporary-stall-${Math.floor(random() * 8)}`;

      if (temporaryPlaces.has(tempId)) {
        assert.equal(
          places.removePlace(tempId),
          true
        );
        temporaryPlaces.delete(tempId);
      } else {
        places.createPlace({
          id: tempId,
          definitionId: definitions.courtyard.id,
          parentId: "merchant-quarter"
        });
        temporaryPlaces.add(tempId);
      }
    } else {
      const location = places.locate(
        houses[houseIndex]
          .layerDomains.get("upper"),
        {
          x: random() < 0.5 ? 4 : 10,
          y: 0
        }
      );
      assert.ok(
        location.semanticPlaces.includes(houseId)
      );
    }

    if (step % 50 === 49) {
      places.assertInternalConsistency();
      navigation.assertInternalConsistency();
      world.assertInternalConsistency();
      assert.equal(
        navigation.getDiagnostics().topologyCount,
        9,
        "instance churn must never clone shared topologies"
      );
    }
  }

  for (const tempId of [...temporaryPlaces]) {
    assert.equal(
      places.removePlace(tempId),
      true
    );
  }

  places.assertInternalConsistency();
  navigation.assertInternalConsistency();
  world.assertInternalConsistency();

  assert.equal(
    navigation.getDiagnostics().topologyCount,
    9
  );
  assert.equal(
    navigation.getDiagnostics().boundDomainCount,
    107,
    "temporary instance domains must not leak after cleanup"
  );

  return {
    placeHash: computePlaceCoreStateHash(places),
    worldHash: computeWorldCoreStateHash(
      world,
      navigation
    )
  };
}

test("real world-core structural churn is deterministic and preserves shared topology ownership", () => {
  const first = runIntegratedChurn(0x51A7E);
  const second = runIntegratedChurn(0x51A7E);

  assert.deepEqual(second, first);
});

test("active travel survives repeated full world and place snapshot restores", () => {
  let scenario = buildLuebeckScenario({
    captureEvents: false
  });

  const travel = startTravel(
    scenario.places,
    scenario.bridge,
    "hans",
    {
      placeId: "golden-goose",
      anchorId: "barrel"
    },
    {
      worldChangePolicy: "eager"
    }
  );
  assert.ok(travel);

  for (let cycle = 0; cycle < 5; cycle += 1) {
    for (let tick = 0; tick < 7; tick += 1) {
      stepScenario(scenario, 1);
    }

    if (cycle === 1) {
      scenario.places.setPortalState(
        "golden-goose",
        "cellar-main",
        { locked: true }
      );
      stepScenario(scenario, 1);
    }

    assert.ok(
      scenario.places.activeTravels.has("hans"),
      `travel should still be active before restore cycle ${cycle}`
    );

    const expectedWorldHash =
      computeWorldCoreStateHash(
        scenario.world,
        scenario.navigation
      );
    const expectedPlaceHash =
      computePlaceCoreStateHash(
        scenario.places
      );

    const worldSnapshot =
      JSON.parse(JSON.stringify(
        serializeWorldCore(
          scenario.world,
          scenario.navigation
        )
      ));
    const placeSnapshot =
      JSON.parse(JSON.stringify(
        serializePlaceCore(
          scenario.places
        )
      ));

    const restoredWorld =
      deserializeWorldCore(worldSnapshot);
    const restoredBridge =
      new WorldCoreBridge({
        world: restoredWorld.world,
        navigation: restoredWorld.navigation,
        Navigation,
        startJourney,
        stopJourney,
        existingDomainPolicy: "adopt"
      });
    const restoredPlaces =
      deserializePlaceCore(
        placeSnapshot,
        {
          bridge: restoredBridge,
          resumeWorldCoreState: true,
          restartTravels: false,
          captureEvents: false
        }
      );

    scenario = {
      world: restoredWorld.world,
      navigation: restoredWorld.navigation,
      bridge: restoredBridge,
      places: restoredPlaces
    };

    assert.equal(
      computeWorldCoreStateHash(
        scenario.world,
        scenario.navigation
      ),
      expectedWorldHash
    );
    assert.equal(
      computePlaceCoreStateHash(
        scenario.places
      ),
      expectedPlaceHash
    );

    scenario.places.assertInternalConsistency();
    scenario.navigation.assertInternalConsistency();
    scenario.world.assertInternalConsistency();
  }

  let ticks = 0;
  while (
    scenario.places.activeTravels.has("hans") &&
    ticks < 2000
  ) {
    stepScenario(scenario, 1);
    ticks += 1;
  }

  assert.ok(ticks < 2000);
  assert.equal(
    scenario.places.activeTravels.has("hans"),
    false
  );

  const hans = scenario.world.getEntity("hans");
  const tavern =
    scenario.places.getPlace("golden-goose");
  assert.equal(
    hans.domainId,
    tavern.layerDomains.get("cellar")
  );
  assert.ok(
    Math.abs(hans.position.x - 4) < 1e-6
  );
  assert.ok(
    Math.abs(hans.position.y) < 1e-6
  );

  scenario.places.assertInternalConsistency();
  scenario.navigation.assertInternalConsistency();
  scenario.world.assertInternalConsistency();
});
