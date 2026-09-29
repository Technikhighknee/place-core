import test from "node:test";
import assert from "node:assert/strict";

import { PlaceRegistry } from "../src/index.js";

function roomDefinition() {
  return {
    id: "room-box",
    footprint: { type: "aabb", minX: 0, minY: 0, maxX: 10, maxY: 10 },
    layers: [{ id: "ground" }],
    spaces: [
      {
        id: "whole",
        layerId: "ground",
        geometry: { type: "aabb", minX: 0, minY: 0, maxX: 10, maxY: 10 }
      },
      {
        id: "inner",
        layerId: "ground",
        parentSpaceId: "whole",
        geometry: { type: "aabb", minX: 2, minY: 2, maxX: 8, maxY: 8 }
      }
    ],
    boundaries: [{
      id: "north-wall",
      layerId: "ground",
      a: { x: 0, y: 10 },
      b: { x: 10, y: 10 }
    }]
  };
}

test("place hierarchy rejects cycles", () => {
  const places = new PlaceRegistry();
  places.registerDefinition(roomDefinition());
  places.createPlace({ id: "a", definitionId: "room-box" });
  places.createPlace({ id: "b", definitionId: "room-box", parentId: "a" });
  places.createPlace({ id: "c", definitionId: "room-box", parentId: "b" });

  assert.throws(() => places.setParent("a", "c"), /parent cycle/);
  assert.equal(places.getPlace("a").parentId, null);
  places.assertInternalConsistency();
});

test("disabling a parent space removes all descendant membership", () => {
  const places = new PlaceRegistry();
  places.registerDefinition(roomDefinition());
  const place = places.createPlace({ id: "box", definitionId: "room-box" });
  const domain = place.layerDomains.get("ground");

  assert.deepEqual(
    places.locate(domain, { x: 5, y: 5 }).spaces.map((space) => space.id),
    ["whole", "inner"]
  );

  places.setSpaceState("box", "whole", { enabled: false });
  assert.deepEqual(places.locate(domain, { x: 5, y: 5 }).spaces, []);

  places.setSpaceState("box", "whole", { enabled: true });
  assert.deepEqual(
    places.locate(domain, { x: 5, y: 5 }).spaces.map((space) => space.id),
    ["whole", "inner"]
  );
});

test("moving a footprint atomically updates exterior lookup", () => {
  const places = new PlaceRegistry();
  places.registerDefinition(roomDefinition());
  places.createPlace({
    id: "cart-house",
    definitionId: "room-box",
    placement: {
      domainId: "street",
      transform: { x: 10, y: 10 },
      containment: "footprint"
    }
  });

  assert.deepEqual(places.placesAt("street", { x: 15, y: 15 }).map((p) => p.id), ["cart-house"]);

  places.setPlacement("cart-house", {
    domainId: "street",
    transform: { x: 100, y: 20, rotation: Math.PI / 2 },
    containment: "footprint"
  });

  assert.deepEqual(places.placesAt("street", { x: 15, y: 15 }), []);
  assert.deepEqual(places.placesAt("street", { x: 95, y: 25 }).map((p) => p.id), ["cart-house"]);
});

test("dynamic breach is indexed in both connected domains and removed cleanly", () => {
  const places = new PlaceRegistry();
  places.registerDefinition(roomDefinition());
  const place = places.createPlace({ id: "box", definitionId: "room-box" });
  const inside = place.layerDomains.get("ground");

  const breach = places.addPortal("box", {
    id: "breach",
    kind: "breach",
    a: { domainId: inside, position: { x: 10, y: 5 } },
    b: { domainId: "street", position: { x: 20, y: 5 } }
  });

  assert.ok(places.getPortalsForDomain(inside).some((portal) => portal.id === "breach"));
  assert.ok(places.getPortalsForDomain("street").some((portal) => portal.id === "breach"));
  assert.equal(breach.traversable, true);

  places.removePortal("box", "breach");
  assert.equal(places.getPortalsForDomain(inside).some((portal) => portal.id === "breach"), false);
  assert.equal(places.getPortalsForDomain("street").some((portal) => portal.id === "breach"), false);
  places.assertInternalConsistency();
});

test("boundary and sparse state return to zero overrides at base state", () => {
  const places = new PlaceRegistry();
  places.registerDefinition(roomDefinition());
  const place = places.createPlace({ id: "box", definitionId: "room-box" });

  places.setBoundaryState("box", "north-wall", { enabled: false });
  assert.equal(place.boundaryOverrides.size, 1);
  places.setBoundaryState("box", "north-wall", { enabled: true });
  assert.equal(place.boundaryOverrides.size, 0);

  places.setSpaceState("box", "inner", { enabled: false });
  assert.equal(place.spaceOverrides.size, 1);
  places.setSpaceState("box", "inner", { enabled: true });
  assert.equal(place.spaceOverrides.size, 0);
});


test("numeric and string place IDs do not collide in portal or occupancy indexes", () => {
  const places = new PlaceRegistry();
  places.registerDefinition({
    id: "id-place",
    layers: [{ id: "a" }, { id: "b" }],
    spaces: [{
      id: "room",
      layerId: "a",
      geometry: { type: "aabb", minX: 0, minY: 0, maxX: 2, maxY: 2 }
    }],
    portals: [{
      id: "door",
      a: { kind: "local", layerId: "a", position: { x: 0, y: 0 } },
      b: { kind: "local", layerId: "b", position: { x: 0, y: 0 } }
    }]
  });

  places.createPlace({
    id: 1,
    definitionId: "id-place",
    layerDomains: { a: "number-a", b: "number-b" }
  });
  places.createPlace({
    id: "1",
    definitionId: "id-place",
    layerDomains: { a: "string-a", b: "string-b" }
  });

  assert.equal(places.getPortalsForDomain("number-a").length, 1);
  assert.equal(places.getPortalsForDomain("string-a").length, 1);

  places.updateEntityOccupancy({ id: "n", domainId: "number-a", position: { x: 1, y: 1 } });
  places.updateEntityOccupancy({ id: "s", domainId: "string-a", position: { x: 1, y: 1 } });
  assert.deepEqual([...places.entitiesInSpace(1, "room")], ["n"]);
  assert.deepEqual([...places.entitiesInSpace("1", "room")], ["s"]);
});

test("occupied places cannot be removed implicitly", () => {
  const places = new PlaceRegistry();
  places.registerDefinition(roomDefinition());
  const place = places.createPlace({ id: "occupied", definitionId: "room-box" });
  places.updateEntityOccupancy({
    id: "hans",
    domainId: place.layerDomains.get("ground"),
    position: { x: 5, y: 5 }
  });

  assert.throws(() => places.removePlace("occupied"), /cannot remove occupied place/);
  assert.ok(places.getPlace("occupied"));

  places.removeEntityOccupancy("hans");
  assert.equal(places.removePlace("occupied"), true);
});

test("placement rejects unknown containment modes", () => {
  const places = new PlaceRegistry();
  places.registerDefinition(roomDefinition());
  assert.throws(() => places.createPlace({
    id: "bad",
    definitionId: "room-box",
    placement: {
      domainId: "street",
      transform: { x: 0, y: 0 },
      containment: "magic"
    }
  }), /placement\.containment/);
});
