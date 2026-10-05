import test from "node:test";
import assert from "node:assert/strict";

import {
  PlaceRegistry,
  serializePlaceCore,
  deserializePlaceCore
} from "../src/index.js";

function definition() {
  return {
    id: "road-index-place",
    layers: [{
      spatialMode: "owned",
      id: "inside",
      navigation: {
        nodes: [
          { id: "left", x: 0, y: 0 },
          { id: "right", x: 1, y: 0 }
        ],
        roads: [{
          id: "threshold",
          from: "left",
          to: "right",
          width: 1
        }]
      }
    }],
    portals: [{
      id: "room-door",
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
}

test("portal road bindings are indexed by concrete domain", () => {
  const places = new PlaceRegistry();
  places.registerDefinition(definition());

  const a = places.createPlace({
    id: "a",
    definitionId: "road-index-place"
  });
  const b = places.createPlace({
    id: "b",
    definitionId: "road-index-place"
  });

  const aDomain = a.layerDomains.get("inside");
  const bDomain = b.layerDomains.get("inside");

  assert.deepEqual(
    places.getPortalsForRoad(aDomain, "threshold").map((p) => p.instanceId),
    ["a"]
  );
  assert.deepEqual(
    places.getPortalsForRoad(bDomain, "threshold").map((p) => p.instanceId),
    ["b"]
  );

  const diagnostics = places.getDiagnostics();
  assert.equal(diagnostics.portalRoadBindingCount, 2);
  assert.equal(diagnostics.portalRoadDomainCount, 2);
  places.assertInternalConsistency();
});

test("portal road index follows dynamic state reindex and removal", () => {
  const places = new PlaceRegistry();
  places.registerDefinition(definition());

  const place = places.createPlace({
    id: "house",
    definitionId: "road-index-place"
  });
  const domain = place.layerDomains.get("inside");

  assert.equal(places.getPortalsForRoad(domain, "threshold").length, 1);

  places.setPortalState("house", "room-door", { locked: true });
  assert.equal(places.getPortalsForRoad(domain, "threshold").length, 1);
  assert.equal(
    places.getPortalsForRoad(domain, "threshold")[0].traversable,
    false
  );

  places.removePlace("house");
  assert.deepEqual(places.getPortalsForRoad(domain, "threshold"), []);
  assert.equal(places.getDiagnostics().portalRoadBindingCount, 0);
  assert.equal(places.getDiagnostics().portalRoadDomainCount, 0);
  places.assertInternalConsistency();
});


test("dynamic same-domain portals cannot share an existing threshold road", () => {
  const places = new PlaceRegistry();
  places.registerDefinition(definition());

  const place = places.createPlace({
    id: "house",
    definitionId: "road-index-place"
  });
  const domain = place.layerDomains.get("inside");

  assert.throws(
    () => places.addPortal("house", {
      id: "duplicate-threshold",
      a: {
        domainId: domain,
        position: { x: 0, y: 0 },
        nodeId: "left"
      },
      b: {
        domainId: domain,
        position: { x: 1, y: 0 },
        nodeId: "right"
      },
      roadBindings: [{
        layerId: "inside",
        roadId: "threshold"
      }]
    }),
    /already bound as a threshold/
  );

  assert.equal(
    places.getPortalsForRoad(
      domain,
      "threshold"
    ).length,
    1
  );
  places.assertInternalConsistency();
});


test("dynamic portal road bindings reject duplicates", () => {
  const places = new PlaceRegistry();
  places.registerDefinition(definition());
  const place = places.createPlace({
    id: "house",
    definitionId: "road-index-place"
  });
  const domain =
    place.layerDomains.get("inside");

  assert.throws(
    () =>
      places.addPortal("house", {
        id: "duplicate-binding",
        a: {
          domainId: domain,
          position: { x: 0, y: 0 },
          nodeId: "left"
        },
        b: {
          domainId: domain,
          position: { x: 1, y: 0 },
          nodeId: "right"
        },
        roadBindings: [
          {
            layerId: "inside",
            roadId: "threshold"
          },
          {
            layerId: "inside",
            roadId: "threshold"
          }
        ]
      }),
    /duplicate road binding/
  );
});


test("snapshot validation preserves NUL-safe portal road binding pairs", () => {
  const places =
    new PlaceRegistry();

  places.registerDefinition({
    id: "snapshot-nul-binding-place",
    layers: [
      {
        spatialMode: "owned",
        id: "a\u0000b",
        navigation: {
          nodes: [
            { id: "left", x: 0, y: 0 },
            { id: "right", x: 1, y: 0 }
          ],
          roads: [{
            id: "c",
            from: "left",
            to: "right"
          }]
        }
      },
      {
        spatialMode: "owned",
        id: "a",
        navigation: {
          nodes: [
            { id: "left", x: 0, y: 0 },
            { id: "right", x: 1, y: 0 }
          ],
          roads: [{
            id: "b\u0000c",
            from: "left",
            to: "right"
          }]
        }
      }
    ]
  });

  const place =
    places.createPlace({
      id: "house",
      definitionId:
        "snapshot-nul-binding-place"
    });

  places.addPortal(
    place.id,
    {
      id: "cross-layer",
      a: {
        domainId:
          place.layerDomains.get(
            "a\u0000b"
          ),
        position: { x: 0, y: 0 },
        nodeId: "left"
      },
      b: {
        domainId:
          place.layerDomains.get("a"),
        position: { x: 1, y: 0 },
        nodeId: "right"
      },
      roadBindings: [
        {
          layerId: "a\u0000b",
          roadId: "c"
        },
        {
          layerId: "a",
          roadId: "b\u0000c"
        }
      ]
    }
  );

  const restored =
    deserializePlaceCore(
      serializePlaceCore(places)
    );

  assert.equal(
    restored.resolvePortal(
      "house",
      "cross-layer"
    )?.roadBindings.length,
    2
  );
  restored.assertInternalConsistency();
});


test("compiled portal road binding keys do not collide on embedded NUL characters", () => {
  const places =
    new PlaceRegistry();

  assert.doesNotThrow(
    () =>
      places.registerDefinition({
        id: "compiled-nul-binding-place",
        layers: [
          {
            spatialMode: "owned",
            id: "a\u0000b",
            navigation: {
              nodes: [
                { id: "left", x: 0, y: 0 },
                { id: "right", x: 1, y: 0 }
              ],
              roads: [{
                id: "c",
                from: "left",
                to: "right"
              }]
            }
          },
          {
            spatialMode: "owned",
            id: "a",
            navigation: {
              nodes: [
                { id: "left", x: 0, y: 0 },
                { id: "right", x: 1, y: 0 }
              ],
              roads: [{
                id: "b\u0000c",
                from: "left",
                to: "right"
              }]
            }
          }
        ],
        portals: [{
          id: "cross-layer",
          a: {
            kind: "local",
            layerId: "a\u0000b",
            position: { x: 0, y: 0 },
            nodeId: "left"
          },
          b: {
            kind: "local",
            layerId: "a",
            position: { x: 1, y: 0 },
            nodeId: "right"
          },
          roadBindings: [
            {
              layerId: "a\u0000b",
              roadId: "c"
            },
            {
              layerId: "a",
              roadId: "b\u0000c"
            }
          ]
        }]
      })
  );

  const place =
    places.createPlace({
      id: "house",
      definitionId:
        "compiled-nul-binding-place"
    });

  assert.equal(
    places.resolvePortal(
      place.id,
      "cross-layer"
    )?.roadBindings.length,
    2
  );
  places.assertInternalConsistency();
});


test("dynamic portal road binding keys do not collide on embedded NUL characters", () => {
  const places =
    new PlaceRegistry();

  places.registerDefinition({
    id: "nul-binding-place",
    layers: [
      {
        spatialMode: "owned",
        id: "a\u0000b",
        navigation: {
          nodes: [
            {
              id: "left",
              x: 0,
              y: 0
            },
            {
              id: "right",
              x: 1,
              y: 0
            }
          ],
          roads: [{
            id: "c",
            from: "left",
            to: "right"
          }]
        }
      },
      {
        spatialMode: "owned",
        id: "a",
        navigation: {
          nodes: [
            {
              id: "left",
              x: 0,
              y: 0
            },
            {
              id: "right",
              x: 1,
              y: 0
            }
          ],
          roads: [{
            id: "b\u0000c",
            from: "left",
            to: "right"
          }]
        }
      }
    ]
  });

  const place =
    places.createPlace({
      id: "house",
      definitionId:
        "nul-binding-place"
    });

  assert.doesNotThrow(
    () =>
      places.addPortal(
        "house",
        {
          id: "cross-layer",
          a: {
            domainId:
              place.layerDomains.get(
                "a\u0000b"
              ),
            position: {
              x: 0,
              y: 0
            },
            nodeId: "left"
          },
          b: {
            domainId:
              place.layerDomains.get(
                "a"
              ),
            position: {
              x: 1,
              y: 0
            },
            nodeId: "right"
          },
          roadBindings: [
            {
              layerId: "a\u0000b",
              roadId: "c"
            },
            {
              layerId: "a",
              roadId: "b\u0000c"
            }
          ]
        }
      )
  );

  assert.equal(
    place.dynamicPortals
      .get("cross-layer")
      ?.roadBindings.length,
    2
  );
  places.assertInternalConsistency();
});


test("distinct portal thresholds may share the same navigation node", () => {
  const places = new PlaceRegistry();
  places.registerDefinition({
    id: "shared-threshold-node",
    layers: [{
      spatialMode: "owned",
      id: "ground",
      navigation: {
        nodes: [
          { id: "west", x: -1, y: 0 },
          { id: "street", x: 0, y: 0 },
          { id: "east", x: 1, y: 0 }
        ],
        roads: [
          {
            id: "west-threshold",
            from: "west",
            to: "street",
            width: 1
          },
          {
            id: "east-threshold",
            from: "street",
            to: "east",
            width: 1
          }
        ]
      }
    }],
    portals: [
      {
        id: "west-door",
        a: {
          kind: "local",
          layerId: "ground",
          position: { x: -1, y: 0 },
          nodeId: "west"
        },
        b: {
          kind: "local",
          layerId: "ground",
          position: { x: 0, y: 0 },
          nodeId: "street"
        },
        transitionCost: 1,
        roadBindings: [{
          layerId: "ground",
          roadId: "west-threshold"
        }]
      },
      {
        id: "east-door",
        a: {
          kind: "local",
          layerId: "ground",
          position: { x: 0, y: 0 },
          nodeId: "street"
        },
        b: {
          kind: "local",
          layerId: "ground",
          position: { x: 1, y: 0 },
          nodeId: "east"
        },
        transitionCost: 1,
        roadBindings: [{
          layerId: "ground",
          roadId: "east-threshold"
        }]
      }
    ]
  });

  const place = places.createPlace({
    id: "street-place",
    definitionId: "shared-threshold-node"
  });
  const domainId =
    place.layerDomains.get("ground");

  assert.equal(
    places.getPortalsForRoad(
      domainId,
      "west-threshold"
    )[0]?.id,
    "west-door"
  );
  assert.equal(
    places.getPortalsForRoad(
      domainId,
      "east-threshold"
    )[0]?.id,
    "east-door"
  );
  places.assertInternalConsistency();
});
