import test from "node:test";
import assert from "node:assert/strict";

import {
  PlaceRegistry,
  WorldCoreBridge
} from "../src/index.js";
import { tavernBlueprint } from "./fixtures.js";

test("public PlaceRegistry exposes one canonical API without compatibility aliases", () => {
  const places = new PlaceRegistry();
  places.registerDefinition(tavernBlueprint());

  const removedMethods = [
    "attachBridge",
    "domainForLayer",
    "getPortal",
    "getBoundary",
    "findAnchor",
    "addInstancePortal",
    "removeInstancePortal",
    "setExternalBinding",
    "clearExternalBinding",
    "syncEntityOccupancy"
  ];

  for (const method of removedMethods) {
    assert.equal(
      typeof places[method],
      "undefined",
      `removed compatibility method ${method} must not reappear`
    );
  }

  assert.throws(
    () => new PlaceRegistry({ worldCoreBridge: {} }),
    /PlaceRegistry options contains unknown field worldCoreBridge/
  );

  for (const input of [
    { id: "old-parent", parentPlaceId: "parent" },
    { id: "old-bindings", externalBindings: {} },
    { id: "old-placement-domain", placementDomainId: "street" },
    { id: "old-containment", containment: "footprint" }
  ]) {
    assert.throws(
      () => places.createPlace({
        id: input.id,
        definitionId: "tavern",
        ...input
      }),
      /place input contains unknown field/
    );
  }

  assert.equal(typeof WorldCoreBridge, "function");
});
