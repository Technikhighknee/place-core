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


test("layer IDs that shadow Object.prototype still receive default domains", () => {
  const registry = new PlaceRegistry();
  registry.registerDefinition({
    id: "prototype-layer-place",
    layers: [{ spatialMode: "owned", id: "constructor" }]
  });

  const place = registry.createPlace({
    id: "house",
    definitionId: "prototype-layer-place"
  });

  assert.equal(
    place.layerDomains.get("constructor"),
    "house:constructor"
  );
});

test("default domain IDs support lone surrogate place and layer IDs without collisions", () => {
  const registry =
    new PlaceRegistry();

  registry.registerDefinition({
    id: "surrogate-place-id",
    layers: [{ spatialMode: "owned", id: "inside" }]
  });

  const lonePlace =
    registry.createPlace({
      id: "\uD800",
      definitionId:
        "surrogate-place-id"
    });
  const literalPlace =
    registry.createPlace({
      id: "%uD800",
      definitionId:
        "surrogate-place-id"
    });

  assert.equal(
    lonePlace.layerDomains.get("inside"),
    "%uD800:inside"
  );
  assert.equal(
    literalPlace.layerDomains.get("inside"),
    "%25uD800:inside"
  );
  assert.notEqual(
    lonePlace.layerDomains.get("inside"),
    literalPlace.layerDomains.get("inside")
  );

  registry.registerDefinition({
    id: "surrogate-layer-id",
    layers: [{ spatialMode: "owned", id: "\uDCFF" }]
  });
  const loneLayer =
    registry.createPlace({
      id: "house",
      definitionId:
        "surrogate-layer-id"
    });

  assert.equal(
    loneLayer.layerDomains.get("\uDCFF"),
    "house:%uDCFF"
  );

  const restored =
    deserializePlaceCore(
      JSON.parse(
        JSON.stringify(
          serializePlaceCore(registry)
        )
      )
    );

  assert.equal(
    restored
      .getPlace("\uD800")
      .layerDomains
      .get("inside"),
    "%uD800:inside"
  );
  assert.equal(
    restored
      .getPlace("house")
      .layerDomains
      .get("\uDCFF"),
    "house:%uDCFF"
  );
  restored.assertInternalConsistency();
});


test("semantic membership keys cannot collide on embedded separators", () => {
  const registry = new PlaceRegistry();
  registry.registerDefinition({
    id: "semantic-only"
  });

  for (const id of ["a\u0000b", "a", "child"]) {
    registry.createPlace({
      id,
      definitionId: "semantic-only"
    });
  }

  registry.addMembership("child", {
    parentPlaceId: "a\u0000b",
    kind: "c"
  });
  registry.addMembership("child", {
    parentPlaceId: "a",
    kind: "b\u0000c"
  });

  assert.equal(
    registry.getMemberships("child").length,
    2
  );
  registry.assertInternalConsistency();
});


test("numeric zero place IDs remain distinct and survive graph snapshot round-trip", () => {
  const registry = new PlaceRegistry();
  registry.registerDefinition({
    id: "typed-zero-place",
    layers: [{ spatialMode: "owned", id: "inside" }]
  });

  registry.createPlace({
    id: "root",
    definitionId: "typed-zero-place"
  });
  registry.createPlace({
    id: 0,
    definitionId: "typed-zero-place",
    parentId: "root"
  });
  registry.createPlace({
    id: "0",
    definitionId: "typed-zero-place",
    parentId: 0
  });
  registry.createPlace({
    id: 1,
    definitionId: "typed-zero-place",
    memberships: [{
      parentPlaceId: "0"
    }],
    placement: {
      parentPlaceId: 0,
      transform: {
        x: 1,
        y: 2
      }
    }
  });

  assert.notEqual(
    registry.getPlace(0),
    registry.getPlace("0")
  );
  assert.equal(
    registry.getPlace(0).parentId,
    "root"
  );
  assert.equal(
    registry.getPlace("0").parentId,
    0
  );
  assert.equal(
    registry.getMemberships(1)[0]
      .parentPlaceId,
    "0"
  );
  assert.equal(
    registry.getPlace(1)
      .placement.parentPlaceId,
    0
  );

  assert.throws(
    () => registry.removePlace("root"),
    /while child 0 exists/
  );

  const snapshot =
    serializePlaceCore(registry);
  assert.deepEqual(
    snapshot.instances.map(
      (instance) => instance.id
    ),
    [0, 1, "0", "root"]
  );

  const restored =
    deserializePlaceCore(
      JSON.parse(
        JSON.stringify(snapshot)
      )
    );

  assert.ok(restored.getPlace(0));
  assert.ok(restored.getPlace("0"));
  assert.equal(
    restored.getPlace("0").parentId,
    0
  );
  assert.equal(
    restored.getMemberships(1)[0]
      .parentPlaceId,
    "0"
  );
  assert.equal(
    restored.getPlace(1)
      .placement.parentPlaceId,
    0
  );
  assert.equal(
    computePlaceCoreStateHash(restored),
    computePlaceCoreStateHash(registry)
  );
  restored.assertInternalConsistency();
});


