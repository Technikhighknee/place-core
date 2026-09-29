import test from "node:test";
import assert from "node:assert/strict";

import {
  PlaceRegistry,
  compilePlace
} from "../src/index.js";

function booleanDefinition(overrides = {}) {
  return {
    id: "boolean-place",
    layers: [{
      id: "inside",
      navigation: {
        nodes: [
          { id: "a", x: 0, y: 0 },
          { id: "b", x: 1, y: 0 }
        ],
        roads: [{
          id: "road",
          from: "a",
          to: "b",
          width: 1
        }]
      }
    }],
    boundaries: [{
      id: "wall",
      layerId: "inside",
      a: { x: 0, y: 0 },
      b: { x: 0, y: 1 }
    }],
    portals: [{
      id: "door",
      a: {
        kind: "local",
        layerId: "inside",
        position: { x: 0, y: 0 },
        nodeId: "a"
      },
      b: {
        kind: "local",
        layerId: "inside",
        position: { x: 1, y: 0 },
        nodeId: "b"
      },
      roadBindings: [{
        layerId: "inside",
        roadId: "road"
      }]
    }],
    ...overrides
  };
}

test("compiled boolean authoring fields reject truthy and falsy coercions", () => {
  const cases = [
    {
      mutate: (blueprint) => {
        blueprint.portals[0].locked = "false";
      },
      pattern: /locked must be a boolean/
    },
    {
      mutate: (blueprint) => {
        blueprint.portals[0].bidirectional = 1;
      },
      pattern: /bidirectional must be a boolean/
    },
    {
      mutate: (blueprint) => {
        blueprint.boundaries[0].enabled = 0;
      },
      pattern: /enabled must be a boolean/
    },
    {
      mutate: (blueprint) => {
        blueprint.layers[0].navigation.roads[0].enabled = "yes";
      },
      pattern: /road\(road\)\.enabled must be a boolean/
    }
  ];

  for (const { mutate, pattern } of cases) {
    const blueprint = structuredClone(booleanDefinition());
    mutate(blueprint);
    assert.throws(
      () => compilePlace(blueprint),
      pattern
    );
  }
});

test("runtime structural state rejects non-boolean patches atomically", () => {
  const places = new PlaceRegistry();
  places.registerDefinition({
    ...booleanDefinition(),
    spaces: [{
      id: "room",
      layerId: "inside",
      geometry: {
        type: "aabb",
        minX: -1,
        minY: -1,
        maxX: 2,
        maxY: 2
      }
    }]
  });
  places.createPlace({
    id: "house",
    definitionId: "boolean-place"
  });

  const stateRevision = places.stateRevision;
  const travelRevision = places.travelRevision;

  assert.throws(
    () => places.setPortalState("house", "door", { locked: "false" }),
    /locked must be a boolean/
  );
  assert.throws(
    () => places.setBoundaryState("house", "wall", { enabled: 0 }),
    /enabled must be a boolean/
  );
  assert.throws(
    () => places.setSpaceState("house", "room", { enabled: "true" }),
    /enabled must be a boolean/
  );

  assert.equal(places.getPortal("house", "door").locked, false);
  assert.equal(places.getBoundary("house", "wall").enabled, true);
  assert.equal(places.getSpace("house", "room").enabled, true);
  assert.equal(places.stateRevision, stateRevision);
  assert.equal(places.travelRevision, travelRevision);
  places.assertInternalConsistency();
});

