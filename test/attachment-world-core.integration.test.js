import test from "node:test";
import assert from "node:assert/strict";

import {
  World,
  Navigation,
  NavigationRegistry,
  startJourney,
  stopJourney
} from "world-core";

import {
  PlaceRegistry,
  WorldCoreBridge
} from "../src/index.js";

const mobility = {
  speed: 1,
  surfaceMultipliers: {},
  requiredRoadWidth: 0,
  requiredRoadTags: [],
  blockedRoadTags: []
};

function definition() {
  return {
    id: "bound-door-place",
    layers: [{
      id: "inside",
      navigation: {
        nodes: [
          { id: "room", x: 0, y: 0 },
          { id: "door", x: 5, y: 0 }
        ],
        roads: [{
          id: "door-road",
          from: "room",
          to: "door",
          width: 2
        }]
      }
    }],
    portals: [{
      id: "front-door",
      a: { kind: "external", slot: "outside" },
      b: {
        kind: "local",
        layerId: "inside",
        position: { x: 5, y: 0 },
        nodeId: "door"
      },
      transitionCost: 3,
      roadBindings: [{
        layerId: "inside",
        roadId: "door-road"
      }]
    }]
  };
}

function setup() {
  const world = new World({ domains: [{ id: "street" }] });
  const navigation = new NavigationRegistry();
  const bridge = new WorldCoreBridge({
    world,
    navigation,
    Navigation,
    startJourney,
    stopJourney
  });
  const places = new PlaceRegistry({ bridge });
  places.registerDefinition(definition());
  const place = places.createPlace({
    id: "house",
    definitionId: "bound-door-place"
  });
  return { world, navigation, bridge, places, place };
}

test("unbound external portal blocks its world-core road until attached", () => {
  const { navigation, places, place } = setup();
  const domainId = place.layerDomains.get("inside");

  let nav = navigation.navigationForDomain(domainId);
  assert.equal(nav.findRoute("room", "door", mobility), null);
  assert.equal(places.resolvePortal("house", "front-door").connected, false);

  places.setAttachment("house", "outside", {
    domainId: "street",
    position: { x: 50, y: 0 },
    nodeId: "street-house"
  });

  nav = navigation.navigationForDomain(domainId);
  assert.ok(nav.findRoute("room", "door", mobility));
  assert.equal(
    nav.roadTraversalDelaySeconds("door-road"),
    0,
    "cross-domain transitionCost must not be duplicated as a local road delay"
  );
  assert.equal(places.resolvePortal("house", "front-door").connected, true);
  assert.equal(places.resolvePortal("house", "front-door").transitionCost, 3);

  places.clearAttachment("house", "outside");

  nav = navigation.navigationForDomain(domainId);
  assert.equal(nav.findRoute("room", "door", mobility), null);
  assert.equal(places.resolvePortal("house", "front-door").connected, false);
});


test("same-domain external attachment rejects threshold geometry drift transactionally", () => {
  const world = new World();
  const navigation =
    new NavigationRegistry();
  const external = new Navigation();

  external.addNode({
    id: "a",
    x: 0,
    y: 0
  });
  external.addNode({
    id: "b",
    x: 1,
    y: 0
  });
  external.addNode({
    id: "c",
    x: 2,
    y: 0
  });
  external.addRoad({
    id: "threshold",
    from: "a",
    to: "b"
  });
  navigation.registerTopology(
    "external-attachment-threshold",
    external
  );

  const bridge = new WorldCoreBridge({
    world,
    navigation,
    startJourney,
    stopJourney
  });
  const places = new PlaceRegistry({
    bridge
  });

  places.registerDefinition({
    id: "external-attachment-place",
    layers: [{
      id: "inside",
      topologyId:
        "external-attachment-threshold"
    }],
    portals: [{
      id: "door",
      a: {
        kind: "external",
        slot: "outside"
      },
      b: {
        kind: "local",
        layerId: "inside",
        position: { x: 1, y: 0 },
        nodeId: "b"
      },
      roadBindings: [{
        layerId: "inside",
        roadId: "threshold"
      }]
    }]
  });

  const place = places.createPlace({
    id: "house",
    definitionId:
      "external-attachment-place"
  });
  const domainId =
    place.layerDomains.get("inside");

  assert.equal(
    places.resolvePortal(
      "house",
      "door"
    ).connected,
    false
  );

  assert.throws(
    () =>
      places.setAttachment(
        "house",
        "outside",
        {
          domainId,
          position: { x: 2, y: 0 },
          nodeId: "c"
        }
      ),
    /portal door road binding threshold does not connect its endpoint nodes/
  );

  assert.equal(
    places.getPlace("house")
      .attachments.has("outside"),
    false
  );
  assert.equal(
    places.resolvePortal(
      "house",
      "door"
    ).connected,
    false
  );
  assert.equal(
    navigation
      .navigationForDomain(domainId)
      .findRoute("a", "b", mobility),
    null
  );
  places.assertInternalConsistency();
});
