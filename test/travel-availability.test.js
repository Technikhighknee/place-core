import test from "node:test";
import assert from "node:assert/strict";

import {
  PlaceRegistry,
  planTravel,
  resolveTravelTarget,
  startTravel,
  stepTravel
} from "../src/index.js";

function definition() {
  return {
    id: "availability-place",
    defaultAnchorId: "private-bed",
    layers: [{ id: "inside" }],
    spaces: [
      {
        id: "public-room",
        layerId: "inside",
        geometry: { type: "aabb", minX: 0, minY: 0, maxX: 5, maxY: 5 }
      },
      {
        id: "private-room",
        layerId: "inside",
        geometry: { type: "aabb", minX: 5, minY: 0, maxX: 10, maxY: 5 }
      }
    ],
    anchors: [
      {
        id: "entry",
        layerId: "inside",
        spaceId: "public-room",
        tags: ["entry", "service"],
        position: { x: 1, y: 2 },
        nodeId: "entry"
      },
      {
        id: "private-bed",
        layerId: "inside",
        spaceId: "private-room",
        tags: ["bed", "service"],
        position: { x: 9, y: 2 },
        nodeId: "bed"
      }
    ]
  };
}

function setup({ captureEvents = false } = {}) {
  const places = new PlaceRegistry({ captureEvents });
  places.registerDefinition(definition());
  const place = places.createPlace({
    id: "house",
    definitionId: "availability-place"
  });
  const entity = {
    id: "hans",
    domainId: place.layerDomains.get("inside"),
    position: { x: 0, y: 2 },
    mobility: { speed: 1 },
    journey: null,
    lastJourneyFailure: null
  };
  const positions = {
    entry: { x: 1, y: 2 },
    bed: { x: 9, y: 2 }
  };
  const bridge = {
    getEntity(id) {
      return id === "hans" ? entity : null;
    },
    planLocalRoute({ position, destinationNodeId }) {
      const target = positions[destinationNodeId];
      if (!target) return null;
      return {
        estimatedSeconds: Math.abs(position.x - target.x) + Math.abs(position.y - target.y)
      };
    },
    startLocalJourney(id, destinationNodeId) {
      if (id !== "hans" || !positions[destinationNodeId]) return false;
      entity.journey = { destinationNodeId };
      return true;
    },
    stopLocalJourney() {
      entity.journey = null;
    },
    transferEntity() {}
  };
  return { places, place, entity, bridge };
}

test("explicit anchor targets reject disabled spaces", () => {
  const { places, bridge } = setup();
  places.setSpaceState("house", "private-room", { enabled: false });

  assert.throws(
    () => planTravel(
      places,
      bridge,
      "hans",
      { placeId: "house", anchorId: "private-bed" }
    ),
    /disabled space/
  );
});

test("implicit place targets fall back from disabled default anchors", () => {
  const { places, bridge } = setup();
  places.setSpaceState("house", "private-room", { enabled: false });

  const plan = planTravel(
    places,
    bridge,
    "hans",
    { placeId: "house" }
  );

  assert.ok(plan);
  assert.equal(plan.resolvedTarget.anchorId, "entry");
  assert.equal(plan.resolvedTarget.spaceId, "public-room");
});

test("direct nearest resolution excludes anchors in disabled spaces", () => {
  const { places } = setup();
  places.setSpaceState("house", "private-room", { enabled: false });

  const resolved = resolveTravelTarget(
    places,
    { kind: "nearest", tag: "service" }
  );

  assert.equal(resolved.anchorId, "entry");
});

test("eager travel fails immediately when its semantic target becomes unavailable", () => {
  const { places, bridge } = setup({ captureEvents: true });

  const travel = startTravel(
    places,
    bridge,
    "hans",
    { placeId: "house", anchorId: "private-bed" },
    { worldChangePolicy: "eager" }
  );
  assert.ok(travel);
  assert.equal(travel.status, "active");

  places.setSpaceState(
    "house",
    "private-room",
    { enabled: false }
  );
  const failed = stepTravel(
    places,
    bridge,
    "hans"
  );

  assert.equal(failed.status, "failed");
  assert.equal(
    failed.failureReason,
    "target-unavailable-after-world-change"
  );
  assert.equal(places.activeTravels.has("hans"), false);
});

