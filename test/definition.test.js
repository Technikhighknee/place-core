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


test("same-domain portal road bindings must connect the portal endpoint nodes", () => {
  const valid = {
    id: "threshold-place",
    layers: [{
      id: "inside",
      navigation: {
        nodes: [
          { id: "left", x: 0, y: 0 },
          { id: "right", x: 1, y: 0 },
          { id: "other", x: 2, y: 0 }
        ],
        roads: [
          { id: "threshold", from: "left", to: "right", width: 1 },
          { id: "wrong", from: "right", to: "other", width: 1 }
        ]
      }
    }],
    portals: [{
      id: "door",
      a: {
        kind: "local",
        layerId: "inside",
        position: { x: 0, y: 0 },
        nodeId: "left"
      },
      b: {
        kind: "local",
        layerId: "inside",
        position: { x: 1, y: 0 },
        nodeId: "right"
      },
      roadBindings: [{
        layerId: "inside",
        roadId: "threshold"
      }]
    }]
  };

  assert.doesNotThrow(() => compilePlace(valid));

  const invalid = structuredClone(valid);
  invalid.portals[0].roadBindings[0].roadId = "wrong";

  assert.throws(
    () => compilePlace(invalid),
    /does not connect its endpoint nodes/
  );
});


test("same-domain room portals require unique threshold roads", () => {
  const base = {
    id: "room-thresholds",
    layers: [{
      id: "inside",
      navigation: {
        nodes: [
          { id: "a", x: 0, y: 0 },
          { id: "b", x: 1, y: 0 },
          { id: "c", x: 2, y: 0 }
        ],
        roads: [
          { id: "ab", from: "a", to: "b", width: 1 },
          { id: "bc", from: "b", to: "c", width: 1 }
        ]
      }
    }],
    spaces: [
      {
        id: "left",
        layerId: "inside",
        geometry: { type: "aabb", minX: -1, minY: -1, maxX: 0.5, maxY: 1 }
      },
      {
        id: "right",
        layerId: "inside",
        geometry: { type: "aabb", minX: 0.5, minY: -1, maxX: 3, maxY: 1 }
      }
    ],
    portals: [{
      id: "door",
      a: {
        kind: "local",
        layerId: "inside",
        spaceId: "left",
        position: { x: 0, y: 0 },
        nodeId: "a"
      },
      b: {
        kind: "local",
        layerId: "inside",
        spaceId: "right",
        position: { x: 1, y: 0 },
        nodeId: "b"
      },
      roadBindings: [{
        layerId: "inside",
        roadId: "ab"
      }]
    }]
  };

  assert.doesNotThrow(() => compilePlace(base));

  const missing = structuredClone(base);
  missing.portals[0].roadBindings = [];
  assert.throws(
    () => compilePlace(missing),
    /requires a threshold road binding/
  );

  const duplicate = structuredClone(base);
  duplicate.portals.push({
    ...structuredClone(duplicate.portals[0]),
    id: "second-door"
  });
  assert.throws(
    () => compilePlace(duplicate),
    /bound as a threshold by multiple portals/
  );
});

test("unidirectional same-domain portals require one-way a-to-b threshold roads", () => {
  const make = (road) => ({
    id: "one-way-threshold",
    layers: [{
      id: "inside",
      navigation: {
        nodes: [
          { id: "a", x: 0, y: 0 },
          { id: "b", x: 1, y: 0 }
        ],
        roads: [{ id: "door-road", width: 1, ...road }]
      }
    }],
    portals: [{
      id: "door",
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
        roadId: "door-road"
      }]
    }]
  });

  assert.doesNotThrow(() => compilePlace(make({
    from: "a",
    to: "b",
    bidirectional: false
  })));

  assert.throws(
    () => compilePlace(make({
      from: "a",
      to: "b",
      bidirectional: true
    })),
    /unidirectional but its threshold roads allow reverse traversal/
  );

  assert.throws(
    () => compilePlace(make({
      from: "b",
      to: "a",
      bidirectional: false
    })),
    /threshold roads do not allow traversal from endpoint a to b/
  );
});


test("generated topology IDs escape definition and layer delimiters", () => {
  const a = compilePlace({
    id: "a:b",
    layers: [{
      id: "c",
      navigation: {
        nodes: [{ id: "n", x: 0, y: 0 }],
        roads: []
      }
    }]
  });

  const b = compilePlace({
    id: "a",
    layers: [{
      id: "b:c",
      navigation: {
        nodes: [{ id: "n", x: 0, y: 0 }],
        roads: []
      }
    }]
  });

  assert.equal(a.layers[0].topologyId, "a%3Ab:c");
  assert.equal(b.layers[0].topologyId, "a:b%3Ac");
  assert.notEqual(a.layers[0].topologyId, b.layers[0].topologyId);
});

