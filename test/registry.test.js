import test from "node:test";
import assert from "node:assert/strict";

import {
  PlaceRegistry,
  serializePlaceCore,
  deserializePlaceCore,
  computePlaceCoreStateHash
} from "../src/index.js";
import { tavernBlueprint } from "./fixtures.js";

function buildRegistry() {
  const registry = new PlaceRegistry({ captureEvents: true });
  registry.registerDefinition(tavernBlueprint());
  registry.createPlace({
    id: "golden-goose",
    definitionId: "tavern",
    placement: {
      domainId: "street",
      transform: { x: 100, y: 20, rotation: 0 },
      containment: "footprint"
    },
    attachments: {
      street: {
        domainId: "street",
        position: { x: 100, y: 20 },
        nodeId: "street-goose"
      }
    }
  });
  return registry;
}

test("place instances share definitions while keeping sparse state", () => {
  const registry = buildRegistry();
  registry.createPlace({
    id: "silver-goose",
    definitionId: "tavern",
    attachments: {
      street: {
        domainId: "street",
        position: { x: 200, y: 20 },
        nodeId: "street-silver"
      }
    }
  });

  const a = registry.getPlace("golden-goose");
  const b = registry.getPlace("silver-goose");
  assert.equal(a.definitionId, b.definitionId);
  assert.equal(registry.definitions.size, 1);
  assert.equal(a.portalOverrides.size, 0);
  assert.equal(b.portalOverrides.size, 0);

  registry.setPortalState("golden-goose", "front-door", { locked: true });
  assert.equal(a.portalOverrides.size, 1);
  assert.equal(b.portalOverrides.size, 0);
  assert.equal(registry.resolvePortal("golden-goose", "front-door").locked, true);
  assert.equal(registry.resolvePortal("silver-goose", "front-door").locked, false);
});

test("locate resolves semantic containment and occupancy events", () => {
  const registry = buildRegistry();
  const place = registry.getPlace("golden-goose");
  const ground = place.layerDomains.get("ground");

  const context = registry.locate(ground, { x: 5, y: 0 });
  assert.equal(context.placeId, "golden-goose");
  assert.deepEqual(context.spaces.map((space) => space.id), ["ground-floor", "taproom"]);
  assert.equal(context.deepestSpace.id, "taproom");

  const hans = { id: "hans", domainId: ground, position: { x: 5, y: 0 } };
  registry.updateEntityOccupancy(hans);
  assert.equal(registry.entitiesInPlace("golden-goose").has("hans"), true);
  assert.equal(registry.entitiesInSpace("golden-goose", "taproom").has("hans"), true);

  hans.domainId = "street";
  hans.position = { x: 0, y: 0 };
  registry.updateEntityOccupancy(hans);
  assert.equal(registry.entitiesInPlace("golden-goose").has("hans"), false);

  const eventTypes = registry.drainEvents().map((event) => event.type);
  assert.ok(eventTypes.includes("place-enter"));
  assert.ok(eventTypes.includes("space-enter"));
  assert.ok(eventTypes.includes("place-leave"));
  assert.ok(eventTypes.includes("space-leave"));
});

test("footprint index tracks placed buildings", () => {
  const registry = buildRegistry();
  assert.deepEqual(
    registry.placesAt("street", { x: 105, y: 22 }).map((place) => place.id),
    ["golden-goose"]
  );
  assert.deepEqual(registry.placesAt("street", { x: 20, y: 20 }), []);
});

test("dynamic structural portals participate in instance state", () => {
  const registry = buildRegistry();
  const place = registry.getPlace("golden-goose");
  registry.addPortal("golden-goose", {
    id: "breach-1",
    kind: "breach",
    a: {
      domainId: place.layerDomains.get("ground"),
      position: { x: 4, y: 1 },
      nodeId: "g-bar"
    },
    b: {
      domainId: "street",
      position: { x: 104, y: 21 },
      nodeId: "street-goose"
    },
    transitionCost: 0
  });

  assert.equal(registry.resolvePortal("golden-goose", "breach-1").kind, "breach");
  assert.equal(place.dynamicPortals.size, 1);
  registry.removePortal("golden-goose", "breach-1");
  assert.equal(place.dynamicPortals.size, 0);
});

test("snapshot roundtrip retains canonical state", () => {
  const registry = buildRegistry();
  registry.setPortalState("golden-goose", "front-door", { locked: true });
  registry.setBoundaryState("golden-goose", "taproom-wall", { enabled: false });

  const before = computePlaceCoreStateHash(registry);
  const snapshot = serializePlaceCore(registry);
  const restored = deserializePlaceCore(JSON.parse(JSON.stringify(snapshot)));
  const after = computePlaceCoreStateHash(restored);

  assert.equal(after, before);
  assert.equal(restored.resolvePortal("golden-goose", "front-door").locked, true);
  assert.equal(restored.resolveBoundary("golden-goose", "taproom-wall").enabled, false);
  restored.assertInternalConsistency();
});


test("registry rejects unknown options", () => {
  assert.throws(
    () => new PlaceRegistry({ mysteryOption: true }),
    /PlaceRegistry options contains unknown field mysteryOption/
  );
});

test("createPlace rejects unknown fields", () => {
  const registry = new PlaceRegistry();
  registry.registerDefinition(tavernBlueprint());

  assert.throws(
    () => registry.createPlace({
      id: "invalid-place",
      definitionId: "tavern",
      mysteryField: true
    }),
    /place input contains unknown field mysteryField/
  );

  assert.equal(registry.instances.size, 0);
});
