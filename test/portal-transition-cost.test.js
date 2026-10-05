import test from "node:test";
import assert from "node:assert/strict";

import {
  PlaceRegistry,
  compilePlace
} from "../src/index.js";

function baseDefinition(portal = {}) {
  return {
    id: "transition-cost-place",
    layers: [{ spatialMode: "owned", id: "a" }, { spatialMode: "owned", id: "b" }],
    portals: [{
      id: "portal",
      a: {
        kind: "local",
        layerId: "a",
        position: { x: 0, y: 0 }
      },
      b: {
        kind: "local",
        layerId: "b",
        position: { x: 0, y: 0 }
      },
      ...portal
    }]
  };
}

test("static portal transition costs must be finite and non-negative", () => {
  for (const transitionCost of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(
      () => compilePlace(baseDefinition({ transitionCost })),
      /transitionCost must be a finite number >= 0/
    );
  }

  assert.equal(
    compilePlace(baseDefinition({ transitionCost: 0 }))
      .getPortal("portal").transitionCost,
    0
  );
  assert.equal(
    compilePlace(baseDefinition({ transitionCost: 2.5 }))
      .getPortal("portal").transitionCost,
    2.5
  );
});

test("dynamic portal transition costs reject invalid values atomically", () => {
  const places = new PlaceRegistry();
  places.registerDefinition(compilePlace({
    id: "dynamic-cost-place",
    layers: [{ spatialMode: "owned", id: "a" }, { spatialMode: "owned", id: "b" }]
  }));
  const place = places.createPlace({
    id: "house",
    definitionId: "dynamic-cost-place"
  });

  const stateRevision = places.stateRevision;
  const travelRevision = places.travelRevision;

  for (const transitionCost of [-1, Number.NaN, Number.NEGATIVE_INFINITY]) {
    assert.throws(
      () => places.addPortal("house", {
        id: `bad-${String(transitionCost)}`,
        a: {
          domainId: place.layerDomains.get("a"),
          position: { x: 0, y: 0 }
        },
        b: {
          domainId: place.layerDomains.get("b"),
          position: { x: 0, y: 0 }
        },
        transitionCost
      }),
      /transitionCost must be a finite number >= 0/
    );
  }

  assert.equal(place.dynamicPortals.size, 0);
  assert.equal(places.stateRevision, stateRevision);
  assert.equal(places.travelRevision, travelRevision);
  places.assertInternalConsistency();
});

test("dynamic portal transition costs preserve exact finite values", () => {
  const places = new PlaceRegistry();
  places.registerDefinition(compilePlace({
    id: "dynamic-cost-place",
    layers: [{ spatialMode: "owned", id: "a" }, { spatialMode: "owned", id: "b" }]
  }));
  const place = places.createPlace({
    id: "house",
    definitionId: "dynamic-cost-place"
  });

  const portal = places.addPortal("house", {
    id: "stairs",
    a: {
      domainId: place.layerDomains.get("a"),
      position: { x: 0, y: 0 }
    },
    b: {
      domainId: place.layerDomains.get("b"),
      position: { x: 0, y: 0 }
    },
    transitionCost: 3.75
  });

  assert.equal(portal.transitionCost, 3.75);
});