test("explicit topology IDs must be non-empty strings", () => {
  assert.throws(
    () => compilePlace({
      id: "bad-topology",
      layers: [{
        id: "ground",
        topologyId: "",
        navigation: {
          nodes: [{ id: "n", x: 0, y: 0 }],
          roads: []
        }
      }]
    }),
    /topologyId/
  );
});


test("authoring tag and profile fields require arrays of non-empty strings", () => {
  assert.throws(
    () => compilePlace({
      id: "bad-place-tags",
      tags: "building",
      layers: [{ id: "ground" }]
    }),
    /place\.tags must be an array/
  );

  assert.throws(
    () => compilePlace({
      id: "bad-space-tags",
      layers: [{ id: "ground" }],
      spaces: [{
        id: "room",
        layerId: "ground",
        tags: ["valid", ""],
        geometry: {
          type: "aabb",
          minX: 0,
          minY: 0,
          maxX: 1,
          maxY: 1
        }
      }]
    }),
    /space\(room\)\.tags\[1\]/
  );

  assert.throws(
    () => compilePlace({
      id: "bad-road-profiles",
      layers: [{
        id: "ground",
        navigation: {
          nodes: [
            { id: "a", x: 0, y: 0 },
            { id: "b", x: 1, y: 0 }
          ],
          roads: [{
            id: "road",
            from: "a",
            to: "b",
            allowedProfiles: "pedestrian"
          }]
        }
      }]
    }),
    /allowedProfiles must be an array/
  );

  const valid = compilePlace({
    id: "dedup-tags",
    tags: ["building", "building"],
    layers: [{
      id: "ground",
      tags: ["interior", "interior"],
      navigation: {
        nodes: [
          { id: "a", x: 0, y: 0 },
          { id: "b", x: 1, y: 0 }
        ],
        roads: [{
          id: "road",
          from: "a",
          to: "b",
          tags: ["threshold", "threshold"],
          allowedProfiles: ["pedestrian", "pedestrian"],
          blockedProfiles: ["cart"]
        }]
      }
    }]
  });

  assert.deepEqual(valid.tags, ["building"]);
  assert.deepEqual(valid.layers[0].tags, ["interior"]);
  assert.deepEqual(valid.layers[0].navigation.roads[0].tags, ["threshold"]);
  assert.deepEqual(
    valid.layers[0].navigation.roads[0].allowedProfiles,
    ["pedestrian"]
  );
});

test("space priority must be finite when supplied", () => {
  for (const priority of [
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY
  ]) {
    assert.throws(
      () => compilePlace({
        id: `bad-priority-${String(priority)}`,
        layers: [{ id: "ground" }],
        spaces: [{
          id: "room",
          layerId: "ground",
          priority,
          geometry: {
            type: "aabb",
            minX: 0,
            minY: 0,
            maxX: 1,
            maxY: 1
          }
        }]
      }),
      /priority must be a finite number/
    );
  }
});


test("embedded navigation rejects invalid world-core geometry fields at compile time", () => {
  const make = (nodePatch = {}, roadPatch = {}) => ({
    id: "nav-validation",
    layers: [{
      id: "inside",
      navigation: {
        nodes: [
          { id: "a", x: 0, y: 0, ...nodePatch },
          { id: "b", x: 1, y: 0 }
        ],
        roads: [{
          id: "road",
          from: "a",
          to: "b",
          ...roadPatch
        }]
      }
    }]
  });

  for (const junctionRadius of [
    -1,
    Number.NaN,
    Number.POSITIVE_INFINITY
  ]) {
    assert.throws(
      () => compilePlace(make({ junctionRadius })),
      /junctionRadius must be a finite number >= 0/
    );
  }

  for (const width of [
    0,
    -1,
    Number.NaN,
    Number.POSITIVE_INFINITY
  ]) {
    assert.throws(
      () => compilePlace(make({}, { width })),
      /width must be a finite number > 0/
    );
  }

  assert.throws(
    () => compilePlace(make({}, { surface: "" })),
    /surface/
  );
  assert.throws(
    () => compilePlace(make({}, { shape: "not-an-array" })),
    /shape must be an array/
  );
  assert.throws(
    () => compilePlace(make({}, {
      shape: [{ x: Number.NaN, y: 0 }]
    })),
    /shape\[0\] must be a finite Vec2/
  );
});

