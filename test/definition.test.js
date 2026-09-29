import test from "node:test";
import assert from "node:assert/strict";

import { compilePlace, definePlace } from "../src/index.js";
import { tavernBlueprint } from "./fixtures.js";

test("compilePlace produces immutable shared definition state", () => {
  const blueprint = tavernBlueprint();
  const definition = compilePlace(blueprint);

  assert.equal(definition.id, "tavern");
  assert.equal(definition.layers.length, 2);
  assert.equal(definition.spaces.length, 3);
  assert.equal(definition.portals.length, 2);
  assert.equal(definition.anchors.length, 3);
  assert.equal(definition.getSpaceDepth("ground-floor"), 0);
  assert.equal(definition.getSpaceDepth("taproom"), 1);
  assert.equal(definition.getPortal("front-door").a.kind, "external");
  assert.equal(definition.getAnchor("barrel").nodeId, "c-barrel");

  const located = definition.locateSpaces("ground", { x: 5, y: 0 });
  assert.deepEqual(located.map((space) => space.id), ["ground-floor", "taproom"]);

  assert.throws(() => {
    definition.layers.push({ id: "illegal" });
  }, TypeError);
});

test("definition hash is canonical for equivalent input", () => {
  const a = compilePlace(tavernBlueprint());
  const b = compilePlace(structuredClone(tavernBlueprint()));
  assert.equal(a.contentHash, b.contentHash);
});

test("compiler rejects broken structural references", () => {
  const invalid = tavernBlueprint();
  invalid.spaces[1].parentSpaceId = "missing";
  assert.throws(() => compilePlace(invalid), /unknown parent/);

  const invalidNode = tavernBlueprint();
  invalidNode.anchors[0].nodeId = "missing-node";
  assert.throws(() => compilePlace(invalidNode), /unknown navigation node/);
});

test("definePlace snapshots authoring input", () => {
  const source = tavernBlueprint();
  const defined = definePlace(source);
  source.layers[0].id = "mutated";
  assert.equal(defined.layers[0].id, "ground");
});
