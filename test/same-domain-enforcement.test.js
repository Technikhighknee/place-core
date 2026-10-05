import test from "node:test";
import assert from "node:assert/strict";

import {
  PlaceRegistry,
  compilePlace
} from "../src/index.js";

function sameLayerDefinition(portal = {}) {
  return {
    id: "same-domain-enforcement",
    layers: [{ spatialMode: "owned", id: "inside" }],
    portals: [{
      id: "passage",
      a: {
        kind: "local",
        layerId: "inside",
        position: { x: 0, y: 0 }
      },
      b: {
        kind: "local",
        layerId: "inside",
        position: { x: 1, y: 0 }
      },
      ...portal
    }]
  };
}

test("same-domain delay requires a threshold road binding", () => {
  assert.throws(
    () => compilePlace(sameLayerDefinition({
      transitionCost: 1
    })),
    /requires a threshold road binding for physical enforcement/
  );
});

test("initially blocked same-domain portal requires a threshold road binding", () => {
  for (const state of [
    { locked: true },
    { blocked: true },
    { enabled: false },
    { blocksWhenClosed: true, open: false }
  ]) {
    assert.throws(
      () => compilePlace(sameLayerDefinition(state)),
      /requires a threshold road binding for physical enforcement/
    );
  }
});

test("pure semantic same-domain portal is valid until physical state is requested", () => {
  const places = new PlaceRegistry();
  places.registerDefinition(compilePlace(sameLayerDefinition()));
  places.createPlace({
    id: "hall",
    definitionId: "same-domain-enforcement"
  });

  const stateRevision = places.stateRevision;
  const travelRevision = places.travelRevision;

  assert.equal(
    places.resolvePortal("hall", "passage").traversable,
    true
  );

  assert.throws(
    () => places.setPortalState("hall", "passage", { locked: true }),
    /requires a road binding/
  );

  assert.equal(
    places.resolvePortal("hall", "passage").locked,
    false
  );
  assert.equal(places.stateRevision, stateRevision);
  assert.equal(places.travelRevision, travelRevision);
  places.assertInternalConsistency();
});

test("non-traversability-neutral semantic state changes remain allowed", () => {
  const places = new PlaceRegistry();
  places.registerDefinition(compilePlace(sameLayerDefinition({
    blocksWhenClosed: false
  })));
  places.createPlace({
    id: "hall",
    definitionId: "same-domain-enforcement"
  });

  const result = places.setPortalState(
    "hall",
    "passage",
    { open: false }
  );

  assert.equal(result.open, false);
  assert.equal(result.traversable, true);
});

test("dynamic same-domain portals enforce the same physical rules", () => {
  const places = new PlaceRegistry();
  places.registerDefinition(compilePlace({
    id: "dynamic-enforcement",
    layers: [{ spatialMode: "owned", id: "inside" }]
  }));
  const place = places.createPlace({
    id: "hall",
    definitionId: "dynamic-enforcement"
  });
  const domainId = place.layerDomains.get("inside");

  assert.throws(
    () => places.addPortal("hall", {
      id: "slow-gap",
      a: { domainId, position: { x: 0, y: 0 } },
      b: { domainId, position: { x: 1, y: 0 } },
      transitionCost: 2
    }),
    /requires a road binding/
  );

  const portal = places.addPortal("hall", {
    id: "semantic-gap",
    a: { domainId, position: { x: 0, y: 0 } },
    b: { domainId, position: { x: 1, y: 0 } }
  });
  assert.equal(portal.traversable, true);

  assert.throws(
    () => places.setPortalState(
      "hall",
      "semantic-gap",
      { blocked: true }
    ),
    /requires a road binding/
  );
  assert.equal(
    places.resolvePortal("hall", "semantic-gap").blocked,
    false
  );
});