test("embedded navigation canonicalizes world-core defaults", () => {
  const omitted = compilePlace({
    id: "canonical-nav",
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
          to: "b"
        }]
      }
    }]
  });

  const explicit = compilePlace({
    id: "canonical-nav",
    layers: [{
      id: "inside",
      navigation: {
        nodes: [
          { id: "a", x: 0, y: 0, junctionRadius: 0 },
          { id: "b", x: 1, y: 0, junctionRadius: 0 }
        ],
        roads: [{
          id: "road",
          from: "a",
          to: "b",
          shape: [],
          width: 4,
          surface: "street",
          bidirectional: true,
          enabled: true,
          allowedProfiles: null,
          blockedProfiles: [],
          tags: []
        }]
      }
    }]
  });

  assert.equal(omitted.contentHash, explicit.contentHash);
  assert.deepEqual(
    omitted.layers[0].navigation.roads[0],
    explicit.layers[0].navigation.roads[0]
  );
});


test("definition identity canonicalizes top-level semantic defaults", () => {
  const omitted = compilePlace({
    id: "canonical-top-level",
    layers: [{ id: "ground" }]
  });

  const explicit = compilePlace({
    id: "canonical-top-level",
    kind: "place",
    tags: [],
    revision: 1,
    defaultAnchorId: null,
    layers: [{ id: "ground" }],
    spaces: [],
    boundaries: [],
    portals: [],
    anchors: [],
    footprint: null,
    metadata: null
  });

  assert.equal(omitted.contentHash, explicit.contentHash);
  assert.deepEqual(omitted.getBlueprint(), explicit.getBlueprint());
  assert.equal(omitted.revision, 1);
});

test("definition revision must be a non-empty string or finite number", () => {
  for (const revision of [
    "",
    Number.NaN,
    Number.POSITIVE_INFINITY,
    {},
    []
  ]) {
    assert.throws(
      () => compilePlace({
        id: "bad-revision",
        revision,
        layers: [{ id: "ground" }]
      }),
      /place\.revision/
    );
  }

  assert.equal(
    compilePlace({
      id: "string-revision",
      revision: "schema-v2",
      layers: [{ id: "ground" }]
    }).revision,
    "schema-v2"
  );
});

test("unknown top-level authoring fields are rejected", () => {
  assert.throws(
    () => compilePlace({
      id: "unknown-field-place",
      layers: [{ id: "ground" }],
      accidentalField: "ignored"
    }),
    /place contains unknown field accidentalField/
  );
});


test("definition authoring collections must be arrays", () => {
  const cases = [
    ["layers", "not-an-array"],
    ["spaces", {}],
    ["boundaries", "walls"],
    ["portals", {}],
    ["anchors", "targets"]
  ];

  for (const [field, value] of cases) {
    assert.throws(
      () => compilePlace({
        id: `bad-${field}`,
        [field]: value
      }),
      new RegExp(`place\\.${field} must be an array`)
    );
  }

  assert.throws(
    () => compilePlace({
      id: "bad-nav-arrays",
      layers: [{
        id: "inside",
        navigation: {
          nodes: {},
          roads: []
        }
      }]
    }),
    /navigation\.nodes must be an array/
  );

  assert.throws(
    () => compilePlace({
      id: "bad-bindings",
      layers: [{ id: "inside" }],
      boundaries: [{
        id: "wall",
        layerId: "inside",
        a: { x: 0, y: 0 },
        b: { x: 1, y: 0 },
        roadBindings: {}
      }]
    }),
    /roadBindings must be an array/
  );
});

test("all semantic kind fields require non-empty strings", () => {
  const mutations = [
    (blueprint) => { blueprint.layers[0].kind = 1; },
    (blueprint) => { blueprint.spaces[0].kind = ""; },
    (blueprint) => { blueprint.boundaries[0].kind = {}; },
    (blueprint) => { blueprint.portals[0].kind = 42; },
    (blueprint) => { blueprint.anchors[0].kind = []; }
  ];

  for (const mutate of mutations) {
    const blueprint = tavernBlueprint();
    mutate(blueprint);
    assert.throws(
      () => compilePlace(blueprint),
      /kind must be a non-empty string/
    );
  }
});

