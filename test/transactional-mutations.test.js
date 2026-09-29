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

function runtime(definition, input = {}) {
  const world = new World({
    domains: [
      { id: "street-a" },
      { id: "street-b" }
    ]
  });
  const navigation = new NavigationRegistry();
  const bridge = new WorldCoreBridge({
    world,
    navigation,
    Navigation,
    startJourney,
    stopJourney
  });
  const places = new PlaceRegistry({
    bridge,
    captureEvents: true
  });
  places.registerDefinition(definition);
  const place = places.createPlace({
    id: "place",
    definitionId: definition.id,
    ...input
  });
  places.drainEvents();
  return { world, navigation, bridge, places, place };
}

function roadDefinition(extra = {}) {
  return {
    id: "road-place",
    layers: [{
      id: "inside",
      navigation: {
        nodes: [
          { id: "a", x: 0, y: 0 },
          { id: "b", x: 5, y: 0 }
        ],
        roads: [{
          id: "road",
          from: "a",
          to: "b",
          width: 2
        }]
      }
    }],
    ...extra
  };
}

function revisions(places) {
  return {
    state: places.stateRevision,
    travel: places.travelRevision
  };
}

function assertRevisions(places, expected) {
  assert.equal(places.stateRevision, expected.state);
  assert.equal(places.travelRevision, expected.travel);
}

test("boundary bridge failure restores registry and world-core road state", () => {
  const definition = roadDefinition({
    boundaries: [{
      id: "wall",
      layerId: "inside",
      enabled: false,
      a: { x: 0, y: -1 },
      b: { x: 0, y: 1 },
      roadBindings: [{ roadId: "road" }]
    }]
  });
  const { navigation, bridge, places, place } = runtime(definition);
  const domain = place.layerDomains.get("inside");
  const nav = () => navigation.navigationForDomain(domain);

  assert.ok(nav().findRoute("a", "b", mobility));
  const before = revisions(places);

  const original = bridge.syncBoundaryState.bind(bridge);
  let calls = 0;
  bridge.syncBoundaryState = (...args) => {
    const result = original(...args);
    calls += 1;
    if (calls === 1) throw new Error("synthetic boundary failure");
    return result;
  };

  assert.throws(
    () => places.setBoundaryState("place", "wall", { enabled: true }),
    /synthetic boundary failure/
  );

  assert.equal(places.resolveBoundary("place", "wall").enabled, false);
  assert.ok(nav().findRoute("a", "b", mobility));
  assertRevisions(places, before);
  assert.deepEqual(places.drainEvents(), []);
});

test("static portal bridge failure restores traversal state and road effect", () => {
  const definition = roadDefinition({
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
        position: { x: 5, y: 0 },
        nodeId: "b"
      },
      roadBindings: [{
        layerId: "inside",
        roadId: "road"
      }]
    }]
  });
  const { navigation, bridge, places, place } = runtime(definition);
  const domain = place.layerDomains.get("inside");
  const nav = () => navigation.navigationForDomain(domain);

  assert.ok(nav().findRoute("a", "b", mobility));
  const before = revisions(places);

  const original = bridge.syncPortalState.bind(bridge);
  let calls = 0;
  bridge.syncPortalState = (...args) => {
    const result = original(...args);
    calls += 1;
    if (calls === 1) throw new Error("synthetic portal failure");
    return result;
  };

  assert.throws(
    () => places.setPortalState("place", "door", { locked: true }),
    /synthetic portal failure/
  );

  assert.equal(places.resolvePortal("place", "door").locked, false);
  assert.ok(nav().findRoute("a", "b", mobility));
  assertRevisions(places, before);
  assert.deepEqual(places.drainEvents(), []);
  places.assertInternalConsistency();
});

test("attachment bridge failure restores endpoint index and road delay", () => {
  const definition = roadDefinition({
    portals: [{
      id: "gangway",
      transitionCost: 3,
      a: { kind: "external", slot: "outside" },
      b: {
        kind: "local",
        layerId: "inside",
        position: { x: 0, y: 0 },
        nodeId: "a"
      },
      roadBindings: [{
        layerId: "inside",
        roadId: "road"
      }]
    }]
  });
  const { navigation, bridge, places, place } = runtime(definition, {
    attachments: {
      outside: {
        domainId: "street-a",
        position: { x: 10, y: 0 },
        nodeId: "street-a-door"
      }
    }
  });
  const domain = place.layerDomains.get("inside");
  const nav = () => navigation.navigationForDomain(domain);
  const before = revisions(places);

  assert.equal(nav().roadTraversalDelaySeconds("road"), 0);

  const original = bridge.syncPortalState.bind(bridge);
  let calls = 0;
  bridge.syncPortalState = (...args) => {
    const result = original(...args);
    calls += 1;
    if (calls === 1) throw new Error("synthetic attachment failure");
    return result;
  };

  assert.throws(
    () => places.setAttachment("place", "outside", {
      domainId: domain,
      position: { x: 5, y: 0 },
      nodeId: "b"
    }),
    /synthetic attachment failure/
  );

  const portal = places.resolvePortal("place", "gangway");
  assert.equal(portal.a.domainId, "street-a");
  assert.equal(nav().roadTraversalDelaySeconds("road"), 0);
  assert.equal(
    places.findNearestPortal("street-a", { x: 10, y: 0 })?.portal.id,
    "gangway"
  );
  assert.equal(
    places.findNearestPortal(domain, { x: 5, y: 0 })?.side,
    "b"
  );
  assertRevisions(places, before);
  assert.deepEqual(places.drainEvents(), []);
  places.assertInternalConsistency();
});

