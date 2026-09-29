import test from "node:test";
import assert from "node:assert/strict";

import { PlaceRegistry } from "../src/index.js";

function definition() {
  return {
    id: "road-index-place",
    layers: [{
      id: "inside",
      navigation: {
        nodes: [
          { id: "left", x: 0, y: 0 },
          { id: "right", x: 1, y: 0 }
        ],
        roads: [{
          id: "threshold",
          from: "left",
          to: "right",
          width: 1
        }]
      }
    }],
    portals: [{
      id: "room-door",
      a: {
        kind: "local",
        layerId: "inside",
        position: { x: 0, y: 0 },
        nodeId: "left"
      },
      b: {
        kind: "local",
        layerId: "inside",
        position: { x: 1, y: 0 },
        nodeId: "right"
      },
      roadBindings: [{
        layerId: "inside",
        roadId: "threshold"
      }]
    }]
  };
}

test("portal road bindings are indexed by concrete domain", () => {
  const places = new PlaceRegistry();
  places.registerDefinition(definition());

  const a = places.createPlace({
    id: "a",
    definitionId: "road-index-place"
  });
  const b = places.createPlace({
    id: "b",
    definitionId: "road-index-place"
  });

  const aDomain = a.layerDomains.get("inside");
  const bDomain = b.layerDomains.get("inside");

  assert.deepEqual(
    places.getPortalsForRoad(aDomain, "threshold").map((p) => p.instanceId),
    ["a"]
  );
  assert.deepEqual(
    places.getPortalsForRoad(bDomain, "threshold").map((p) => p.instanceId),
    ["b"]
  );

  const diagnostics = places.getDiagnostics();
  assert.equal(diagnostics.portalRoadBindingCount, 2);
  assert.equal(diagnostics.portalRoadDomainCount, 2);
  places.assertInternalConsistency();
});

test("portal road index follows dynamic state reindex and removal", () => {
  const places = new PlaceRegistry();
  places.registerDefinition(definition());

  const place = places.createPlace({
    id: "house",
    definitionId: "road-index-place"
  });
  const domain = place.layerDomains.get("inside");

  assert.equal(places.getPortalsForRoad(domain, "threshold").length, 1);

  places.setPortalState("house", "room-door", { locked: true });
  assert.equal(places.getPortalsForRoad(domain, "threshold").length, 1);
  assert.equal(
    places.getPortalsForRoad(domain, "threshold")[0].traversable,
    false
  );

  places.removePlace("house");
  assert.deepEqual(places.getPortalsForRoad(domain, "threshold"), []);
  assert.equal(places.getDiagnostics().portalRoadBindingCount, 0);
  assert.equal(places.getDiagnostics().portalRoadDomainCount, 0);
  places.assertInternalConsistency();
});