test("optional semantic reference IDs are type-checked even without navigation", () => {
  assert.throws(
    () => compilePlace({
      id: "bad-parent-id",
      layers: [{ id: "inside" }],
      spaces: [{
        id: "room",
        layerId: "inside",
        parentSpaceId: 123,
        geometry: {
          type: "aabb",
          minX: 0,
          minY: 0,
          maxX: 1,
          maxY: 1
        }
      }]
    }),
    /parentSpaceId must be a non-empty string/
  );

  assert.throws(
    () => compilePlace({
      id: "bad-anchor-node",
      layers: [{ id: "inside" }],
      anchors: [{
        id: "target",
        layerId: "inside",
        position: { x: 0, y: 0 },
        nodeId: 123
      }]
    }),
    /nodeId must be a non-empty string/
  );

  assert.throws(
    () => compilePlace({
      id: "bad-portal-node",
      layers: [{ id: "inside" }, { id: "other" }],
      portals: [{
        id: "stairs",
        a: {
          kind: "local",
          layerId: "inside",
          position: { x: 0, y: 0 },
          nodeId: {}
        },
        b: {
          kind: "local",
          layerId: "other",
          position: { x: 0, y: 0 }
        }
      }]
    }),
    /nodeId must be a non-empty string/
  );
});


test("embedded navigation options reject unknown fields and invalid bounds", () => {
  const make = (options) => ({
    id: "nav-options",
    layers: [{
      id: "inside",
      navigation: {
        options,
        nodes: [{ id: "a", x: 0, y: 0 }],
        roads: []
      }
    }]
  });

  assert.throws(
    () => compilePlace(make({ typoCacheSize: 10 })),
    /options contains unknown field typoCacheSize/
  );

  for (const spatialCellSize of [
    0,
    -1,
    Number.NaN,
    Number.POSITIVE_INFINITY
  ]) {
    assert.throws(
      () => compilePlace(make({ spatialCellSize })),
      /spatialCellSize must be a finite number > 0/
    );
  }

  for (const [key, value] of [
    ["routeCacheSize", -1],
    ["routeCacheMaxLegs", 1.5],
    ["routeCacheMaxTotalLegs", Number.NaN],
    ["hierarchicalRouteCacheSize", -1],
    ["regionalRouteCacheSize", Number.POSITIVE_INFINITY]
  ]) {
    assert.throws(
      () => compilePlace(make({ [key]: value })),
      new RegExp(`${key} must be an integer >= 0`)
    );
  }
});

test("embedded navigation option defaults are canonical definition identity", () => {
  const make = (options) => compilePlace({
    id: "nav-option-defaults",
    layers: [{
      id: "inside",
      navigation: {
        ...(options === undefined ? {} : { options }),
        nodes: [{ id: "a", x: 0, y: 0 }],
        roads: []
      }
    }]
  });

  const omitted = make(undefined);
  const explicit = make({
    spatialCellSize: 50,
    routeCacheSize: 5000,
    routeCacheMaxLegs: 256,
    routeCacheMaxTotalLegs: 100000,
    hierarchicalRouteCacheSize: 1000,
    regionalRouteCacheSize: 5000
  });

  assert.equal(omitted.contentHash, explicit.contentHash);
  assert.deepEqual(
    omitted.layers[0].navigation.options,
    explicit.layers[0].navigation.options
  );
});


test("static road bindings require a topology-backed layer", () => {
  assert.throws(
    () => compilePlace({
      id: "boundary-without-topology",
      layers: [{ id: "inside" }],
      boundaries: [{
        id: "wall",
        layerId: "inside",
        a: { x: 0, y: 0 },
        b: { x: 1, y: 0 },
        roadBindings: [{ roadId: "road" }]
      }]
    }),
    /road binding requires navigation topology/
  );

  assert.throws(
    () => compilePlace({
      id: "portal-without-topology",
      layers: [{ id: "inside" }, { id: "other" }],
      portals: [{
        id: "stairs",
        a: {
          kind: "local",
          layerId: "inside",
          position: { x: 0, y: 0 }
        },
        b: {
          kind: "local",
          layerId: "other",
          position: { x: 0, y: 0 }
        },
        roadBindings: [{
          layerId: "inside",
          roadId: "road"
        }]
      }]
    }),
    /road binding requires navigation topology/
  );

  assert.doesNotThrow(
    () => compilePlace({
      id: "externally-backed-topology",
      layers: [{
        id: "inside",
        topologyId: "external-topology"
      }],
      boundaries: [{
        id: "wall",
        layerId: "inside",
        a: { x: 0, y: 0 },
        b: { x: 1, y: 0 },
        roadBindings: [{ roadId: "external-road" }]
      }]
    })
  );
});