test("dynamic portal booleans are strict at creation and mutation time", () => {
  const places = new PlaceRegistry();
  places.registerDefinition({
    id: "dynamic-boolean-place",
    layers: [{ id: "inside" }]
  });
  const place = places.createPlace({
    id: "hall",
    definitionId: "dynamic-boolean-place"
  });
  const domainId = place.layerDomains.get("inside");

  assert.throws(
    () => places.addPortal("hall", {
      id: "bad",
      a: { domainId, position: { x: 0, y: 0 } },
      b: { domainId: "outside", position: { x: 0, y: 0 } },
      open: "false"
    }),
    /open must be a boolean/
  );

  const portal = places.addPortal("hall", {
    id: "good",
    a: { domainId, position: { x: 0, y: 0 } },
    b: { domainId: "outside", position: { x: 0, y: 0 } },
    open: true,
    enabled: true
  });
  assert.equal(portal.open, true);

  const stateRevision = places.stateRevision;
  const travelRevision = places.travelRevision;

  assert.throws(
    () => places.setPortalState("hall", "good", { blocked: 1 }),
    /blocked must be a boolean/
  );

  assert.equal(places.getPortal("hall", "good").blocked, false);
  assert.equal(places.stateRevision, stateRevision);
  assert.equal(places.travelRevision, travelRevision);
});

test("registry event capture configuration is strict", () => {
  assert.throws(
    () => new PlaceRegistry({ captureEvents: "false" }),
    /captureEvents must be a boolean/
  );

  const places = new PlaceRegistry({ captureEvents: false });
  assert.throws(
    () => places.setEventCapture(1),
    /event capture must be a boolean/
  );
});


test("live mutation patches reject unknown fields atomically", () => {
  const places = new PlaceRegistry();
  places.registerDefinition({
    id: "strict-patch-place",
    layers: [{ id: "inside" }],
    spaces: [{
      id: "room",
      layerId: "inside",
      geometry: {
        type: "aabb",
        minX: 0,
        minY: 0,
        maxX: 2,
        maxY: 2
      }
    }],
    boundaries: [{
      id: "wall",
      layerId: "inside",
      a: { x: 0, y: 0 },
      b: { x: 1, y: 0 }
    }],
    portals: [{
      id: "door",
      a: {
        kind: "local",
        layerId: "inside",
        position: { x: 0, y: 0 }
      },
      b: {
        kind: "external",
        slot: "outside"
      }
    }]
  });
  places.createPlace({
    id: "house",
    definitionId: "strict-patch-place"
  });

  const stateRevision = places.stateRevision;
  const travelRevision = places.travelRevision;

  assert.throws(
    () => places.setPortalState(
      "house",
      "door",
      { lokced: true }
    ),
    /portal state patch contains unknown field lokced/
  );
  assert.throws(
    () => places.setBoundaryState(
      "house",
      "wall",
      { visible: false }
    ),
    /boundary state patch contains unknown field visible/
  );
  assert.throws(
    () => places.setSpaceState(
      "house",
      "room",
      { active: false }
    ),
    /space state patch contains unknown field active/
  );

  assert.equal(
    places.getPortal("house", "door").locked,
    false
  );
  assert.equal(
    places.getBoundary("house", "wall").enabled,
    true
  );
  assert.equal(
    places.getSpace("house", "room").enabled,
    true
  );
  assert.equal(places.stateRevision, stateRevision);
  assert.equal(places.travelRevision, travelRevision);
});

test("live mutation patches must be plain objects", () => {
  const places = new PlaceRegistry();
  places.registerDefinition({
    id: "plain-patch-place",
    layers: [{ id: "inside" }],
    spaces: [{
      id: "room",
      layerId: "inside",
      geometry: {
        type: "aabb",
        minX: 0,
        minY: 0,
        maxX: 1,
        maxY: 1
      }
    }],
    boundaries: [{
      id: "wall",
      layerId: "inside",
      a: { x: 0, y: 0 },
      b: { x: 1, y: 0 }
    }]
  });
  places.createPlace({
    id: "house",
    definitionId: "plain-patch-place"
  });

  assert.throws(
    () => places.setBoundaryState(
      "house",
      "wall",
      []
    ),
    /must be a plain object/
  );
  assert.throws(
    () => places.setSpaceState(
      "house",
      "room",
      null
    ),
    /must be a plain object/
  );
});
