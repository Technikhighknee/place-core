import test from "node:test";
import assert from "node:assert/strict";

import {
  PlaceRegistry,
  startTravel,
  stepTravel
} from "../src/index.js";

function simpleDefinition() {
  return {
    id: "revision-place",
    footprint: { type: "aabb", minX: 0, minY: 0, maxX: 10, maxY: 10 },
    layers: [{ id: "inside" }],
    spaces: [{
      id: "room",
      layerId: "inside",
      geometry: { type: "aabb", minX: 0, minY: 0, maxX: 10, maxY: 10 }
    }],
    portals: [{
      id: "door",
      a: { kind: "external", slot: "street" },
      b: {
        kind: "local",
        layerId: "inside",
        position: { x: 0, y: 5 },
        nodeId: "door"
      }
    }],
    anchors: [{
      id: "target",
      layerId: "inside",
      spaceId: "room",
      position: { x: 8, y: 5 },
      nodeId: "target"
    }],
    boundaries: [{
      id: "wall",
      layerId: "inside",
      a: { x: 0, y: 0 },
      b: { x: 10, y: 0 }
    }]
  };
}

function setup() {
  const places = new PlaceRegistry();
  places.registerDefinition(simpleDefinition());
  places.createPlace({
    id: "house",
    definitionId: "revision-place",
    attachments: {
      street: { domainId: "street", position: { x: 10, y: 0 }, nodeId: "house-street" }
    },
    placement: {
      domainId: "street",
      transform: { x: 10, y: 0 },
      containment: "footprint"
    }
  });
  places.createPlace({
    id: "district",
    definitionId: "revision-place",
    attachments: {
      street: { domainId: "street", position: { x: 50, y: 0 }, nodeId: "district-street" }
    }
  });
  return places;
}

test("semantic-only mutations do not invalidate travel revision", () => {
  const places = setup();

  const startState = places.stateRevision;
  const startTravelRevision = places.travelRevision;

  places.setPlacement("house", {
    domainId: "street",
    transform: { x: 20, y: 5 },
    containment: "footprint"
  });

  assert.equal(places.stateRevision, startState + 1);
  assert.equal(places.travelRevision, startTravelRevision);
  assert.equal(places.graphRevision, startTravelRevision);

  places.setParent("house", "district");

  assert.equal(places.stateRevision, startState + 2);
  assert.equal(places.travelRevision, startTravelRevision);
});

test("travel-affecting mutations advance both revisions", () => {
  const places = setup();

  let state = places.stateRevision;
  let travel = places.travelRevision;

  places.setPortalState("house", "door", { locked: true });
  assert.equal(places.stateRevision, ++state);
  assert.equal(places.travelRevision, ++travel);

  places.setSpaceState("house", "room", { enabled: false });
  assert.equal(places.stateRevision, ++state);
  assert.equal(places.travelRevision, ++travel);

  places.setBoundaryState("house", "wall", { enabled: false });
  assert.equal(places.stateRevision, ++state);
  assert.equal(places.travelRevision, ++travel);

  places.clearAttachment("house", "street");
  assert.equal(places.stateRevision, ++state);
  assert.equal(places.travelRevision, ++travel);
});

test("eager travel ignores placement and semantic-parent changes", () => {
  const places = setup();
  const house = places.getPlace("house");
  const entity = {
    id: "hans",
    domainId: house.layerDomains.get("inside"),
    position: { x: 0, y: 5 },
    mobility: { speed: 1 },
    journey: null
  };

  const bridge = {
    getEntity(id) { return id === "hans" ? entity : null; },
    planLocalRoute({ destinationNodeId }) {
      if (destinationNodeId === "target") return { estimatedSeconds: 8 };
      return { estimatedSeconds: 0 };
    },
    startLocalJourney() {
      entity.journey = { active: true };
      return true;
    },
    stopLocalJourney() {
      entity.journey = null;
    },
    transferEntity() {}
  };

  const travel = startTravel(
    places,
    bridge,
    "hans",
    { placeId: "house", anchorId: "target" },
    { worldChangePolicy: "eager" }
  );

  assert.ok(travel);
  assert.equal(travel.replans, 0);

  places.setPlacement("house", {
    domainId: "street",
    transform: { x: 100, y: 100 },
    containment: "footprint"
  });
  places.setParent("house", "district");

  stepTravel(places, bridge, "hans");

  assert.equal(travel.replans, 0);
  assert.equal(travel.status, "active");
});

test("eager travel still replans on travel-affecting mutations", () => {
  const places = setup();
  const house = places.getPlace("house");
  const entity = {
    id: "hans",
    domainId: house.layerDomains.get("inside"),
    position: { x: 0, y: 5 },
    mobility: { speed: 1 },
    journey: null
  };

  const bridge = {
    getEntity(id) { return id === "hans" ? entity : null; },
    planLocalRoute({ destinationNodeId }) {
      if (destinationNodeId === "target") return { estimatedSeconds: 8 };
      return { estimatedSeconds: 0 };
    },
    startLocalJourney() {
      entity.journey = { active: true };
      return true;
    },
    stopLocalJourney() {
      entity.journey = null;
    },
    transferEntity() {}
  };

  const travel = startTravel(
    places,
    bridge,
    "hans",
    { placeId: "house", anchorId: "target" },
    { worldChangePolicy: "eager" }
  );
  assert.ok(travel);

  places.setSpaceState("house", "room", { enabled: false });
  stepTravel(places, bridge, "hans");

  assert.ok(travel.replans >= 1 || travel.status === "failed");
});
