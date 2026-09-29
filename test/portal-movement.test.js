import test from "node:test";
import assert from "node:assert/strict";

import {
  PlaceRegistry,
  startTravel,
  stepTravel
} from "../src/index.js";

test("encounter travel replans instead of teleporting through a moved portal endpoint", () => {
  const places = new PlaceRegistry({ captureEvents: true });
  places.registerDefinition({
    id: "movable-door-place",
    layers: [{ id: "inside" }],
    portals: [{
      id: "door",
      a: { kind: "external", slot: "street" },
      b: {
        kind: "local",
        layerId: "inside",
        position: { x: 0, y: 0 },
        nodeId: "inside-door"
      }
    }],
    anchors: [{
      id: "target",
      layerId: "inside",
      position: { x: 5, y: 0 },
      nodeId: "target"
    }]
  });

  const place = places.createPlace({
    id: "house",
    definitionId: "movable-door-place",
    attachments: {
      street: {
        domainId: "street",
        position: { x: 10, y: 0 },
        nodeId: "old-door"
      }
    }
  });

  const entity = {
    id: "hans",
    domainId: "street",
    position: { x: 0, y: 0 },
    mobility: { speed: 1 },
    journey: null,
    lastJourneyFailure: null
  };

  let transfers = 0;
  const nodePositions = new Map([
    ["old-door", { x: 10, y: 0 }],
    ["new-door", { x: 20, y: 0 }],
    ["inside-door", { x: 0, y: 0 }],
    ["target", { x: 5, y: 0 }]
  ]);

  const bridge = {
    getEntity(id) {
      return id === "hans" ? entity : null;
    },
    planLocalRoute({ position, destinationNodeId }) {
      const target = nodePositions.get(destinationNodeId);
      if (!target) return null;
      return {
        estimatedSeconds: Math.abs(position.x - target.x) + Math.abs(position.y - target.y)
      };
    },
    startLocalJourney(id, destinationNodeId) {
      if (id !== "hans" || !nodePositions.has(destinationNodeId)) return false;
      entity.journey = { destinationNodeId };
      return true;
    },
    stopLocalJourney() {
      entity.journey = null;
    },
    transferEntity(id, endpoint) {
      assert.equal(id, "hans");
      transfers += 1;
      entity.domainId = endpoint.domainId;
      entity.position = { ...endpoint.position };
      entity.journey = null;
      return entity;
    }
  };

  const travel = startTravel(
    places,
    bridge,
    "hans",
    { placeId: "house", anchorId: "target" },
    { worldChangePolicy: "encounter", portalEntryTolerance: 0.25 }
  );

  assert.ok(travel);
  assert.equal(entity.journey?.destinationNodeId, "old-door");

  places.setAttachment("house", "street", {
    domainId: "street",
    position: { x: 20, y: 0 },
    nodeId: "new-door"
  });

  stepTravel(places, bridge, "hans");
  assert.equal(travel.replans, 0);
  assert.equal(transfers, 0);

  entity.position = { x: 10, y: 0 };
  entity.journey = null;
  stepTravel(places, bridge, "hans");

  assert.equal(transfers, 0, "stale portal endpoint must never transfer the entity");
  assert.equal(travel.replans, 1);
  assert.equal(travel.status, "active");
  assert.equal(travel.plan.steps[0].type, "local-journey");
  assert.equal(travel.plan.steps[0].destinationNodeId, "new-door");

  const obstacle = places.drainEvents().find((event) =>
    event.type === "travel-obstacle-encountered" &&
    event.obstacle === "portal-endpoint-moved"
  );
  assert.ok(obstacle);
  assert.deepEqual(obstacle.currentPosition, { x: 10, y: 0 });
  assert.deepEqual(obstacle.expectedPosition, { x: 20, y: 0 });

  stepTravel(places, bridge, "hans");
  assert.equal(entity.journey?.destinationNodeId, "new-door");

  entity.position = { x: 20, y: 0 };
  entity.journey = null;
  stepTravel(places, bridge, "hans");

  assert.equal(transfers, 1);
  assert.equal(entity.domainId, place.layerDomains.get("inside"));
  assert.equal(entity.journey?.destinationNodeId, "target");
});

test("portal entry tolerance is validated", () => {
  const places = new PlaceRegistry();
  places.registerDefinition({
    id: "tolerance-place",
    layers: [{ id: "inside" }],
    portals: [{
      id: "door",
      a: { kind: "external", slot: "street" },
      b: {
        kind: "local",
        layerId: "inside",
        position: { x: 0, y: 0 },
        nodeId: "inside-door"
      }
    }],
    anchors: [{
      id: "target",
      layerId: "inside",
      position: { x: 1, y: 0 },
      nodeId: "target"
    }]
  });
  places.createPlace({
    id: "house",
    definitionId: "tolerance-place",
    attachments: {
      street: {
        domainId: "street",
        position: { x: 0, y: 0 },
        nodeId: "street-door"
      }
    }
  });

  const entity = {
    id: "hans",
    domainId: "street",
    position: { x: 0, y: 0 },
    mobility: { speed: 1 },
    journey: null
  };
  const bridge = {
    getEntity() { return entity; },
    planLocalRoute() { return { estimatedSeconds: 0 }; },
    startLocalJourney() { return true; },
    stopLocalJourney() {},
    transferEntity() {}
  };

  assert.throws(
    () => startTravel(
      places,
      bridge,
      "hans",
      { placeId: "house", anchorId: "target" },
      { portalEntryTolerance: -1 }
    ),
    /portalEntryTolerance/
  );
});
