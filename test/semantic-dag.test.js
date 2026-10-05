import test from "node:test";
import assert from "node:assert/strict";

import {
  PlaceRegistry,
  serializePlaceCore,
  deserializePlaceCore,
  validatePlaceCoreSnapshot,
  computePlaceCoreStateHash
} from "../src/index.js";

function definition() {
  return {
    id: "semantic-node",
    layers: [{ spatialMode: "owned", id: "inside" }],
    spaces: [{
      id: "inside",
      layerId: "inside",
      geometry: {
        type: "aabb",
        minX: 0,
        minY: 0,
        maxX: 10,
        maxY: 10
      }
    }]
  };
}

function registry(options = {}) {
  const places = new PlaceRegistry(options);
  places.registerDefinition(definition());
  return places;
}

function add(places, id, extra = {}) {
  return places.createPlace({
    id,
    definitionId: "semantic-node",
    ...extra
  });
}

test("semantic memberships form a deterministic DAG without changing the primary containment chain", () => {
  const places = registry();

  add(places, "city");
  add(places, "market", {
    parentId: "city"
  });
  add(places, "tax-zone", {
    memberships: [{
      parentPlaceId: "city",
      kind: "jurisdiction"
    }]
  });
  add(places, "parcel", {
    parentId: "market"
  });
  const tavern = add(places, "tavern", {
    parentId: "parcel",
    memberships: [{
      parentPlaceId: "tax-zone",
      kind: "tax-jurisdiction"
    }]
  });

  const location = places.locate(
    tavern.layerDomains.get("inside"),
    { x: 5, y: 5 }
  );

  assert.deepEqual(
    location.places,
    ["city", "market", "parcel", "tavern"],
    "primary containment remains a stable single-parent chain"
  );
  assert.deepEqual(
    location.semanticPlaces,
    ["city", "market", "parcel", "tax-zone", "tavern"],
    "the semantic closure includes all DAG parents exactly once"
  );

  assert.deepEqual(
    places.getSemanticAncestors("tavern"),
    ["city", "market", "parcel", "tax-zone"]
  );
  assert.deepEqual(
    places.getSemanticAncestors(
      "tavern",
      { includeSelf: true }
    ),
    ["city", "market", "parcel", "tax-zone", "tavern"]
  );

  places.assertInternalConsistency();
});

test("semantic DAG deduplicates diamonds and supports multiple relation kinds to one parent", () => {
  const places = registry();

  add(places, "root");
  add(places, "left", {
    memberships: [{
      parentPlaceId: "root",
      kind: "administrative"
    }]
  });
  add(places, "right", {
    memberships: [{
      parentPlaceId: "root",
      kind: "economic"
    }]
  });
  const leaf = add(places, "leaf", {
    memberships: [
      {
        parentPlaceId: "left",
        kind: "ward"
      },
      {
        parentPlaceId: "right",
        kind: "market-zone"
      },
      {
        parentPlaceId: "root",
        kind: "legal"
      },
      {
        parentPlaceId: "root",
        kind: "tax"
      }
    ]
  });

  const location = places.locate(
    leaf.layerDomains.get("inside"),
    { x: 2, y: 2 }
  );

  assert.equal(
    location.semanticPlaces.filter(
      (id) => id === "root"
    ).length,
    1
  );
  assert.deepEqual(
    places.getMemberships("leaf")
      .filter((membership) =>
        membership.parentPlaceId === "root"
      )
      .map((membership) => membership.kind),
    ["legal", "tax"]
  );

  const diagnostics = places.getDiagnostics();
  assert.equal(diagnostics.semanticMembershipCount, 6);
  assert.equal(diagnostics.semanticMembershipParentCount, 3);

  places.assertInternalConsistency();
});

test("semantic cycles are rejected across primary-parent and membership edges", () => {
  const places = registry();

  add(places, "a");
  add(places, "b", { parentId: "a" });
  add(places, "c", {
    memberships: [{
      parentPlaceId: "b",
      kind: "zone"
    }]
  });

  assert.throws(
    () => places.addMembership("a", {
      parentPlaceId: "c",
      kind: "cycle"
    }),
    /semantic membership cycle/
  );

  assert.throws(
    () => places.setParent("a", "c"),
    /place parent cycle through semantic membership graph/
  );

  assert.deepEqual(places.getMemberships("a"), []);
  assert.equal(places.getPlace("a").parentId, null);
  places.assertInternalConsistency();
});

