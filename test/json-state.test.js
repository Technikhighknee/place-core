import test from "node:test";
import assert from "node:assert/strict";

import {
  PlaceRegistry,
  compilePlace,
  serializePlaceCore,
  deserializePlaceCore,
  startTravel
} from "../src/index.js";

function simpleDefinition(extra = {}) {
  return {
    id: "json-place",
    layers: [{ id: "inside" }],
    anchors: [{
      id: "target",
      layerId: "inside",
      position: { x: 1, y: 0 },
      nodeId: "target"
    }],
    ...extra
  };
}

test("numeric IDs must be finite", () => {
  const places = new PlaceRegistry();
  places.registerDefinition(compilePlace(simpleDefinition()));

  assert.throws(
    () => places.createPlace({
      id: Number.NaN,
      definitionId: "json-place"
    }),
    /finite number/
  );

  assert.throws(
    () => places.createPlace({
      id: Number.POSITIVE_INFINITY,
      definitionId: "json-place"
    }),
    /finite number/
  );
});

test("definition metadata rejects non-JSON objects immediately", () => {
  assert.throws(
    () => compilePlace(simpleDefinition({
      metadata: new Date("1400-01-01T00:00:00Z")
    })),
    /non-JSON object Date/
  );

  assert.throws(
    () => compilePlace(simpleDefinition({
      metadata: new Map([["key", "value"]])
    })),
    /non-JSON object Map/
  );
});

test("instance and attachment metadata reject non-JSON values", () => {
  const places = new PlaceRegistry();
  places.registerDefinition(compilePlace(simpleDefinition()));

  assert.throws(
    () => places.createPlace({
      id: "bad-instance",
      definitionId: "json-place",
      metadata: { value: 1n }
    }),
    /bigint/
  );

  assert.throws(
    () => places.createPlace({
      id: "bad-attachment",
      definitionId: "json-place",
      attachments: {
        outside: {
          domainId: "outside",
          position: { x: 0, y: 0 },
          metadata: { missing: undefined }
        }
      }
    }),
    /undefined/
  );
});

test("travel journey options reject state that cannot survive snapshots", () => {
  const places = new PlaceRegistry();
  places.registerDefinition(compilePlace(simpleDefinition()));
  const place = places.createPlace({
    id: "house",
    definitionId: "json-place"
  });

  const entity = {
    id: "hans",
    domainId: place.layerDomains.get("inside"),
    position: { x: 0, y: 0 },
    mobility: { speed: 1 },
    journey: null
  };
  const bridge = {
    getEntity() { return entity; },
    planLocalRoute() { return { estimatedSeconds: 1 }; },
    startLocalJourney() { return true; },
    stopLocalJourney() {},
    transferEntity() {}
  };

  assert.throws(
    () => startTravel(
      places,
      bridge,
      "hans",
      { placeId: "house", anchorId: "target" },
      { journeyOptions: { opaque: new Set(["x"]) } }
    ),
    /non-JSON object Set/
  );
});

test("nested JSON metadata roundtrips without semantic drift", () => {
  const places = new PlaceRegistry();
  places.registerDefinition(compilePlace(simpleDefinition({
    metadata: {
      era: 1400,
      labels: ["house", "urban"],
      nested: {
        enabled: true,
        nullable: null
      }
    }
  })));

  places.createPlace({
    id: "house",
    definitionId: "json-place",
    metadata: {
      ownerRef: "person-17",
      flags: [true, false],
      nested: { value: 42 }
    }
  });

  const snapshot = JSON.parse(JSON.stringify(serializePlaceCore(places)));
  const restored = deserializePlaceCore(snapshot);

  assert.deepEqual(
    restored.getDefinition("json-place").metadata,
    {
      era: 1400,
      labels: ["house", "urban"],
      nested: {
        enabled: true,
        nullable: null
      }
    }
  );
  assert.deepEqual(
    restored.getPlace("house").metadata,
    {
      ownerRef: "person-17",
      flags: [true, false],
      nested: { value: 42 }
    }
  );
});


test("JSON metadata preserves own __proto__ keys without prototype mutation", () => {
  const metadata = JSON.parse(
    '{"__proto__":{"polluted":true},"safe":1}'
  );

  const compiled = compilePlace(simpleDefinition({
    metadata
  }));
  const restored = compiled.getBlueprint().metadata;

  assert.equal(Object.hasOwn(restored, "__proto__"), true);
  assert.deepEqual(restored.__proto__, { polluted: true });
  assert.equal(Object.getPrototypeOf(restored), Object.prototype);
  assert.equal(restored.polluted, undefined);

  const withoutProto = compilePlace(simpleDefinition({
    metadata: { safe: 1 }
  }));
  assert.notEqual(compiled.contentHash, withoutProto.contentHash);
});

test("cyclic JSON metadata is rejected explicitly", () => {
  const metadata = { name: "cycle" };
  metadata.self = metadata;

  assert.throws(
    () => compilePlace(simpleDefinition({ metadata })),
    /circular/i
  );
});


test("deep acyclic JSON metadata does not depend on the JavaScript call stack", () => {
  let metadata = null;
  const depth = 20_000;

  for (let i = 0; i < depth; i += 1) {
    metadata = { next: metadata };
  }

  const compiled = compilePlace(
    simpleDefinition({ metadata })
  );

  assert.equal(
    typeof compiled.contentHash,
    "string"
  );
  assert.equal(
    compiled.contentHash.length,
    64
  );
});
