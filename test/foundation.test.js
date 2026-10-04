import test from "node:test";
import assert from "node:assert/strict";
import {
  compilePlace,
  PlaceRegistry,
  serializePlaceCore,
  deserializePlaceCore,
  computePlaceCoreStateHash
} from "../src/index.js";

const definition = compilePlace({
  id: "house",
  layers: [{ id: "ground" }, { id: "cellar" }],
  spaces: [
    { id: "room", layerId: "ground", geometry: { type: "aabb", minX: 0, minY: 0, maxX: 10, maxY: 10 } },
    { id: "storage", layerId: "cellar", geometry: { type: "aabb", minX: 0, minY: 0, maxX: 10, maxY: 10 } }
  ],
  boundaries: [{ id: "wall", layerId: "ground", a: { x: 5, y: 0 }, b: { x: 5, y: 10 } }],
  portals: [{
    id: "stairs",
    a: { kind: "local", layerId: "ground", spaceId: "room", position: { x: 2, y: 2 } },
    b: { kind: "local", layerId: "cellar", spaceId: "storage", position: { x: 2, y: 2 } }
  }],
  anchors: [{ id: "bed", layerId: "ground", spaceId: "room", position: { x: 8, y: 5 }, tags: ["sleep"] }],
  footprint: { type: "aabb", minX: 0, minY: 0, maxX: 10, maxY: 10 }
});

test("definitions are shared while instance state stays sparse", () => {
  const places = new PlaceRegistry();
  places.registerDefinition(definition);
  const a = places.createPlace({ id: "a", definitionId: "house" });
  const b = places.createPlace({ id: "b", definitionId: "house" });
  places.setPortalState("a", "stairs", { locked: true });
  assert.equal(places.definitions.size, 1);
  assert.equal(a.portalOverrides.size, 1);
  assert.equal(b.portalOverrides.size, 0);
  assert.equal(places.resolvePortal("a", "stairs").traversable, false);
  assert.equal(places.resolvePortal("b", "stairs").traversable, true);
});

test("semantic locate, occupancy and moving exterior footprints work", () => {
  const places = new PlaceRegistry({ captureEvents: true });
  places.registerDefinition(definition);
  places.createPlace({
    id: "home",
    definitionId: "house",
    placement: { domainId: "city", transform: { x: 100, y: 100 }, containment: "footprint" }
  });
  assert.deepEqual(places.locate("city", { x: 105, y: 105 }).places, ["home"]);
  places.updateEntityOccupancy({ id: "hans", domainId: "home:ground", position: { x: 5, y: 5 } });
  assert.equal(places.entitiesInSpace("home", "room").has("hans"), true);
  assert.ok(places.drainEvents().some((event) => event.type === "space-enter"));
});

test("snapshot roundtrip keeps canonical state hash", () => {
  const places = new PlaceRegistry();
  places.registerDefinition(definition);
  places.createPlace({ id: "home", definitionId: "house" });
  places.setBoundaryState("home", "wall", { enabled: false });
  places.addPortal("home", {
    id: "breach",
    a: { domainId: "home:ground", position: { x: 9, y: 5 } },
    b: { domainId: "outside", position: { x: 0, y: 0 } }
  });
  const before = computePlaceCoreStateHash(places);
  const restored = deserializePlaceCore(
    serializePlaceCore(places)
  );
  assert.equal(computePlaceCoreStateHash(restored), before);
  restored.assertInternalConsistency();
});

test("10k instances retain one definition", () => {
  const places = new PlaceRegistry();
  places.registerDefinition(definition);
  for (let i = 0; i < 10_000; i += 1) places.createPlace({ id: `house-${i}`, definitionId: "house" });
  assert.equal(places.definitions.size, 1);
  assert.equal(places.instances.size, 10_000);
  assert.equal(places.getDiagnostics().portalOverrideCount, 0);
  places.assertInternalConsistency();
});


test("exterior locate order is deterministic across insertion order", () => {
  const make = (order) => {
    const places = new PlaceRegistry();
    places.registerDefinition(definition);

    for (const id of order) {
      places.createPlace({
        id,
        definitionId: "house",
        placement: {
          domainId: "city",
          transform: {
            x: 100,
            y: 100
          },
          containment: "footprint"
        }
      });
    }

    return places.locate(
      "city",
      { x: 105, y: 105 }
    ).places;
  };

  assert.deepEqual(
    make(["a", "b"]),
    make(["b", "a"])
  );
});


test("findAnchors is deterministic across place insertion order", () => {
  const make = (order) => {
    const places = new PlaceRegistry();
    places.registerDefinition(definition);

    for (const id of order) {
      places.createPlace({
        id,
        definitionId: "house"
      });
    }

    return places.findAnchors()
      .map((anchor) =>
        `${String(anchor.placeId)}:${anchor.id}`
      );
  };

  assert.deepEqual(
    make(["a", "b"]),
    make(["b", "a"])
  );
});

test("resolvedPortals is deterministic across dynamic portal insertion order", () => {
  const make = (order) => {
    const places = new PlaceRegistry();
    places.registerDefinition(definition);
    places.createPlace({
      id: "home",
      definitionId: "house"
    });

    for (const id of order) {
      places.addPortal("home", {
        id,
        a: {
          domainId: "outside",
          position: { x: 0, y: 0 }
        },
        b: {
          domainId: "outside",
          position: { x: 1, y: 0 }
        }
      });
    }

    return [...places.resolvedPortals("home")]
      .map((portal) => portal.id);
  };

  assert.deepEqual(
    make(["a", "b"]),
    make(["b", "a"])
  );
});
