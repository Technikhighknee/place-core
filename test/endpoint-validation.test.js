import test from "node:test";
import assert from "node:assert/strict";

import {
  PlaceRegistry,
  deserializePlaceCore,
  serializePlaceCore
} from "../src/index.js";

function basePlaces() {
  const places = new PlaceRegistry();
  places.registerDefinition({
    id: "endpoint-place",
    layers: [{ spatialMode: "owned", id: "inside" }]
  });
  const place = places.createPlace({
    id: "house",
    definitionId: "endpoint-place"
  });
  return { places, place };
}

test("live attachments enforce endpoint ID types", () => {
  const cases = [
    {
      value: {
        domainId: "outside",
        position: { x: 0, y: 0 },
        nodeId: 123
      },
      pattern: /nodeId/
    },
    {
      value: {
        domainId: "outside",
        position: { x: 0, y: 0 },
        placeId: {}
      },
      pattern: /placeId/
    },
    {
      value: {
        domainId: "outside",
        position: { x: 0, y: 0 },
        spaceId: 12
      },
      pattern: /spaceId/
    }
  ];

  for (const { value, pattern } of cases) {
    const { places } = basePlaces();
    assert.throws(
      () => places.setAttachment("house", "door", value),
      pattern
    );
    assert.equal(
      places.getPlace("house").attachments.has("door"),
      false
    );
  }
});

test("dynamic portal endpoint IDs are validated before mutation", () => {
  const { places, place } = basePlaces();
  const inside = place.layerDomains.get("inside");
  const stateRevision = places.stateRevision;
  const travelRevision = places.travelRevision;

  const invalidEndpoints = [
    {
      nodeId: 1,
      pattern: /nodeId/
    },
    {
      placeId: {},
      pattern: /placeId/
    },
    {
      spaceId: 1,
      pattern: /spaceId/
    },
    {
      layerId: 1,
      pattern: /layerId/
    }
  ];

  for (const { pattern, ...patch } of invalidEndpoints) {
    assert.throws(
      () => places.addPortal("house", {
        id: `bad-${Object.keys(patch)[0]}`,
        a: {
          domainId: inside,
          position: { x: 0, y: 0 },
          ...patch
        },
        b: {
          domainId: "outside",
          position: { x: 0, y: 0 }
        }
      }),
      pattern
    );
  }

  assert.equal(place.dynamicPortals.size, 0);
  assert.equal(places.stateRevision, stateRevision);
  assert.equal(places.travelRevision, travelRevision);
});

test("dynamic portal kind must be a non-empty string", () => {
  const { places, place } = basePlaces();
  const inside = place.layerDomains.get("inside");

  assert.throws(
    () => places.addPortal("house", {
      id: "bad-kind",
      kind: 42,
      a: {
        domainId: inside,
        position: { x: 0, y: 0 }
      },
      b: {
        domainId: "outside",
        position: { x: 0, y: 0 }
      }
    }),
    /kind/
  );

  assert.equal(place.dynamicPortals.size, 0);
});

test("dynamic endpoint metadata survives snapshot roundtrip", () => {
  const { places, place } = basePlaces();
  const inside = place.layerDomains.get("inside");

  const added = places.addPortal("house", {
    id: "annotated",
    a: {
      domainId: inside,
      position: { x: 0, y: 0 },
      metadata: {
        semanticSide: "inside",
        nested: { value: 17 }
      }
    },
    b: {
      domainId: "outside",
      position: { x: 10, y: 0 },
      metadata: {
        semanticSide: "outside"
      }
    }
  });

  assert.deepEqual(added.a.metadata, {
    semanticSide: "inside",
    nested: { value: 17 }
  });
  assert.deepEqual(added.b.metadata, {
    semanticSide: "outside"
  });

  const restored = deserializePlaceCore(
    JSON.parse(JSON.stringify(serializePlaceCore(places)))
  );
  const portal = restored.resolvePortal("house", "annotated");

  assert.deepEqual(portal.a.metadata, {
    semanticSide: "inside",
    nested: { value: 17 }
  });
  assert.deepEqual(portal.b.metadata, {
    semanticSide: "outside"
  });
});

test("endpoint metadata is JSON-safe at the live API boundary", () => {
  const { places, place } = basePlaces();
  const inside = place.layerDomains.get("inside");

  assert.throws(
    () => places.addPortal("house", {
      id: "bad-metadata",
      a: {
        domainId: inside,
        position: { x: 0, y: 0 },
        metadata: new Map([["x", 1]])
      },
      b: {
        domainId: "outside",
        position: { x: 0, y: 0 }
      }
    }),
    /non-JSON object Map/
  );

  assert.equal(place.dynamicPortals.size, 0);
});


test("static local endpoint metadata survives resolve and snapshot roundtrip", () => {
  const places = new PlaceRegistry();
  places.registerDefinition({
    id: "static-endpoint-metadata",
    layers: [{ spatialMode: "owned", id: "inside" }],
    portals: [{
      id: "door",
      a: {
        kind: "external",
        slot: "outside"
      },
      b: {
        kind: "local",
        layerId: "inside",
        position: { x: 0, y: 0 },
        metadata: {
          semanticSide: "inside",
          marker: { value: 7 }
        }
      }
    }]
  });

  places.createPlace({
    id: "house",
    definitionId: "static-endpoint-metadata",
    attachments: {
      outside: {
        domainId: "street",
        position: { x: 10, y: 0 },
        metadata: {
          semanticSide: "outside"
        }
      }
    }
  });

  let portal = places.resolvePortal("house", "door");
  assert.deepEqual(portal.a.metadata, {
    semanticSide: "outside"
  });
  assert.deepEqual(portal.b.metadata, {
    semanticSide: "inside",
    marker: { value: 7 }
  });

  const restored = deserializePlaceCore(
    JSON.parse(JSON.stringify(serializePlaceCore(places)))
  );
  portal = restored.resolvePortal("house", "door");

  assert.deepEqual(portal.a.metadata, {
    semanticSide: "outside"
  });
  assert.deepEqual(portal.b.metadata, {
    semanticSide: "inside",
    marker: { value: 7 }
  });
});