test("live membership changes propagate occupancy and enter/leave events to semantic ancestors", () => {
  const places = registry({
    captureEvents: true
  });

  add(places, "ward");
  const tavern = add(places, "tavern");

  places.updateEntityOccupancy({
    id: "hans",
    domainId: tavern.layerDomains.get("inside"),
    position: { x: 5, y: 5 }
  });
  places.drainEvents();

  assert.deepEqual(
    [...places.entitiesInPlace("ward")],
    []
  );

  places.addMembership("tavern", {
    parentPlaceId: "ward",
    kind: "district"
  });

  assert.deepEqual(
    [...places.entitiesInPlace("ward")],
    ["hans"]
  );

  let events = places.drainEvents();
  assert.deepEqual(
    events
      .filter((event) => event.placeId === "ward")
      .map((event) => event.type),
    ["place-enter"]
  );

  assert.equal(
    places.removeMembership(
      "tavern",
      "ward",
      "district"
    ),
    true
  );

  assert.deepEqual(
    [...places.entitiesInPlace("ward")],
    []
  );

  events = places.drainEvents();
  assert.deepEqual(
    events
      .filter((event) => event.placeId === "ward")
      .map((event) => event.type),
    ["place-leave"]
  );

  places.assertInternalConsistency();
});

test("membership reverse index keeps multiple edge kinds until the last relation is removed", () => {
  const places = registry();

  add(places, "parent");
  add(places, "child");

  places.addMembership("child", {
    parentPlaceId: "parent",
    kind: "legal"
  });
  places.addMembership("child", {
    parentPlaceId: "parent",
    kind: "tax"
  });

  assert.throws(
    () => places.removePlace("parent"),
    /semantic membership child/
  );

  assert.equal(
    places.removeMembership(
      "child",
      "parent",
      "legal"
    ),
    true
  );

  assert.throws(
    () => places.removePlace("parent"),
    /semantic membership child/
  );

  assert.equal(
    places.removeMembership(
      "child",
      "parent",
      "tax"
    ),
    true
  );

  assert.equal(
    places.removePlace("parent"),
    true
  );
  places.assertInternalConsistency();
});

test("numeric and string place IDs remain distinct in semantic membership DAGs", () => {
  const places = registry();

  add(places, 1);
  add(places, "1");
  add(places, "child", {
    memberships: [
      {
        parentPlaceId: 1,
        kind: "numeric-parent"
      },
      {
        parentPlaceId: "1",
        kind: "string-parent"
      }
    ]
  });

  assert.deepEqual(
    places.getSemanticAncestors("child"),
    [1, "1"]
  );
  places.assertInternalConsistency();
});

test("semantic membership DAG survives canonical snapshot round-trip", () => {
  const places = registry();

  add(places, "city");
  add(places, "ward", {
    memberships: [{
      parentPlaceId: "city",
      kind: "administrative",
      metadata: {
        source: "charter"
      }
    }]
  });
  add(places, "tavern", {
    parentId: "city",
    memberships: [{
      parentPlaceId: "ward",
      kind: "tax"
    }]
  });

  const before = computePlaceCoreStateHash(places);
  const snapshot = serializePlaceCore(places);

  assert.equal(validatePlaceCoreSnapshot(snapshot), true);

  const restored = deserializePlaceCore(
    JSON.parse(JSON.stringify(snapshot))
  );

  assert.equal(
    computePlaceCoreStateHash(restored),
    before
  );
  assert.deepEqual(
    restored.getSemanticAncestors("tavern"),
    ["city", "ward"]
  );
  assert.deepEqual(
    restored.getMemberships("ward"),
    [{
      parentPlaceId: "city",
      kind: "administrative",
      metadata: {
        source: "charter"
      }
    }]
  );
  restored.assertInternalConsistency();
});

test("snapshot validation rejects missing, duplicate, self and mixed-cycle memberships", () => {
  const places = registry();
  add(places, "a");
  add(places, "b", { parentId: "a" });

  const base = serializePlaceCore(places);

  const missing = structuredClone(base);
  missing.instances.find((item) => item.id === "b")
    .memberships = [{
      parentPlaceId: "missing",
      kind: "zone",
      metadata: null
    }];
  assert.throws(
    () => validatePlaceCoreSnapshot(missing),
    /missing membership parent/
  );

  const duplicate = structuredClone(base);
  duplicate.instances.find((item) => item.id === "b")
    .memberships = [
      {
        parentPlaceId: "a",
        kind: "zone",
        metadata: null
      },
      {
        parentPlaceId: "a",
        kind: "zone",
        metadata: null
      }
    ];
  assert.throws(
    () => validatePlaceCoreSnapshot(duplicate),
    /duplicate semantic membership/
  );

  const self = structuredClone(base);
  self.instances.find((item) => item.id === "b")
    .memberships = [{
      parentPlaceId: "b",
      kind: "zone",
      metadata: null
    }];
  assert.throws(
    () => validatePlaceCoreSnapshot(self),
    /semantic membership to itself/
  );

  const cycle = structuredClone(base);
  cycle.instances.find((item) => item.id === "a")
    .memberships = [{
      parentPlaceId: "b",
      kind: "cycle",
      metadata: null
    }];
  assert.throws(
    () => validatePlaceCoreSnapshot(cycle),
    /semantic membership cycle/
  );
});


