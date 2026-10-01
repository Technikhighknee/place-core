import test from "node:test";
import assert from "node:assert/strict";

import { PlaceRegistry } from "../src/index.js";

function definition() {
  return {
    id: "reactive-place",
    footprint: { type: "aabb", minX: 0, minY: 0, maxX: 10, maxY: 10 },
    layers: [{ id: "ground" }],
    spaces: [{
      id: "room",
      layerId: "ground",
      geometry: { type: "aabb", minX: 0, minY: 0, maxX: 10, maxY: 10 }
    }]
  };
}

test("space state changes immediately refresh tracked occupants", () => {
  const places = new PlaceRegistry({ captureEvents: true });
  places.registerDefinition(definition());
  const place = places.createPlace({ id: "house", definitionId: "reactive-place" });
  const domain = place.layerDomains.get("ground");

  places.updateEntityOccupancy({
    id: "hans",
    domainId: domain,
    position: { x: 5, y: 5 }
  });
  places.drainEvents();

  assert.equal(places.entitiesInSpace("house", "room").has("hans"), true);

  places.setSpaceState("house", "room", { enabled: false });

  assert.equal(places.entitiesInSpace("house", "room").has("hans"), false);
  assert.equal(places.getEntityLocation("hans").spaces.length, 0);
  assert.ok(places.drainEvents().some((event) =>
    event.type === "space-leave" &&
    event.entityId === "hans" &&
    event.spaceId === "room"
  ));

  places.setSpaceState("house", "room", { enabled: true });
  assert.equal(places.entitiesInSpace("house", "room").has("hans"), true);
});

test("semantic reparenting immediately updates ancestor occupancy", () => {
  const places = new PlaceRegistry({ captureEvents: true });
  places.registerDefinition(definition());
  places.createPlace({ id: "district-a", definitionId: "reactive-place" });
  places.createPlace({ id: "district-b", definitionId: "reactive-place" });
  const shop = places.createPlace({
    id: "shop",
    definitionId: "reactive-place",
    parentId: "district-a"
  });

  places.updateEntityOccupancy({
    id: "hans",
    domainId: shop.layerDomains.get("ground"),
    position: { x: 5, y: 5 }
  });
  places.drainEvents();

  assert.equal(places.entitiesInPlace("district-a").has("hans"), true);
  assert.equal(places.entitiesInPlace("district-b").has("hans"), false);

  places.setParent("shop", "district-b");

  assert.equal(places.entitiesInPlace("district-a").has("hans"), false);
  assert.equal(places.entitiesInPlace("district-b").has("hans"), true);
  assert.deepEqual(
    places.getEntityLocation("hans").places,
    ["district-b", "shop"]
  );

  const events = places.drainEvents();
  assert.ok(events.some((event) =>
    event.type === "place-leave" &&
    event.placeId === "district-a"
  ));
  assert.ok(events.some((event) =>
    event.type === "place-enter" &&
    event.placeId === "district-b"
  ));
});

test("moving exterior footprints refresh stationary tracked entities", () => {
  const places = new PlaceRegistry({ captureEvents: true });
  places.registerDefinition(definition());
  places.createPlace({
    id: "wagon",
    definitionId: "reactive-place",
    placement: {
      domainId: "street",
      transform: { x: 100, y: 0 },
      containment: "footprint"
    }
  });

  places.updateEntityOccupancy({
    id: "hans",
    domainId: "street",
    position: { x: 5, y: 5 }
  });
  places.drainEvents();
  assert.equal(places.entitiesInPlace("wagon").has("hans"), false);

  places.setPlacement("wagon", {
    domainId: "street",
    transform: { x: 0, y: 0 },
    containment: "footprint"
  });

  assert.equal(places.entitiesInPlace("wagon").has("hans"), true);
  assert.ok(places.drainEvents().some((event) =>
    event.type === "place-enter" &&
    event.placeId === "wagon"
  ));

  places.setPlacement("wagon", {
    domainId: "street",
    transform: { x: 100, y: 0 },
    containment: "footprint"
  });

  assert.equal(places.entitiesInPlace("wagon").has("hans"), false);
  assert.ok(places.drainEvents().some((event) =>
    event.type === "place-leave" &&
    event.placeId === "wagon"
  ));
});

test("same-location movement still updates the occupancy spatial point", () => {
  const places = new PlaceRegistry({ captureEvents: true });
  places.registerDefinition(definition());

  const hans = {
    id: "hans",
    domainId: "street",
    position: { x: 0, y: 0 }
  };
  places.updateEntityOccupancy(hans);

  hans.position = { x: 205, y: 5 };
  places.updateEntityOccupancy(hans);
  assert.deepEqual(places.getEntityLocation("hans").position, { x: 205, y: 5 });

  places.createPlace({
    id: "new-house",
    definitionId: "reactive-place",
    placement: {
      domainId: "street",
      transform: { x: 200, y: 0 },
      containment: "footprint"
    }
  });

  assert.equal(places.entitiesInPlace("new-house").has("hans"), true);
});


test("reactive occupancy events are deterministic across entity tracking order", () => {
  const run = (order) => {
    const places = new PlaceRegistry({
      captureEvents: true
    });
    places.registerDefinition(definition());
    const place = places.createPlace({
      id: "house",
      definitionId: "reactive-place"
    });
    const domain =
      place.layerDomains.get("ground");

    for (const id of order) {
      places.updateEntityOccupancy({
        id,
        domainId: domain,
        position: { x: 5, y: 5 }
      });
    }
    places.drainEvents();

    places.setSpaceState(
      "house",
      "room",
      { enabled: false }
    );

    return places.drainEvents()
      .filter((event) =>
        event.type === "space-leave"
      )
      .map((event) => event.entityId);
  };

  assert.deepEqual(
    run(["a", "b"]),
    run(["b", "a"])
  );
});