test("set-like definition fields are canonical across input order", () => {
  const make = ({
    placeTags,
    layerTags,
    roadTags,
    allowedProfiles,
    blockedProfiles
  }) => compilePlace({
    id: "canonical-set-order",
    tags: placeTags,
    layers: [{
      id: "inside",
      tags: layerTags,
      navigation: {
        nodes: [
          { id: "a", x: 0, y: 0 },
          { id: "b", x: 1, y: 0 }
        ],
        roads: [{
          id: "road",
          from: "a",
          to: "b",
          tags: roadTags,
          allowedProfiles,
          blockedProfiles
        }]
      }
    }]
  });

  const forward = make({
    placeTags: ["zeta", "alpha"],
    layerTags: ["upper", "inside"],
    roadTags: ["threshold", "interior"],
    allowedProfiles: ["pedestrian", "guard"],
    blockedProfiles: ["cart", "horse"]
  });
  const reverse = make({
    placeTags: ["alpha", "zeta"],
    layerTags: ["inside", "upper"],
    roadTags: ["interior", "threshold"],
    allowedProfiles: ["guard", "pedestrian"],
    blockedProfiles: ["horse", "cart"]
  });

  assert.equal(
    forward.contentHash,
    reverse.contentHash
  );
  assert.deepEqual(
    forward.getBlueprint(),
    reverse.getBlueprint()
  );
});


test("compiler rejects unknown blueprint fields at every structural layer", () => {
  assert.throws(
    () => compilePlace({
      id: "bad-top",
      layres: []
    }),
    /place contains unknown field layres/
  );

  assert.throws(
    () => compilePlace({
      id: "bad-layer",
      layers: [{
        id: "inside",
        metdata: {}
      }]
    }),
    /layer contains unknown field metdata/
  );

  assert.throws(
    () => compilePlace({
      id: "bad-nav",
      layers: [{
        id: "inside",
        navigation: {
          nodse: []
        }
      }]
    }),
    /navigation contains unknown field nodse/
  );

  assert.throws(
    () => compilePlace({
      id: "bad-node",
      layers: [{
        id: "inside",
        navigation: {
          nodes: [{
            id: "a",
            x: 0,
            y: 0,
            regioId: null
          }]
        }
      }]
    }),
    /nodes\[0\] contains unknown field regioId/
  );

  assert.throws(
    () => compilePlace({
      id: "bad-road",
      layers: [{
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
            bidirectionl: true
          }]
        }
      }]
    }),
    /roads\[0\] contains unknown field bidirectionl/
  );

  assert.throws(
    () => compilePlace({
      id: "bad-space",
      layers: [{ id: "inside" }],
      spaces: [{
        id: "room",
        layerId: "inside",
        geometry: {
          type: "aabb",
          minX: 0,
          minY: 0,
          maxX: 1,
          maxY: 1,
          maxZ: 1
        }
      }]
    }),
    /geometry contains unknown field maxZ/
  );

  assert.throws(
    () => compilePlace({
      id: "bad-portal",
      layers: [{ id: "inside" }],
      portals: [{
        id: "door",
        a: {
          layerId: "inside",
          position: { x: 0, y: 0 },
          postion: { x: 1, y: 0 }
        },
        b: {
          kind: "external",
          slot: "street"
        }
      }]
    }),
    /endpoint contains unknown field postion/
  );

  assert.throws(
    () => compilePlace({
      id: "bad-anchor",
      layers: [{ id: "inside" }],
      anchors: [{
        id: "center",
        layerId: "inside",
        position: {
          x: 0,
          y: 0,
          z: 0
        }
      }]
    }),
    /anchor\(center\)\.position contains unknown field z/
  );

  assert.throws(
    () => compilePlace(
      { id: "bad-options" },
      { spaceIndexCells: 4 }
    ),
    /compilePlace options contains unknown field spaceIndexCells/
  );
});


test("deep space containment does not depend on the JavaScript call stack", () => {
  const depth = 10_000;
  const spaces = [];

  for (let i = depth - 1; i >= 0; i -= 1) {
    spaces.push({
      id: `space-${i}`,
      layerId: "inside",
      parentSpaceId:
        i === 0
          ? null
          : `space-${i - 1}`,
      geometry: {
        type: "aabb",
        minX: 0,
        minY: 0,
        maxX: 1,
        maxY: 1
      }
    });
  }

  const compiled = compilePlace({
    id: "deep-spaces",
    layers: [{ id: "inside" }],
    spaces
  });

  assert.equal(
    compiled.getSpaceDepth(
      `space-${depth - 1}`
    ),
    depth - 1
  );
});
