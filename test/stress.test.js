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
  id: "fuzz-place",
  layers: [{ id: "a" }, { id: "b" }],
  spaces: [
    { id: "a-space", layerId: "a", geometry: { type: "aabb", minX: 0, minY: 0, maxX: 10, maxY: 10 } },
    { id: "b-space", layerId: "b", geometry: { type: "aabb", minX: 0, minY: 0, maxX: 10, maxY: 10 } }
  ],
  portals: [{
    id: "stairs",
    a: { kind: "local", layerId: "a", spaceId: "a-space", position: { x: 1, y: 1 } },
    b: { kind: "local", layerId: "b", spaceId: "b-space", position: { x: 1, y: 1 } }
  }]
});

function rng(seed) {
  let x = seed >>> 0;
  return () => {
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
    return (x >>> 0) / 0x1_0000_0000;
  };
}

function run(seed) {
  const random = rng(seed);
  let places = new PlaceRegistry();
  places.registerDefinition(definition);
  for (let i = 0; i < 100; i += 1) places.createPlace({ id: `p-${i}`, definitionId: definition.id });

  for (let step = 0; step < 2_000; step += 1) {
    const id = `p-${Math.floor(random() * 100)}`;
    const op = Math.floor(random() * 4);
    if (op === 0) places.setPortalState(id, "stairs", { locked: random() < 0.5 });
    else if (op === 1) places.setSpaceState(id, random() < 0.5 ? "a-space" : "b-space", { enabled: random() < 0.8 });
    else if (op === 2) {
      const portalId = `breach-${Math.floor(random() * 4)}`;
      const instance = places.getPlace(id);
      if (instance.dynamicPortals.has(portalId)) places.removeInstancePortal(id, portalId);
      else places.addInstancePortal(id, {
        id: portalId,
        a: { domainId: `${id}:a`, position: { x: 9, y: 5 } },
        b: { domainId: `outside-${Math.floor(random() * 8)}`, position: { x: 0, y: 0 } }
      });
    } else places.locate(`${id}:a`, { x: random() * 10, y: random() * 10 });

    if (step % 250 === 249) {
      places.assertInternalConsistency();
      const before = computePlaceCoreStateHash(places);
      places = deserializePlaceCore(serializePlaceCore(places));
      assert.equal(computePlaceCoreStateHash(places), before);
    }
  }
  return computePlaceCoreStateHash(places);
}

test("randomized structural churn is deterministic through repeated restore", () => {
  assert.equal(run(0xC0FFEE), run(0xC0FFEE));
  assert.notEqual(run(0xC0FFEE), run(0xBADF00D));
});
