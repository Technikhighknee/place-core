import test from "node:test";
import assert from "node:assert/strict";

import {
  PlaceRegistry,
  planTravel
} from "../src/index.js";

function buildPlannerFixture() {
  const places = new PlaceRegistry();
  places.registerDefinition({
    id: "two-door-house",
    defaultAnchorId: "target",
    layers: [{ id: "inside" }],
    spaces: [{
      id: "room",
      layerId: "inside",
      geometry: { type: "aabb", minX: -1, minY: -1, maxX: 11, maxY: 1 },
      defaultAnchorId: "target"
    }],
    portals: [
      {
        id: "door-1",
        a: { kind: "external", slot: "street-1" },
        b: {
          kind: "local",
          layerId: "inside",
          spaceId: "room",
          position: { x: 0, y: 0 },
          nodeId: "door-1"
        }
      },
      {
        id: "door-2",
        a: { kind: "external", slot: "street-2" },
        b: {
          kind: "local",
          layerId: "inside",
          spaceId: "room",
          position: { x: 10, y: 0 },
          nodeId: "door-2"
        }
      }
    ],
    anchors: [{
      id: "target",
      layerId: "inside",
      spaceId: "room",
      position: { x: 9, y: 0 },
      nodeId: "target"
    }]
  });

  const home = places.createPlace({
    id: "home",
    definitionId: "two-door-house",
    attachments: {
      "street-1": { domainId: "street", position: { x: 0, y: 0 }, nodeId: "s-home-1" },
      "street-2": { domainId: "street", position: { x: 100, y: 0 }, nodeId: "s-home-2" }
    }
  });

  const inn = places.createPlace({
    id: "inn",
    definitionId: "two-door-house",
    attachments: {
      "street-1": { domainId: "street", position: { x: 20, y: 0 }, nodeId: "s-inn-1" },
      "street-2": { domainId: "street", position: { x: 120, y: 0 }, nodeId: "s-inn-2" }
    }
  });

  const nodeX = new Map([
    ["door-1", 0],
    ["door-2", 10],
    ["target", 9],
    ["s-home-1", 0],
    ["s-home-2", 100],
    ["s-inn-1", 20],
    ["s-inn-2", 120]
  ]);

  const entity = {
    id: "hans",
    domainId: home.layerDomains.get("inside"),
    position: { x: 9, y: 0 },
    mobility: { speed: 1 }
  };

  const bridge = {
    getEntity(id) {
      return id === entity.id ? entity : null;
    },
    planLocalRoute({ position, destinationNodeId }) {
      const x = nodeX.get(destinationNodeId);
      if (x == null) return null;
      return { estimatedSeconds: Math.abs(position.x - x) };
    },
    startLocalJourney() { return true; },
    stopLocalJourney() {},
    transferEntity() {}
  };

  return { places, bridge, entity, home, inn };
}

test("planner optimizes concrete portal choices inside the domain path", () => {
  const { places, bridge } = buildPlannerFixture();

  const plan = planTravel(
    places,
    bridge,
    "hans",
    { placeId: "inn", anchorId: "target" }
  );

  assert.ok(plan);
  assert.deepEqual(plan.domainPath, ["home:inside", "street", "inn:inside"]);

  const portalSteps = plan.steps.filter((step) => step.type === "traverse-portal");
  assert.deepEqual(portalSteps.map((step) => step.portalId), ["door-2", "door-2"]);
  assert.equal(plan.estimatedSeconds, 22);
});

test("planner re-optimizes when the cheapest portal becomes unavailable", () => {
  const { places, bridge } = buildPlannerFixture();
  places.setPortalState("inn", "door-2", { locked: true });

  const plan = planTravel(
    places,
    bridge,
    "hans",
    { placeId: "inn", anchorId: "target" }
  );

  assert.ok(plan);
  const portalSteps = plan.steps.filter((step) => step.type === "traverse-portal");
  assert.equal(portalSteps.at(-1).portalId, "door-1");
  assert.ok(plan.estimatedSeconds > 22);
});