test("attachment cannot create unenforceable same-domain delay", () => {
  const places = new PlaceRegistry();
  places.registerDefinition(compilePlace({
    id: "attachment-enforcement",
    layers: [{ spatialMode: "owned", id: "inside" }],
    portals: [{
      id: "gangway",
      transitionCost: 3,
      a: { kind: "external", slot: "outside" },
      b: {
        kind: "local",
        layerId: "inside",
        position: { x: 0, y: 0 }
      }
    }]
  }));

  const place = places.createPlace({
    id: "ship",
    definitionId: "attachment-enforcement"
  });
  const inside = place.layerDomains.get("inside");

  places.setAttachment("ship", "outside", {
    domainId: "harbor",
    position: { x: 10, y: 0 }
  });
  assert.equal(
    places.resolvePortal("ship", "gangway").connected,
    true
  );

  assert.throws(
    () => places.setAttachment("ship", "outside", {
      domainId: inside,
      position: { x: 10, y: 0 }
    }),
    /requires a road binding/
  );

  assert.equal(
    places.resolvePortal("ship", "gangway").a.domainId,
    "harbor",
    "failed attachment change must roll back atomically"
  );
});


test("dynamic road bindings reject unknown embedded roads and wrong endpoint connections", () => {
  const places = new PlaceRegistry();
  places.registerDefinition({
    id: "dynamic-road-validation",
    layers: [{
      spatialMode: "owned",
      id: "inside",
      navigation: {
        nodes: [
          { id: "a", x: 0, y: 0 },
          { id: "b", x: 1, y: 0 },
          { id: "c", x: 0, y: 1 }
        ],
        roads: [
          {
            id: "ab",
            from: "a",
            to: "b",
            bidirectional: true
          },
          {
            id: "ac",
            from: "a",
            to: "c",
            bidirectional: true
          }
        ]
      }
    }]
  });

  const place = places.createPlace({
    id: "hall",
    definitionId: "dynamic-road-validation"
  });
  const domainId = place.layerDomains.get("inside");
  const beforeState = places.stateRevision;
  const beforeTravel = places.travelRevision;

  assert.throws(
    () => places.addPortal("hall", {
      id: "missing-road",
      a: {
        domainId,
        position: { x: 0, y: 0 },
        nodeId: "a",
        layerId: "inside"
      },
      b: {
        domainId: "outside",
        position: { x: 0, y: 0 }
      },
      roadBindings: [{
        layerId: "inside",
        roadId: "missing"
      }]
    }),
    /unknown navigation road missing/
  );

  assert.throws(
    () => places.addPortal("hall", {
      id: "wrong-threshold",
      transitionCost: 1,
      a: {
        domainId,
        position: { x: 0, y: 0 },
        nodeId: "a",
        layerId: "inside"
      },
      b: {
        domainId,
        position: { x: 1, y: 0 },
        nodeId: "b",
        layerId: "inside"
      },
      roadBindings: [{
        layerId: "inside",
        roadId: "ac"
      }]
    }),
    /does not connect its endpoint nodes/
  );

  assert.equal(place.dynamicPortals.size, 0);
  assert.equal(places.stateRevision, beforeState);
  assert.equal(places.travelRevision, beforeTravel);
  places.assertInternalConsistency();
});

test("dynamic road bindings require a topology-backed owner layer", () => {
  const places = new PlaceRegistry();
  places.registerDefinition({
    id: "no-topology-dynamic",
    layers: [{ spatialMode: "owned", id: "inside" }]
  });
  const place = places.createPlace({
    id: "hall",
    definitionId: "no-topology-dynamic"
  });
  const domainId = place.layerDomains.get("inside");

  assert.throws(
    () => places.addPortal("hall", {
      id: "bad-binding",
      a: {
        domainId,
        position: { x: 0, y: 0 }
      },
      b: {
        domainId: "outside",
        position: { x: 0, y: 0 }
      },
      roadBindings: [{
        layerId: "inside",
        roadId: "road"
      }]
    }),
    /road binding requires navigation topology/
  );
});