test("runtime nested place inputs reject unknown fields", () => {
  const make = () => {
    const registry = new PlaceRegistry();
    registry.registerDefinition({
      id: "strict-runtime-input",
      layers: [{ spatialMode: "owned", id: "inside" }]
    });
    return registry;
  };

  assert.throws(
    () => make().createPlace({
      id: "bad-attachment",
      definitionId: "strict-runtime-input",
      attachments: {
        outside: {
          domainId: "street",
          position: { x: 0, y: 0 },
          postion: { x: 1, y: 1 }
        }
      }
    }),
    /attachment\.outside contains unknown field postion/
  );

  assert.throws(
    () => make().createPlace({
      id: "bad-placement",
      definitionId: "strict-runtime-input",
      placement: {
        domainId: "street",
        parentPlacId: "typo"
      }
    }),
    /placement contains unknown field parentPlacId/
  );

  const registry = make();
  const place = registry.createPlace({
    id: "house",
    definitionId: "strict-runtime-input"
  });

  assert.throws(
    () => registry.addPortal("house", {
      id: "bad-portal",
      bidirectionl: false,
      a: {
        domainId: place.layerDomains.get("inside"),
        position: { x: 0, y: 0 }
      },
      b: {
        domainId: "street",
        position: { x: 0, y: 0 }
      }
    }),
    /dynamic portal contains unknown field bidirectionl/
  );

  assert.throws(
    () => registry.addPortal("house", {
      id: "bad-endpoint",
      a: {
        domainId: place.layerDomains.get("inside"),
        position: { x: 0, y: 0 },
        spaecId: "typo"
      },
      b: {
        domainId: "street",
        position: { x: 0, y: 0 }
      }
    }),
    /portal\.a contains unknown field spaecId/
  );
});

test("prototype-shadowing layer IDs survive snapshot round-trip", () => {
  const registry = new PlaceRegistry();
  registry.registerDefinition({
    id: "prototype-snapshot-place",
    layers: [{ spatialMode: "owned", id: "constructor" }]
  });
  registry.createPlace({
    id: "house",
    definitionId: "prototype-snapshot-place"
  });

  const restored = deserializePlaceCore(
    JSON.parse(
      JSON.stringify(
        serializePlaceCore(registry)
      )
    )
  );

  assert.equal(
    restored
      .getPlace("house")
      .layerDomains
      .get("constructor"),
    "house:constructor"
  );
});


test("nearest anchor selection survives finite coordinate subtraction overflow", () => {
  const registry = new PlaceRegistry();
  registry.registerDefinition({
    id: "huge-anchor-space",
    layers: [{ spatialMode: "owned", id: "ground" }],
    anchors: [
      {
        id: "far",
        layerId: "ground",
        position: { x: 1e308, y: 0 }
      },
      {
        id: "near",
        layerId: "ground",
        position: { x: 9e307, y: 0 }
      }
    ]
  });
  registry.createPlace({
    id: "huge-place",
    definitionId: "huge-anchor-space"
  });

  const position = { x: -1e308, y: 0 };

  assert.equal(
    registry.findNearestAnchor(
      "huge-place",
      position,
      { layerId: "ground" }
    )?.id,
    "near"
  );

  const domainId =
    registry.getLayerDomain(
      "huge-place",
      "ground"
    );
  assert.equal(
    registry.findNearestAnchorInDomain(
      domainId,
      position
    )?.id,
    "near"
  );
});