test("encounter travel discovers target unavailability only after reaching it", () => {
  const { places, bridge, entity } = setup({ captureEvents: true });

  const travel = startTravel(
    places,
    bridge,
    "hans",
    { placeId: "house", anchorId: "private-bed" },
    { worldChangePolicy: "encounter" }
  );
  assert.ok(travel);
  assert.equal(entity.journey?.destinationNodeId, "bed");

  places.setSpaceState("house", "private-room", { enabled: false });

  const stillActive = stepTravel(
    places,
    bridge,
    "hans"
  );
  assert.equal(stillActive.status, "active");
  assert.equal(stillActive.replans, 0);

  entity.position = { x: 9, y: 2 };
  entity.journey = null;
  const failed = stepTravel(
    places,
    bridge,
    "hans"
  );

  assert.equal(failed.status, "failed");
  assert.equal(
    failed.failureReason,
    "target-unavailable-after-world-change"
  );
  assert.equal(failed.replans, 1);

  const events = places.drainEvents();
  assert.ok(events.some((event) => event.type === "travel-target-unavailable"));
});


test("direct nearest target resolution honors all declarative filters", () => {
  const places = new PlaceRegistry();
  places.registerDefinition({
    id: "nearest-filter-place",
    layers: [{ id: "inside" }],
    spaces: [
      {
        id: "public",
        layerId: "inside",
        geometry: {
          type: "aabb",
          minX: 0,
          minY: 0,
          maxX: 5,
          maxY: 5
        }
      },
      {
        id: "private",
        layerId: "inside",
        geometry: {
          type: "aabb",
          minX: 5,
          minY: 0,
          maxX: 10,
          maxY: 5
        }
      }
    ],
    anchors: [
      {
        id: "public-service",
        kind: "counter",
        layerId: "inside",
        spaceId: "public",
        tags: ["service"],
        position: { x: 1, y: 1 }
      },
      {
        id: "private-service",
        kind: "bed",
        layerId: "inside",
        spaceId: "private",
        tags: ["service"],
        position: { x: 8, y: 1 }
      }
    ]
  });

  places.createPlace({
    id: 1,
    definitionId: "nearest-filter-place"
  });
  places.createPlace({
    id: "1",
    definitionId: "nearest-filter-place"
  });

  let resolved = resolveTravelTarget(places, {
    kind: "nearest",
    tag: "service",
    anchorKind: "bed",
    placeId: "1",
    spaceId: "private"
  });

  assert.equal(resolved.placeId, "1");
  assert.equal(resolved.anchorId, "private-service");

  places.setSpaceState("1", "private", { enabled: false });

  assert.throws(
    () => resolveTravelTarget(places, {
      kind: "nearest",
      tag: "service",
      anchorKind: "bed",
      placeId: "1",
      spaceId: "private"
    }),
    /no enabled anchor matches tag service/
  );

  // Numeric and string IDs remain distinct and deterministically ordered.
  resolved = resolveTravelTarget(places, {
    kind: "nearest",
    tag: "service",
    anchorKind: "counter"
  });
  assert.equal(resolved.placeId, 1);
});

test("explicit anchor and space target must describe the same semantic location", () => {
  const { places } = setup();

  assert.throws(
    () => resolveTravelTarget(places, {
      placeId: "house",
      anchorId: "private-bed",
      spaceId: "public-room"
    }),
    /anchor private-bed is not in space public-room/
  );
});

test("travel targets reject ambiguous and malformed runtime shapes", () => {
  const { places, bridge } = setup();

  const invalidTargets = [
    {
      target: {
        kind: "nearest",
        tag: "service",
        domainId: "x"
      },
      pattern: /nearest travel target contains unknown field domainId/
    },
    {
      target: {
        kind: "closest",
        tag: "service"
      },
      pattern: /target\.kind must be "nearest"/
    },
    {
      target: {
        kind: "nearest",
        tag: 123
      },
      pattern: /target\.tag/
    },
    {
      target: {
        domainId: "inside",
        position: {
          x: Number.NaN,
          y: 0
        }
      },
      pattern: /position must be a finite Vec2/
    },
    {
      target: {
        position: { x: 0, y: 0 }
      },
      pattern: /domainId/
    },
    {
      target: {
        placeId: "house",
        ancorId: "private-bed"
      },
      pattern: /contains unknown field ancorId/
    }
  ];

  for (const { target, pattern } of invalidTargets) {
    assert.throws(
      () => resolveTravelTarget(places, target),
      pattern
    );
    assert.throws(
      () => planTravel(
        places,
        bridge,
        "hans",
        target
      ),
      pattern
    );
  }
});