test("same-domain attachment binding must connect the actual resolved endpoint nodes", () => {
  const places = new PlaceRegistry();
  places.registerDefinition({
    id: "attachment-threshold-integrity",
    layers: [{
      spatialMode: "owned",
      id: "inside",
      navigation: {
        nodes: [
          { id: "a", x: 0, y: 0 },
          { id: "b", x: 1, y: 0 },
          { id: "c", x: 0, y: 1 }
        ],
        roads: [
          { id: "ab", from: "a", to: "b" },
          { id: "ac", from: "a", to: "c" }
        ]
      }
    }],
    portals: [{
      id: "door",
      a: { kind: "external", slot: "outside" },
      b: {
        kind: "local",
        layerId: "inside",
        position: { x: 1, y: 0 },
        nodeId: "b"
      },
      roadBindings: [{
        layerId: "inside",
        roadId: "ac"
      }]
    }]
  });

  const place = places.createPlace({
    id: "hall",
    definitionId: "attachment-threshold-integrity"
  });
  const domainId = place.layerDomains.get("inside");
  const beforeState = places.stateRevision;
  const beforeTravel = places.travelRevision;

  assert.throws(
    () => places.setAttachment("hall", "outside", {
      domainId,
      position: { x: 0, y: 0 },
      nodeId: "a"
    }),
    /does not connect its endpoint nodes/
  );

  assert.equal(place.attachments.has("outside"), false);
  assert.equal(places.stateRevision, beforeState);
  assert.equal(places.travelRevision, beforeTravel);
  places.assertInternalConsistency();
});

test("same-domain attachment with a threshold binding requires both endpoint node IDs", () => {
  const places = new PlaceRegistry();
  places.registerDefinition({
    id: "attachment-threshold-node-ids",
    layers: [{
      spatialMode: "owned",
      id: "inside",
      navigation: {
        nodes: [
          { id: "a", x: 0, y: 0 },
          { id: "b", x: 1, y: 0 }
        ],
        roads: [{
          id: "ab",
          from: "a",
          to: "b"
        }]
      }
    }],
    portals: [{
      id: "door",
      a: { kind: "external", slot: "outside" },
      b: {
        kind: "local",
        layerId: "inside",
        position: { x: 1, y: 0 },
        nodeId: "b"
      },
      roadBindings: [{
        layerId: "inside",
        roadId: "ab"
      }]
    }]
  });

  const place = places.createPlace({
    id: "hall",
    definitionId: "attachment-threshold-node-ids"
  });
  const domainId = place.layerDomains.get("inside");

  assert.throws(
    () => places.setAttachment("hall", "outside", {
      domainId,
      position: { x: 0, y: 0 }
    }),
    /requires nodeId on both endpoints/
  );

  assert.equal(place.attachments.has("outside"), false);
});

test("bidirectional portal rejects a one-way threshold road", () => {
  assert.throws(
    () => compilePlace({
      id: "bad-bidirectional-threshold",
      layers: [{
        spatialMode: "owned",
        id: "inside",
        navigation: {
          nodes: [
            { id: "a", x: 0, y: 0 },
            { id: "b", x: 1, y: 0 }
          ],
          roads: [{
            id: "ab",
            from: "a",
            to: "b",
            bidirectional: false
          }]
        }
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
          roadId: "ab"
        }]
      }]
    }),
    /bidirectional but its threshold roads do not allow traversal from endpoint b to a/
  );
});

test("unidirectional portal rejects a threshold road that permits reverse traversal", () => {
  assert.throws(
    () => compilePlace({
      id: "bad-one-way-threshold",
      layers: [{
        spatialMode: "owned",
        id: "inside",
        navigation: {
          nodes: [
            { id: "a", x: 0, y: 0 },
            { id: "b", x: 1, y: 0 }
          ],
          roads: [{
            id: "ab",
            from: "a",
            to: "b",
            bidirectional: true
          }]
        }
      }],
      portals: [{
        id: "gate",
        bidirectional: false,
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
          roadId: "ab"
        }]
      }]
    }),
    /unidirectional but its threshold roads allow reverse traversal/
  );
});

test("bidirectional portal can use opposite one-way threshold roads", () => {
  const definition = compilePlace({
    id: "paired-one-way-thresholds",
    layers: [{
      spatialMode: "owned",
      id: "inside",
      navigation: {
        nodes: [
          { id: "a", x: 0, y: 0 },
          { id: "b", x: 1, y: 0 }
        ],
        roads: [
          {
            id: "ab",
            from: "a",
            to: "b",
            bidirectional: false
          },
          {
            id: "ba",
            from: "b",
            to: "a",
            bidirectional: false
          }
        ]
      }
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
      roadBindings: [
        { layerId: "inside", roadId: "ab" },
        { layerId: "inside", roadId: "ba" }
      ]
    }]
  });

  assert.equal(definition.getPortal("door").bidirectional, true);
});
