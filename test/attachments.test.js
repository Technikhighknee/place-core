import test from "node:test";
import assert from "node:assert/strict";

import {
  PlaceRegistry,
  serializePlaceCore,
  deserializePlaceCore
} from "../src/index.js";

function buildingDefinition() {
  return {
    id: "detachable-building",
    layers: [{ id: "inside" }],
    spaces: [{
      id: "room",
      layerId: "inside",
      geometry: { type: "aabb", minX: 0, minY: 0, maxX: 5, maxY: 5 }
    }],
    portals: [{
      id: "front-door",
      kind: "door",
      a: { kind: "external", slot: "street" },
      b: {
        kind: "local",
        layerId: "inside",
        spaceId: "room",
        position: { x: 0, y: 2.5 },
        nodeId: "door"
      }
    }]
  };
}

function attachmentThresholdDefinition() {
  return {
    id: "attachment-thresholds",
    layers: [{
      id: "inside",
      navigation: {
        nodes: [
          { id: "street", x: 0, y: 0 },
          { id: "door", x: 1, y: 0 }
        ],
        roads: [{
          id: "threshold",
          from: "street",
          to: "door",
          width: 1
        }]
      }
    }],
    portals: [
      {
        id: "door-one",
        a: {
          kind: "external",
          slot: "one"
        },
        b: {
          kind: "local",
          layerId: "inside",
          position: { x: 1, y: 0 },
          nodeId: "door"
        },
        transitionCost: 1,
        roadBindings: [{
          layerId: "inside",
          roadId: "threshold"
        }]
      },
      {
        id: "door-two",
        a: {
          kind: "external",
          slot: "two"
        },
        b: {
          kind: "local",
          layerId: "inside",
          position: { x: 1, y: 0 },
          nodeId: "door"
        },
        transitionCost: 1,
        roadBindings: [{
          layerId: "inside",
          roadId: "threshold"
        }]
      }
    ]
  };
}


test("attachment-resolved same-domain portals cannot share a threshold road", () => {
  const places = new PlaceRegistry();
  places.registerDefinition(
    attachmentThresholdDefinition()
  );
  const place = places.createPlace({
    id: "house",
    definitionId: "attachment-thresholds"
  });
  const domainId =
    place.layerDomains.get("inside");

  places.setAttachment(
    "house",
    "one",
    {
      domainId,
      position: { x: 0, y: 0 },
      nodeId: "street"
    }
  );

  assert.throws(
    () =>
      places.setAttachment(
        "house",
        "two",
        {
          domainId,
          position: { x: 0, y: 0 },
          nodeId: "street"
        }
      ),
    /already bound as a threshold/
  );

  assert.equal(
    place.attachments.has("two"),
    false
  );
  assert.deepEqual(
    places.getPortalsForRoad(
      domainId,
      "threshold"
    ).map((portal) => portal.id),
    ["door-one"]
  );
  places.assertInternalConsistency();
});

test("place creation rejects attachment-resolved duplicate threshold ownership", () => {
  const places = new PlaceRegistry();
  places.registerDefinition(
    attachmentThresholdDefinition()
  );

  assert.throws(
    () =>
      places.createPlace({
        id: "house",
        definitionId:
          "attachment-thresholds",
        layerDomains: {
          inside: "shared-inside"
        },
        attachments: {
          one: {
            domainId: "shared-inside",
            position: { x: 0, y: 0 },
            nodeId: "street"
          },
          two: {
            domainId: "shared-inside",
            position: { x: 0, y: 0 },
            nodeId: "street"
          }
        }
      }),
    /already bound as a threshold/
  );

  assert.equal(
    places.getPlace("house"),
    null
  );
  places.assertInternalConsistency();
});

test("places can exist with unbound external portal slots", () => {
  const places = new PlaceRegistry();
  places.registerDefinition(buildingDefinition());

  const building = places.createPlace({
    id: "house",
    definitionId: "detachable-building"
  });

  const portal = places.resolvePortal("house", "front-door");
  assert.equal(portal.connected, false);
  assert.equal(portal.traversable, false);
  assert.equal(portal.a, null);
  assert.equal(portal.b.domainId, building.layerDomains.get("inside"));
  assert.deepEqual(
    places.getPortalsForDomain(building.layerDomains.get("inside")),
    []
  );
  places.assertInternalConsistency();
});

