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


test("instance-local nearest anchor ignores disabled semantic spaces", () => {
  const places = new PlaceRegistry();
  places.registerDefinition(definition());
  places.createPlace({
    id: "shop",
    definitionId: "query-place",
    attachments: {
      street: { domainId: "street", position: { x: 100, y: 50 } }
    }
  });

  assert.equal(
    places.findNearestAnchor("shop", { x: 8.5, y: 8.5 }).id,
    "closet-anchor"
  );

  places.setSpaceState("shop", "closet", { enabled: false });

  assert.equal(
    places.findNearestAnchor("shop", { x: 8.5, y: 8.5 }).id,
    "counter"
  );
  assert.equal(
    places.findNearestAnchor("shop", { x: 0, y: 0 }, { kind: "storage" }),
    null
  );
});


test("overlapping spaces choose deepest then highest-priority then smallest-ID", () => {
  const places = new PlaceRegistry();
  places.registerDefinition({
    id: "overlap-place",
    layers: [{ id: "ground" }],
    spaces: [
      {
        id: "outer",
        layerId: "ground",
        geometry: { type: "aabb", minX: 0, minY: 0, maxX: 10, maxY: 10 }
      },
      {
        id: "z-low",
        layerId: "ground",
        parentSpaceId: "outer",
        priority: 1,
        geometry: { type: "aabb", minX: 2, minY: 2, maxX: 8, maxY: 8 }
      },
      {
        id: "z-high",
        layerId: "ground",
        parentSpaceId: "outer",
        priority: 10,
        geometry: { type: "aabb", minX: 2, minY: 2, maxX: 8, maxY: 8 }
      },
      {
        id: "a-high",
        layerId: "ground",
        parentSpaceId: "outer",
        priority: 10,
        geometry: { type: "aabb", minX: 2, minY: 2, maxX: 8, maxY: 8 }
      }
    ]
  });

  const place = places.createPlace({
    id: "p",
    definitionId: "overlap-place"
  });
  const domain = place.layerDomains.get("ground");
  const definition = places.getDefinition("overlap-place");

  assert.deepEqual(
    definition.locateSpaces("ground", { x: 5, y: 5 }).map((space) => space.id),
    ["outer", "z-low", "z-high", "a-high"]
  );
  assert.equal(
    definition.primarySpaceAt("ground", { x: 5, y: 5 }).id,
    "a-high"
  );

  let located = places.locate(domain, { x: 5, y: 5 });
  assert.equal(located.deepestSpace.id, "a-high");

  places.setSpaceState("p", "a-high", { enabled: false });
  located = places.locate(domain, { x: 5, y: 5 });
  assert.equal(located.deepestSpace.id, "z-high");

  places.setSpaceState("p", "z-high", { enabled: false });
  located = places.locate(domain, { x: 5, y: 5 });
  assert.equal(located.deepestSpace.id, "z-low");
});


test("findAnchors can explicitly filter by effective nested-space availability", () => {
  const places = new PlaceRegistry();
  places.registerDefinition({
    id: "anchor-availability-place",
    layers: [{ id: "inside" }],
    spaces: [
      {
        id: "parent",
        layerId: "inside",
        geometry: {
          type: "aabb",
          minX: 0,
          minY: 0,
          maxX: 10,
          maxY: 10
        }
      },
      {
        id: "child",
        layerId: "inside",
        parentSpaceId: "parent",
        geometry: {
          type: "aabb",
          minX: 2,
          minY: 2,
          maxX: 8,
          maxY: 8
        }
      }
    ],
    anchors: [{
      id: "bed",
      layerId: "inside",
      spaceId: "child",
      tags: ["sleep"],
      position: { x: 5, y: 5 }
    }]
  });
  places.createPlace({
    id: "house",
    definitionId: "anchor-availability-place"
  });

  assert.equal(
    places.findAnchors({ tag: "sleep" }).length,
    1,
    "structural search includes the defined anchor"
  );
  assert.equal(
    places.findAnchors({
      tag: "sleep",
      enabledOnly: true
    }).length,
    1
  );

  places.setSpaceState("house", "parent", {
    enabled: false
  });

  assert.equal(
    places.findAnchors({ tag: "sleep" }).length,
    1,
    "structural search remains definition-oriented"
  );
  assert.equal(
    places.findAnchors({
      tag: "sleep",
      enabledOnly: true
    }).length,
    0,
    "effective parent disablement hides child anchors"
  );

  assert.throws(
    () => places.findAnchors({
      enabledOnly: "true"
    }),
    /enabledOnly must be a boolean/
  );
});