test("failed place creation rolls semantic membership indexes back transactionally", () => {
  const bridge = {
    attachRegistry() {},
    materializePlace(instance) {
      if (instance.id === "child") {
        throw new Error("synthetic materialization failure");
      }
    }
  };

  const places = registry({ bridge });
  add(places, "parent");

  const stateRevision = places.stateRevision;
  const travelRevision = places.travelRevision;

  assert.throws(
    () => add(places, "child", {
      memberships: [{
        parentPlaceId: "parent",
        kind: "district"
      }]
    }),
    /synthetic materialization failure/
  );

  assert.equal(places.getPlace("child"), null);
  assert.equal(places.getDiagnostics().semanticMembershipCount, 0);
  assert.equal(
    places.getDiagnostics().semanticMembershipParentCount,
    0
  );
  assert.equal(places.stateRevision, stateRevision);
  assert.equal(places.travelRevision, travelRevision);

  assert.equal(
    places.removePlace("parent"),
    true,
    "rolled-back membership must not leave a ghost removal guard"
  );
  places.assertInternalConsistency();
});


test("version-1 snapshots require explicit memberships state", () => {
  const places = registry();

  add(places, "city");
  add(places, "tavern", {
    parentId: "city"
  });

  const snapshot = serializePlaceCore(places);
  for (const instance of snapshot.instances) {
    delete instance.memberships;
  }

  assert.throws(
    () =>
      validatePlaceCoreSnapshot(
        snapshot
      ),
    /missing required field memberships/
  );
});


test("snapshot restore supports cross-graph dependency cycles between semantics and placement", () => {
  const places = registry();

  add(places, "a");
  add(places, "b");

  places.addMembership("a", {
    parentPlaceId: "b",
    kind: "jurisdiction"
  });

  places.setPlacement("a", {
    domainId: "world",
    transform: {
      x: 10,
      y: 20,
      rotation: 0.25,
      scale: 1
    },
    containment: "footprint"
  });

  places.setPlacement("b", {
    parentPlaceId: "a",
    transform: {
      x: 3,
      y: 4,
      rotation: 0.5,
      scale: 2
    },
    containment: "footprint"
  });

  const snapshot = serializePlaceCore(places);
  const beforeHash = computePlaceCoreStateHash(places);

  const restored = deserializePlaceCore(
    JSON.parse(JSON.stringify(snapshot))
  );

  assert.equal(
    computePlaceCoreStateHash(restored),
    beforeHash
  );
  assert.deepEqual(
    restored.getMemberships("a"),
    [{
      parentPlaceId: "b",
      kind: "jurisdiction",
      metadata: null
    }]
  );
  assert.deepEqual(
    restored.getResolvedPlacement("b"),
    places.getResolvedPlacement("b")
  );
  restored.assertInternalConsistency();
});


test("PlaceInstance cannot bypass registry-managed semantic membership invariants", () => {
  const places = registry();

  add(places, "parent");
  const child = add(places, "child");

  assert.throws(
    () => child.addMembership({
      parentPlaceId: "parent",
      kind: "illegal-direct-mutation",
      metadata: null
    }),
    /registry-managed/
  );

  assert.throws(
    () => child.removeMembership(
      "parent",
      "illegal-direct-mutation"
    ),
    /registry-managed/
  );

  assert.deepEqual(
    places.getMemberships("child"),
    []
  );
  places.assertInternalConsistency();
});


test("semantic closure cache invalidates transitively for descendant places", () => {
  const places = registry();

  add(places, "ward");
  add(places, "tavern");
  add(places, "cellar", {
    parentId: "tavern"
  });

  assert.deepEqual(
    places.getSemanticAncestors("cellar"),
    ["tavern"]
  );
  assert.ok(
    places.getDiagnostics().semanticClosureCacheSize > 0
  );

  places.addMembership("tavern", {
    parentPlaceId: "ward",
    kind: "district"
  });

  assert.deepEqual(
    places.getSemanticAncestors("cellar"),
    ["ward", "tavern"]
  );

  places.removeMembership(
    "tavern",
    "ward",
    "district"
  );

  assert.deepEqual(
    places.getSemanticAncestors("cellar"),
    ["tavern"]
  );
  places.assertInternalConsistency();
});


test("getSemanticAncestors validates its options strictly", () => {
  const places = registry();
  add(places, "root");
  add(places, "child", {
    parentId: "root"
  });

  assert.throws(
    () =>
      places.getSemanticAncestors(
        "child",
        { includeSelf: "false" }
      ),
    /includeSelf must be a boolean/
  );

  assert.throws(
    () =>
      places.getSemanticAncestors(
        "child",
        { includeSlef: true }
      ),
    /contains unknown field includeSlef/
  );
});
