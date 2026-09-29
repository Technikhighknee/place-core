import test from "node:test";
import assert from "node:assert/strict";

import { PlaceRegistry } from "../src/index.js";

function doorwayDefinition() {
  return {
    id: "doorway-place",
    layers: [{ id: "inside" }],
    portals: [{
      id: "door",
      kind: "door",
      tags: ["entry"],
      a: { kind: "external", slot: "street" },
      b: {
        kind: "local",
        layerId: "inside",
        position: { x: 0, y: 0 },
        nodeId: "inside-door"
      }
    }]
  };
}

test("nearest portal query uses spatially indexed external endpoints", () => {
  const places = new PlaceRegistry();
  places.registerDefinition(doorwayDefinition());

  for (let i = 0; i < 5_000; i += 1) {
    places.createPlace({
      id: `house-${i}`,
      definitionId: "doorway-place",
      attachments: {
        street: {
          domainId: "city",
          position: { x: i * 10, y: 0 },
          nodeId: `city-door-${i}`
        }
      }
    });
  }

  const nearest = places.findNearestPortal(
    "city",
    { x: 12_347, y: 0 }
  );

  assert.ok(nearest);
  assert.equal(nearest.portal.instanceId, "house-1235");
  assert.equal(nearest.endpoint.nodeId, "city-door-1235");
  assert.equal(nearest.side, "a");
  assert.equal(nearest.distance, 3);

  const diagnostics = places.getDiagnostics();
  assert.equal(diagnostics.portalRecordCount, 5_000);
  assert.equal(diagnostics.portalEndpointCount, 10_000);
  assert.equal(diagnostics.portalEndpointDomainCount, 5_001);
  places.assertInternalConsistency();
});

test("portal endpoint radius query is circular and deterministic", () => {
  const places = new PlaceRegistry();
  places.registerDefinition(doorwayDefinition());

  for (const [id, x, y] of [
    ["a", 3, 4],
    ["b", 4, 4],
    ["c", -3, -4]
  ]) {
    places.createPlace({
      id,
      definitionId: "doorway-place",
      attachments: {
        street: {
          domainId: "city",
          position: { x, y },
          nodeId: `${id}-door`
        }
      }
    });
  }

  const hits = places.findPortalEndpointsNear(
    "city",
    { x: 0, y: 0 },
    5
  );

  assert.deepEqual(
    hits.map((hit) => hit.portal.instanceId),
    ["a", "c"]
  );
  assert.deepEqual(
    hits.map((hit) => hit.distance),
    [5, 5]
  );
});

test("attachment movement and disconnect reindex portal endpoints atomically", () => {
  const places = new PlaceRegistry();
  places.registerDefinition(doorwayDefinition());
  places.createPlace({
    id: "wagon",
    definitionId: "doorway-place",
    attachments: {
      street: {
        domainId: "road",
        position: { x: 10, y: 0 },
        nodeId: "old-stop"
      }
    }
  });

  assert.equal(
    places.findNearestPortal("road", { x: 10, y: 0 })?.endpoint.nodeId,
    "old-stop"
  );

  places.setAttachment("wagon", "street", {
    domainId: "road",
    position: { x: 200, y: 0 },
    nodeId: "new-stop"
  });

  assert.equal(
    places.findNearestPortal("road", { x: 10, y: 0 }, { maxDistance: 20 }),
    null
  );
  assert.equal(
    places.findNearestPortal("road", { x: 200, y: 0 })?.endpoint.nodeId,
    "new-stop"
  );

  places.clearAttachment("wagon", "street");

  assert.equal(
    places.findNearestPortal("road", { x: 200, y: 0 }),
    null
  );
  places.assertInternalConsistency();
});

test("nearest portal filters traversal state and supports same-domain endpoints", () => {
  const places = new PlaceRegistry();
  places.registerDefinition({
    id: "same-domain",
    layers: [{ id: "inside" }],
    portals: [{
      id: "passage",
      kind: "door",
      tags: ["secret"],
      a: {
        kind: "local",
        layerId: "inside",
        position: { x: 0, y: 0 }
      },
      b: {
        kind: "local",
        layerId: "inside",
        position: { x: 100, y: 0 }
      }
    }]
  });
  const place = places.createPlace({
    id: "hall",
    definitionId: "same-domain"
  });
  const domain = place.layerDomains.get("inside");

  let nearest = places.findNearestPortal(domain, { x: 90, y: 0 });
  assert.ok(nearest);
  assert.equal(nearest.side, "b");
  assert.equal(nearest.distance, 10);

  places.setPortalState("hall", "passage", { locked: true });

  assert.equal(
    places.findNearestPortal(domain, { x: 90, y: 0 }),
    null
  );

  nearest = places.findNearestPortal(
    domain,
    { x: 90, y: 0 },
    {
      traversableOnly: false,
      kind: "door",
      tag: "secret"
    }
  );
  assert.ok(nearest);
  assert.equal(nearest.side, "b");
});