test("public spatial queries reject non-finite coordinates and malformed bounds", () => {
  const places = new PlaceRegistry();
  places.registerDefinition({
    id: "query-validation-place",
    footprint: {
      type: "aabb",
      minX: 0,
      minY: 0,
      maxX: 10,
      maxY: 10
    },
    layers: [{ id: "inside" }],
    spaces: [{
      id: "room",
      layerId: "inside",
      geometry: {
        type: "aabb",
        minX: 0,
        minY: 0,
        maxX: 10,
        maxY: 10
      }
    }],
    boundaries: [{
      id: "wall",
      layerId: "inside",
      a: { x: 0, y: 0 },
      b: { x: 10, y: 0 }
    }],
    anchors: [{
      id: "target",
      layerId: "inside",
      position: { x: 5, y: 5 }
    }]
  });
  const place = places.createPlace({
    id: "house",
    definitionId: "query-validation-place",
    placement: {
      domainId: "street",
      transform: { x: 0, y: 0 },
      containment: "footprint"
    }
  });
  const inside = place.layerDomains.get("inside");

  for (const call of [
    () => places.locate(inside, { x: Number.NaN, y: 0 }),
    () => places.findNearestAnchor("house", {
      x: 0,
      y: Number.POSITIVE_INFINITY
    }),
    () => places.findNearestAnchorInDomain(inside, {
      x: Number.NaN,
      y: 0
    }),
    () => places.findNearestBoundary(inside, {
      x: 0,
      y: Number.NaN
    })
  ]) {
    assert.throws(call, /finite Vec2/);
  }

  for (const call of [
    () => places.placesInBounds("street", {
      minX: Number.NaN,
      minY: 0,
      maxX: 1,
      maxY: 1
    }),
    () => places.boundariesIntersectingBounds(inside, {
      minX: 2,
      minY: 0,
      maxX: 1,
      maxY: 1
    })
  ]) {
    assert.throws(call, /bounds/);
  }
});

test("spatial query options do not silently coerce strings", () => {
  const places = new PlaceRegistry();
  places.registerDefinition({
    id: "query-option-place",
    layers: [{ id: "inside" }],
    boundaries: [{
      id: "wall",
      layerId: "inside",
      a: { x: 0, y: 0 },
      b: { x: 1, y: 0 }
    }]
  });
  const place = places.createPlace({
    id: "house",
    definitionId: "query-option-place"
  });
  const inside = place.layerDomains.get("inside");

  assert.throws(
    () => places.getBoundariesForDomain(inside, {
      enabledOnly: "true"
    }),
    /enabledOnly must be a boolean/
  );

  assert.throws(
    () => places.findNearestPortal(inside, { x: 0, y: 0 }, {
      traversableOnly: "false"
    }),
    /traversableOnly must be a boolean/
  );

  assert.throws(
    () => places.findNearestPortal(inside, { x: 0, y: 0 }, {
      maxDistance: "10"
    }),
    /maxDistance must be a finite number/
  );

  assert.throws(
    () => places.findNearestAnchor("house", { x: 0, y: 0 }, {
      tag: 123
    }),
    /tag must be a non-empty string/
  );
});


test("nearest portal terminates when every indexed endpoint is filtered out", () => {
  const places = new PlaceRegistry();
  places.registerDefinition({
    id: "filtered-portals",
    layers: [{ id: "inside" }],
    portals: [{
      id: "door",
      a: { kind: "external", slot: "outside" },
      b: {
        kind: "local",
        layerId: "inside",
        position: { x: 0, y: 0 }
      }
    }]
  });

  const place = places.createPlace({
    id: "house",
    definitionId: "filtered-portals",
    attachments: {
      outside: {
        domainId: "street",
        position: { x: 100, y: 0 }
      }
    }
  });

  const inside = place.layerDomains.get("inside");
  places.setPortalState("house", "door", { locked: true });

  assert.equal(
    places.findNearestPortal(inside, { x: 0, y: 0 }),
    null
  );
  assert.equal(
    places.findNearestPortal("street", { x: 0, y: 0 }),
    null
  );

  assert.equal(
    places.findNearestPortal(
      "street",
      { x: 0, y: 0 },
      { traversableOnly: false }
    )?.portal.id,
    "door"
  );
});

test("nearest portal runtime is independent of empty coordinate distance", () => {
  const places = new PlaceRegistry();
  places.registerDefinition({
    id: "far-portal",
    layers: [{ id: "inside" }],
    portals: [{
      id: "door",
      a: { kind: "external", slot: "outside" },
      b: {
        kind: "local",
        layerId: "inside",
        position: { x: 0, y: 0 }
      }
    }]
  });

  places.createPlace({
    id: "house",
    definitionId: "far-portal",
    attachments: {
      outside: {
        domainId: "street",
        position: {
          x: 1_000_000_000_000,
          y: -1_000_000_000_000
        }
      }
    }
  });

  const nearest = places.findNearestPortal(
    "street",
    { x: 0, y: 0 }
  );

  assert.ok(nearest);
  assert.equal(nearest.portal.id, "door");
  assert.deepEqual(nearest.endpoint.position, {
    x: 1_000_000_000_000,
    y: -1_000_000_000_000
  });
});

test("huge portal radius query visits sparse occupied cells rather than empty area", () => {
  const places = new PlaceRegistry();
  places.registerDefinition({
    id: "radius-portals",
    layers: [{ id: "inside" }],
    portals: [{
      id: "door",
      a: { kind: "external", slot: "outside" },
      b: {
        kind: "local",
        layerId: "inside",
        position: { x: 0, y: 0 }
      }
    }]
  });

  places.createPlace({
    id: "near",
    definitionId: "radius-portals",
    attachments: {
      outside: {
        domainId: "street",
        position: { x: 10, y: 0 }
      }
    }
  });
  places.createPlace({
    id: "far",
    definitionId: "radius-portals",
    attachments: {
      outside: {
        domainId: "street",
        position: { x: 1_000_000_000_000, y: 0 }
      }
    }
  });

  assert.deepEqual(
    places.findPortalEndpointsNear(
      "street",
      { x: 0, y: 0 },
      1_000_000_000_001
    ).map((hit) => hit.portal.instanceId),
    ["near", "far"]
  );
});