test("attachment connect and disconnect atomically updates portal adjacency", () => {
  const places = new PlaceRegistry({ captureEvents: true });
  places.registerDefinition(buildingDefinition());
  const building = places.createPlace({
    id: "wagon",
    definitionId: "detachable-building"
  });
  const inside = building.layerDomains.get("inside");

  places.setAttachment("wagon", "street", {
    domainId: "road",
    position: { x: 50, y: 10 },
    nodeId: "wagon-stop"
  });

  let portal = places.resolvePortal("wagon", "front-door");
  assert.equal(portal.connected, true);
  assert.equal(portal.traversable, true);
  assert.equal(places.getPortalsForDomain(inside).length, 1);
  assert.equal(places.getPortalsForDomain("road").length, 1);

  assert.equal(places.clearAttachment("wagon", "street"), true);

  portal = places.resolvePortal("wagon", "front-door");
  assert.equal(portal.connected, false);
  assert.equal(portal.traversable, false);
  assert.equal(places.getPortalsForDomain(inside).length, 0);
  assert.equal(places.getPortalsForDomain("road").length, 0);
  assert.equal(places.clearAttachment("wagon", "street"), false);

  const changes = places.drainEvents()
    .filter((event) => event.type === "place-attachment-changed");
  assert.equal(changes.length, 2);
  assert.equal(changes.at(-1).attachment, null);
  places.assertInternalConsistency();
});

test("unbound portal state survives self-contained snapshot restore", () => {
  const places = new PlaceRegistry();
  places.registerDefinition(buildingDefinition());
  places.createPlace({
    id: "ship",
    definitionId: "detachable-building"
  });

  const restored = deserializePlaceCore(
    JSON.parse(JSON.stringify(serializePlaceCore(places)))
  );

  const portal = restored.resolvePortal("ship", "front-door");
  assert.equal(portal.connected, false);
  assert.equal(portal.traversable, false);
  assert.equal(restored.getPortalsForDomain("ship:inside").length, 0);
});

test("detaching a portal makes an existing graph edge disappear immediately", () => {
  const places = new PlaceRegistry();
  places.registerDefinition(buildingDefinition());
  const building = places.createPlace({
    id: "house",
    definitionId: "detachable-building",
    attachments: {
      street: {
        domainId: "street",
        position: { x: 10, y: 0 },
        nodeId: "house-door"
      }
    }
  });

  const inside = building.layerDomains.get("inside");
  const revisionBefore = places.travelRevision;
  assert.equal(places.getPortalsForDomain(inside).length, 1);

  places.clearAttachment("house", "street");

  assert.ok(places.travelRevision > revisionBefore);
  assert.equal(places.getPortalsForDomain(inside).length, 0);
  assert.equal(places.getPortalsForDomain("street").length, 0);
});


test("attachment rollback attempts every affected portal after restore errors", () => {
  const places = new PlaceRegistry();
  places.registerDefinition({
    id: "multi-attachment-portals",
    layers: [{ id: "inside" }],
    portals: [
      {
        id: "one",
        a: { kind: "external", slot: "street" },
        b: {
          kind: "local",
          layerId: "inside",
          position: { x: 0, y: 0 }
        }
      },
      {
        id: "two",
        a: { kind: "external", slot: "street" },
        b: {
          kind: "local",
          layerId: "inside",
          position: { x: 1, y: 0 }
        }
      }
    ]
  });

  places.createPlace({
    id: "house",
    definitionId: "multi-attachment-portals"
  });

  const calls = [];
  const bridge = {
    syncPortalState(
      _instance,
      portal,
      resolved
    ) {
      calls.push({
        portalId: portal.id,
        connected: resolved.connected
      });

      if (calls.length === 2) {
        throw new Error(
          "synthetic forward portal sync failure"
        );
      }
      if (calls.length === 3) {
        throw new Error(
          "synthetic first restore failure"
        );
      }
    }
  };

  places.attachWorldCoreBridge(bridge);

  assert.throws(
    () =>
      places.setAttachment(
        "house",
        "street",
        {
          domainId: "road",
          position: { x: 5, y: 0 }
        }
      ),
    AggregateError
  );

  assert.deepEqual(
    calls.map((call) => [
      call.portalId,
      call.connected
    ]),
    [
      ["one", true],
      ["two", true],
      ["one", false],
      ["two", false]
    ]
  );
  assert.equal(
    places.getPlace("house")
      .attachments.has("street"),
    false
  );
});