test("nearest boundary selection survives finite coordinate subtraction overflow", () => {
  const registry = new PlaceRegistry();
  registry.registerDefinition({
    id: "huge-boundary-space",
    layers: [{ spatialMode: "owned", id: "ground" }],
    boundaries: [
      {
        id: "a-far",
        layerId: "ground",
        a: { x: 1e308, y: -1 },
        b: { x: 1e308, y: 1 }
      },
      {
        id: "z-near",
        layerId: "ground",
        a: { x: 9e307, y: -1 },
        b: { x: 9e307, y: 1 }
      }
    ]
  });
  registry.createPlace({
    id: "huge-boundary-place",
    definitionId: "huge-boundary-space"
  });

  const domainId =
    registry.getLayerDomain(
      "huge-boundary-place",
      "ground"
    );

  assert.equal(
    registry.findNearestBoundary(
      domainId,
      { x: -1e308, y: 0 }
    )?.boundary.id,
    "z-near"
  );
});


test("runtime metadata rejects sparse and extended arrays before cloning", () => {
  const registry =
    new PlaceRegistry();
  registry.registerDefinition({
    id: "json-array-shape"
  });

  const sparse =
    new Array(1_000_000_000);

  assert.throws(
    () =>
      registry.createPlace({
        id: "sparse",
        definitionId:
          "json-array-shape",
        metadata: {
          values: sparse
        }
      }),
    /sparse or extended array/
  );

  const extended = [1, 2];
  extended.note = "not JSON";

  assert.throws(
    () =>
      registry.createPlace({
        id: "extended",
        definitionId:
          "json-array-shape",
        metadata: {
          values: extended
        }
      }),
    /sparse or extended array/
  );

  assert.equal(
    registry.instances.size,
    0
  );
});


test("bound-domain location keeps singular place context coherent with overlapping exterior footprints", () => {
  const registry = new PlaceRegistry();

  registry.registerDefinition({
    id: "interior",
    layers: [{ spatialMode: "owned", id: "inside" }],
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
    }]
  });

  registry.registerDefinition({
    id: "overlay",
    footprint: {
      type: "aabb",
      minX: 0,
      minY: 0,
      maxX: 10,
      maxY: 10
    }
  });

  const interior = registry.createPlace({
    id: "house",
    definitionId: "interior"
  });
  const domainId =
    interior.layerDomains.get("inside");

  registry.createPlace({
    id: "overlay",
    definitionId: "overlay",
    placement: {
      domainId,
      transform: {
        x: 0,
        y: 0,
        rotation: 0
      },
      containment: "footprint"
    }
  });

  const location = registry.locate(
    domainId,
    { x: 5, y: 5 }
  );

  assert.deepEqual(
    location.places,
    ["house", "overlay"]
  );
  assert.equal(
    location.placeId,
    "house"
  );
  assert.equal(
    location.layerId,
    "inside"
  );
  assert.equal(
    location.deepestSpace?.placeId,
    "house"
  );
  assert.equal(
    location.deepestSpace?.id,
    "room"
  );
});


test("resolvedPortals never yields null when registry mutates between iterator steps", () => {
  const registry =
    new PlaceRegistry();

  registry.registerDefinition({
    id: "two-portals",
    layers: [{ spatialMode: "owned", id: "inside" }],
    portals: [
      {
        id: "a",
        a: {
          kind: "local",
          layerId: "inside",
          position: { x: 0, y: 0 }
        },
        b: {
          kind: "local",
          layerId: "inside",
          position: { x: 1, y: 0 }
        }
      },
      {
        id: "b",
        a: {
          kind: "local",
          layerId: "inside",
          position: { x: 2, y: 0 }
        },
        b: {
          kind: "local",
          layerId: "inside",
          position: { x: 3, y: 0 }
        }
      }
    ]
  });

  registry.createPlace({
    id: "house",
    definitionId: "two-portals"
  });

  const iterator =
    registry.resolvedPortals();

  const first =
    iterator.next();
  assert.equal(first.done, false);
  assert.equal(first.value.id, "a");

  assert.equal(
    registry.removePlace("house"),
    true
  );

  const remaining = [
    ...iterator
  ];

  assert.deepEqual(
    remaining,
    []
  );
});
