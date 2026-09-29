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


test("compiler rejects semantic positions that disagree with spaces", () => {
  const wrongAnchorLayer = tavernBlueprint();
  wrongAnchorLayer.anchors[0].spaceId = "cellar-room";
  assert.throws(
    () => compilePlace(wrongAnchorLayer),
    /another layer/
  );

  const outsideAnchor = tavernBlueprint();
  outsideAnchor.anchors[1].position = { x: 50, y: 50 };
  outsideAnchor.anchors[1].nodeId = null;
  assert.throws(
    () => compilePlace(outsideAnchor),
    /outside space/
  );

  const wrongPortalSpace = tavernBlueprint();
  wrongPortalSpace.portals[0].b.spaceId = "cellar-room";
  assert.throws(
    () => compilePlace(wrongPortalSpace),
    /another layer/
  );

  const outsidePortal = tavernBlueprint();
  outsidePortal.portals[0].b.position = { x: 50, y: 50 };
  outsidePortal.portals[0].b.nodeId = null;
  assert.throws(
    () => compilePlace(outsidePortal),
    /outside space/
  );
});

test("embedded navigation nodes must coincide with semantic target positions", () => {
  const anchorMismatch = tavernBlueprint();
  anchorMismatch.anchors[0].position = { x: 0.5, y: 0 };
  assert.throws(
    () => compilePlace(anchorMismatch),
    /position does not match navigation node/
  );

  const portalMismatch = tavernBlueprint();
  portalMismatch.portals[1].a.position = { x: 9.5, y: 0 };
  assert.throws(
    () => compilePlace(portalMismatch),
    /position does not match navigation node/
  );
});

test("space default anchors must physically lie inside their space", () => {
  const invalid = tavernBlueprint();
  invalid.spaces[1].defaultAnchorId = "front";
  invalid.anchors[0].spaceId = null;
  invalid.anchors[0].position = { x: 10, y: 0 };
  invalid.anchors[0].nodeId = "g-stairs";

  assert.throws(
    () => compilePlace(invalid),
    /default anchor is outside/
  );
});
