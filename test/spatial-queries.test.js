import test from "node:test";
import assert from "node:assert/strict";

import { PlaceRegistry } from "../src/index.js";

function definition() {
  return {
    id: "query-place",
    footprint: { type: "aabb", minX: 0, minY: 0, maxX: 10, maxY: 10 },
    layers: [{ id: "ground" }],
    spaces: [
      {
        id: "room",
        layerId: "ground",
        geometry: { type: "aabb", minX: 0, minY: 0, maxX: 10, maxY: 10 }
      },
      {
        id: "closet",
        layerId: "ground",
        parentSpaceId: "room",
        geometry: { type: "aabb", minX: 7, minY: 7, maxX: 10, maxY: 10 }
      }
    ],
    boundaries: [
      {
        id: "west-wall",
        layerId: "ground",
        kind: "wall",
        tags: ["exterior"],
        a: { x: 0, y: 0 },
        b: { x: 0, y: 10 }
      },
      {
        id: "east-wall",
        layerId: "ground",
        kind: "wall",
        tags: ["exterior"],
        a: { x: 10, y: 0 },
        b: { x: 10, y: 10 }
      }
    ],
    portals: [{
      id: "front-door",
      kind: "door",
      tags: ["exit"],
      a: { kind: "external", slot: "street" },
      b: {
        kind: "local",
        layerId: "ground",
        spaceId: "room",
        position: { x: 1, y: 5 }
      }
    }],
    anchors: [
      {
        id: "counter",
        layerId: "ground",
        spaceId: "room",
        kind: "work",
        tags: ["service"],
        position: { x: 2, y: 5 }
      },
      {
        id: "closet-anchor",
        layerId: "ground",
        spaceId: "closet",
        kind: "storage",
        tags: ["storage"],
        position: { x: 9, y: 9 }
      }
    ]
  };
}

test("domain-local nearest anchor respects disabled spaces and filters", () => {
  const places = new PlaceRegistry();
  places.registerDefinition(definition());
  const place = places.createPlace({
    id: "shop",
    definitionId: "query-place",
    attachments: {
      street: { domainId: "street", position: { x: 100, y: 50 } }
    }
  });
  const domain = place.layerDomains.get("ground");

  const nearest = places.findNearestAnchorInDomain(domain, { x: 8.5, y: 8.5 });
  assert.equal(nearest.id, "closet-anchor");
  assert.ok(nearest.distance < 1);

  places.setSpaceState("shop", "closet", { enabled: false });
  assert.equal(
    places.findNearestAnchorInDomain(domain, { x: 8.5, y: 8.5 }).id,
    "counter"
  );

  assert.equal(
    places.findNearestAnchorInDomain(domain, { x: 0, y: 0 }, { tag: "service" }).id,
    "counter"
  );
  assert.equal(
    places.findNearestAnchorInDomain(domain, { x: 0, y: 0 }, { kind: "storage" }),
    null
  );
});

test("nearest portal uses domain endpoint and traversal state", () => {
  const places = new PlaceRegistry();
  places.registerDefinition(definition());
  const place = places.createPlace({
    id: "shop",
    definitionId: "query-place",
    attachments: {
      street: { domainId: "street", position: { x: 100, y: 50 } }
    }
  });
  const domain = place.layerDomains.get("ground");

  const inside = places.findNearestPortal(domain, { x: 0, y: 5 });
  assert.equal(inside.portal.id, "front-door");
  assert.deepEqual(inside.endpoint.position, { x: 1, y: 5 });

  const outside = places.findNearestPortal("street", { x: 99, y: 50 });
  assert.equal(outside.portal.id, "front-door");
  assert.deepEqual(outside.endpoint.position, { x: 100, y: 50 });

  places.setPortalState("shop", "front-door", { locked: true });
  assert.equal(places.findNearestPortal(domain, { x: 0, y: 5 }), null);
  assert.equal(
    places.findNearestPortal(domain, { x: 0, y: 5 }, { traversableOnly: false }).portal.id,
    "front-door"
  );
});

test("boundary area and nearest-boundary queries stay layer-local", () => {
  const places = new PlaceRegistry();
  places.registerDefinition(definition());
  const place = places.createPlace({
    id: "shop",
    definitionId: "query-place",
    attachments: {
      street: { domainId: "street", position: { x: 100, y: 50 } }
    }
  });
  const domain = place.layerDomains.get("ground");

  assert.deepEqual(
    places.boundariesIntersectingBounds(domain, {
      minX: -1, minY: 4, maxX: 1, maxY: 6
    }).map((boundary) => boundary.id),
    ["west-wall"]
  );

  const nearest = places.findNearestBoundary(domain, { x: 9, y: 5 });
  assert.equal(nearest.boundary.id, "east-wall");
  assert.equal(nearest.distance, 1);

  places.setBoundaryState("shop", "east-wall", { enabled: false });
  assert.equal(
    places.findNearestBoundary(domain, { x: 9, y: 5 }, { enabledOnly: true }).boundary.id,
    "west-wall"
  );
});

test("placed-place area query uses the exterior spatial index", () => {
  const places = new PlaceRegistry();
  places.registerDefinition(definition());

  for (let i = 0; i < 100; i += 1) {
    places.createPlace({
      id: `shop-${i}`,
      definitionId: "query-place",
      attachments: {
        street: { domainId: "street", position: { x: i * 20, y: 0 } }
      },
      placement: {
        domainId: "street",
        transform: { x: i * 20, y: 0 },
        containment: "footprint"
      }
    });
  }

  assert.deepEqual(
    places.placesInBounds("street", {
      minX: 195, minY: -1, maxX: 231, maxY: 11
    }).map((place) => place.id),
    ["shop-10", "shop-11"]
  );
});