test("clearing an attachment rolls back a partial disconnected-road block", () => {
  const definition = roadDefinition({
    portals: [{
      id: "door",
      a: { kind: "external", slot: "outside" },
      b: {
        kind: "local",
        layerId: "inside",
        position: { x: 5, y: 0 },
        nodeId: "b"
      },
      roadBindings: [{
        layerId: "inside",
        roadId: "road"
      }]
    }]
  });
  const { navigation, bridge, places, place } = runtime(definition, {
    attachments: {
      outside: {
        domainId: "street-a",
        position: { x: 10, y: 0 },
        nodeId: "street-door"
      }
    }
  });
  const domain = place.layerDomains.get("inside");
  const nav = () => navigation.navigationForDomain(domain);
  const before = revisions(places);
  assert.ok(nav().findRoute("a", "b", mobility));

  const original = bridge.syncPortalState.bind(bridge);
  let calls = 0;
  bridge.syncPortalState = (...args) => {
    const result = original(...args);
    calls += 1;
    if (calls === 1) throw new Error("synthetic clear failure");
    return result;
  };

  assert.throws(
    () => places.clearAttachment("place", "outside"),
    /synthetic clear failure/
  );

  assert.equal(places.resolvePortal("place", "door").connected, true);
  assert.ok(nav().findRoute("a", "b", mobility));
  assert.equal(
    places.findNearestPortal("street-a", { x: 10, y: 0 })?.portal.id,
    "door"
  );
  assertRevisions(places, before);
  assert.deepEqual(places.drainEvents(), []);
});

test("failed dynamic portal add removes partial world-core delay and registry state", () => {
  const { navigation, bridge, places, place } = runtime(roadDefinition());
  const domain = place.layerDomains.get("inside");
  const nav = () => navigation.navigationForDomain(domain);
  const before = revisions(places);

  const original = bridge.syncDynamicPortal.bind(bridge);
  let calls = 0;
  bridge.syncDynamicPortal = (...args) => {
    const result = original(...args);
    calls += 1;
    if (calls === 1) throw new Error("synthetic dynamic add failure");
    return result;
  };

  assert.throws(
    () => places.addPortal("place", {
      id: "slow-door",
      transitionCost: 2,
      a: {
        domainId: domain,
        position: { x: 0, y: 0 },
        nodeId: "a",
        layerId: "inside"
      },
      b: {
        domainId: domain,
        position: { x: 5, y: 0 },
        nodeId: "b",
        layerId: "inside"
      },
      roadBindings: [{
        layerId: "inside",
        roadId: "road"
      }]
    }),
    /synthetic dynamic add failure/
  );

  assert.equal(places.resolvePortal("place", "slow-door"), null);
  assert.equal(nav().roadTraversalDelaySeconds("road"), 0);
  assertRevisions(places, before);
  assert.deepEqual(places.drainEvents(), []);
  places.assertInternalConsistency();
});

test("failed dynamic portal removal restores its world-core delay and registry record", () => {
  const { navigation, bridge, places, place } = runtime(roadDefinition());
  const domain = place.layerDomains.get("inside");
  const nav = () => navigation.navigationForDomain(domain);

  places.addPortal("place", {
    id: "slow-door",
    transitionCost: 2,
    a: {
      domainId: domain,
      position: { x: 0, y: 0 },
      nodeId: "a",
      layerId: "inside"
    },
    b: {
      domainId: domain,
      position: { x: 5, y: 0 },
      nodeId: "b",
      layerId: "inside"
    },
    roadBindings: [{
      layerId: "inside",
      roadId: "road"
    }]
  });
  places.drainEvents();
  const before = revisions(places);
  assert.equal(nav().roadTraversalDelaySeconds("road"), 2);

  const original = bridge.removeDynamicPortal.bind(bridge);
  let calls = 0;
  bridge.removeDynamicPortal = (...args) => {
    const result = original(...args);
    calls += 1;
    if (calls === 1) throw new Error("synthetic dynamic remove failure");
    return result;
  };

  assert.throws(
    () => places.removePortal("place", "slow-door"),
    /synthetic dynamic remove failure/
  );

  assert.ok(places.resolvePortal("place", "slow-door"));
  assert.equal(nav().roadTraversalDelaySeconds("road"), 2);
  assertRevisions(places, before);
  assert.deepEqual(places.drainEvents(), []);
  places.assertInternalConsistency();
});
