import test from "node:test";
import assert from "node:assert/strict";

import {
  PlaceRegistry,
  planTravel
} from "../src/index.js";

function buildPlannerFixture() {
  const places = new PlaceRegistry();
  places.registerDefinition({
    id: "two-door-house",
    defaultAnchorId: "target",
    layers: [{ id: "inside" }],
    spaces: [{
      id: "room",
      layerId: "inside",
      geometry: { type: "aabb", minX: -1, minY: -1, maxX: 11, maxY: 1 },
      defaultAnchorId: "target"
    }],
    portals: [
      {
        id: "door-1",
        a: { kind: "external", slot: "street-1" },
        b: {
          kind: "local",
          layerId: "inside",
          spaceId: "room",
          position: { x: 0, y: 0 },
          nodeId: "door-1"
        }
      },
      {
        id: "door-2",
        a: { kind: "external", slot: "street-2" },
        b: {
          kind: "local",
          layerId: "inside",
          spaceId: "room",
          position: { x: 10, y: 0 },
          nodeId: "door-2"
        }
      }
    ],
    anchors: [{
      id: "target",
      layerId: "inside",
      spaceId: "room",
      position: { x: 9, y: 0 },
      nodeId: "target"
    }]
  });

  const home = places.createPlace({
    id: "home",
    definitionId: "two-door-house",
    attachments: {
      "street-1": { domainId: "street", position: { x: 0, y: 0 }, nodeId: "s-home-1" },
      "street-2": { domainId: "street", position: { x: 100, y: 0 }, nodeId: "s-home-2" }
    }
  });

  const inn = places.createPlace({
    id: "inn",
    definitionId: "two-door-house",
    attachments: {
      "street-1": { domainId: "street", position: { x: 20, y: 0 }, nodeId: "s-inn-1" },
      "street-2": { domainId: "street", position: { x: 120, y: 0 }, nodeId: "s-inn-2" }
    }
  });

  const nodeX = new Map([
    ["door-1", 0],
    ["door-2", 10],
    ["target", 9],
    ["s-home-1", 0],
    ["s-home-2", 100],
    ["s-inn-1", 20],
    ["s-inn-2", 120]
  ]);

  const entity = {
    id: "hans",
    domainId: home.layerDomains.get("inside"),
    position: { x: 9, y: 0 },
    mobility: { speed: 1 }
  };

  const bridge = {
    getEntity(id) {
      return id === entity.id ? entity : null;
    },
    planLocalRoute({ position, destinationNodeId }) {
      const x = nodeX.get(destinationNodeId);
      if (x == null) return null;
      return { estimatedSeconds: Math.abs(position.x - x) };
    },
    startLocalJourney() { return true; },
    stopLocalJourney() {},
    transferEntity() {}
  };

  return { places, bridge, entity, home, inn };
}

test("planner optimizes concrete portal choices inside the domain path", () => {
  const { places, bridge } = buildPlannerFixture();

  const plan = planTravel(
    places,
    bridge,
    "hans",
    { placeId: "inn", anchorId: "target" }
  );

  assert.ok(plan);
  assert.deepEqual(plan.domainPath, ["home:inside", "street", "inn:inside"]);

  const portalSteps = plan.steps.filter((step) => step.type === "traverse-portal");
  assert.deepEqual(portalSteps.map((step) => step.portalId), ["door-2", "door-2"]);
  assert.equal(plan.estimatedSeconds, 22);
});

test("planner re-optimizes when the cheapest portal becomes unavailable", () => {
  const { places, bridge } = buildPlannerFixture();
  places.setPortalState("inn", "door-2", { locked: true });

  const plan = planTravel(
    places,
    bridge,
    "hans",
    { placeId: "inn", anchorId: "target" }
  );

  assert.ok(plan);
  const portalSteps = plan.steps.filter((step) => step.type === "traverse-portal");
  assert.equal(portalSteps.at(-1).portalId, "door-1");
  assert.ok(plan.estimatedSeconds > 22);
});


test("planner chooses the cheapest among multiple equally short domain paths", () => {
  const places = new PlaceRegistry();
  places.registerDefinition({
    id: "dual-route-house",
    defaultAnchorId: "target",
    layers: [{ id: "inside" }],
    spaces: [{
      id: "room",
      layerId: "inside",
      geometry: { type: "aabb", minX: -1, minY: -1, maxX: 11, maxY: 1 },
      defaultAnchorId: "target"
    }],
    portals: [
      {
        id: "route-a",
        a: { kind: "external", slot: "route-a" },
        b: { kind: "local", layerId: "inside", position: { x: 0, y: 0 }, nodeId: "door-a" }
      },
      {
        id: "route-b",
        a: { kind: "external", slot: "route-b" },
        b: { kind: "local", layerId: "inside", position: { x: 10, y: 0 }, nodeId: "door-b" }
      }
    ],
    anchors: [{
      id: "target",
      layerId: "inside",
      spaceId: "room",
      position: { x: 9, y: 0 },
      nodeId: "target"
    }]
  });

  const home = places.createPlace({
    id: "home",
    definitionId: "dual-route-house",
    attachments: {
      "route-a": { domainId: "route-a", position: { x: 0, y: 0 }, nodeId: "home-a" },
      "route-b": { domainId: "route-b", position: { x: 0, y: 0 }, nodeId: "home-b" }
    }
  });
  places.createPlace({
    id: "inn",
    definitionId: "dual-route-house",
    attachments: {
      "route-a": { domainId: "route-a", position: { x: 100, y: 0 }, nodeId: "inn-a" },
      "route-b": { domainId: "route-b", position: { x: 10, y: 0 }, nodeId: "inn-b" }
    }
  });

  const entity = {
    id: "hans",
    domainId: home.layerDomains.get("inside"),
    position: { x: 9, y: 0 },
    mobility: { speed: 1 }
  };

  const nodeX = new Map([
    ["door-a", 0],
    ["door-b", 10],
    ["target", 9],
    ["home-a", 0],
    ["home-b", 0],
    ["inn-a", 100],
    ["inn-b", 10]
  ]);

  const bridge = {
    getEntity(id) { return id === "hans" ? entity : null; },
    planLocalRoute({ position, destinationNodeId }) {
      const x = nodeX.get(destinationNodeId);
      return x == null ? null : { estimatedSeconds: Math.abs(position.x - x) };
    },
    startLocalJourney() { return true; },
    stopLocalJourney() {},
    transferEntity() {}
  };

  const plan = planTravel(
    places,
    bridge,
    "hans",
    { placeId: "inn", anchorId: "target" }
  );

  assert.ok(plan);
  assert.deepEqual(plan.domainPath, ["home:inside", "route-b", "inn:inside"]);
  assert.deepEqual(
    plan.steps.filter((step) => step.type === "traverse-portal").map((step) => step.portalId),
    ["route-b", "route-b"]
  );
});


test("nearest semantic target chooses the cheapest reachable anchor, not lexical order", () => {
  const places = new PlaceRegistry();
  places.registerDefinition({
    id: "bed-house",
    layers: [{ id: "inside" }],
    spaces: [{
      id: "room",
      layerId: "inside",
      geometry: { type: "aabb", minX: 0, minY: -1, maxX: 6, maxY: 1 }
    }],
    portals: [{
      id: "front-door",
      a: { kind: "external", slot: "street" },
      b: {
        kind: "local",
        layerId: "inside",
        position: { x: 0, y: 0 },
        nodeId: "door"
      }
    }],
    anchors: [{
      id: "bed",
      layerId: "inside",
      spaceId: "room",
      kind: "sleep",
      tags: ["bed"],
      position: { x: 5, y: 0 },
      nodeId: "bed"
    }]
  });

  places.createPlace({
    id: "zzz-near-house",
    definitionId: "bed-house",
    attachments: {
      street: {
        domainId: "street",
        position: { x: 10, y: 0 },
        nodeId: "near-street"
      }
    }
  });

  places.createPlace({
    id: "aaa-far-house",
    definitionId: "bed-house",
    attachments: {
      street: {
        domainId: "street",
        position: { x: 100, y: 0 },
        nodeId: "far-street"
      }
    }
  });

  const entity = {
    id: "hans",
    domainId: "street",
    position: { x: 0, y: 0 },
    mobility: { speed: 1 }
  };

  const nodeX = new Map([
    ["near-street", 10],
    ["far-street", 100],
    ["door", 0],
    ["bed", 5]
  ]);

  const bridge = {
    getEntity(id) { return id === "hans" ? entity : null; },
    planLocalRoute({ position, destinationNodeId }) {
      const x = nodeX.get(destinationNodeId);
      return x == null ? null : { estimatedSeconds: Math.abs(position.x - x) };
    },
    startLocalJourney() { return true; },
    stopLocalJourney() {},
    transferEntity() {}
  };

  const nearest = planTravel(
    places,
    bridge,
    "hans",
    { kind: "nearest", tag: "bed" }
  );

  assert.ok(nearest);
  assert.equal(nearest.resolvedTarget.placeId, "zzz-near-house");
  assert.equal(nearest.resolvedTarget.anchorId, "bed");
  assert.equal(nearest.estimatedSeconds, 15);

  places.setPortalState("zzz-near-house", "front-door", { locked: true });

  const rerouted = planTravel(
    places,
    bridge,
    "hans",
    { kind: "nearest", tag: "bed" }
  );

  assert.ok(rerouted);
  assert.equal(rerouted.resolvedTarget.placeId, "aaa-far-house");
  assert.equal(rerouted.estimatedSeconds, 105);
});

test("nearest semantic target supports external availability predicates", () => {
  const places = new PlaceRegistry();
  places.registerDefinition({
    id: "service-place",
    layers: [{ id: "inside" }],
    portals: [{
      id: "door",
      a: { kind: "external", slot: "street" },
      b: {
        kind: "local",
        layerId: "inside",
        position: { x: 0, y: 0 },
        nodeId: "door"
      }
    }],
    anchors: [{
      id: "counter",
      layerId: "inside",
      tags: ["service"],
      position: { x: 1, y: 0 },
      nodeId: "counter"
    }]
  });

  for (const [id, x] of [["closed-shop", 5], ["open-shop", 20]]) {
    places.createPlace({
      id,
      definitionId: "service-place",
      attachments: {
        street: {
          domainId: "street",
          position: { x, y: 0 },
          nodeId: `${id}-street`
        }
      }
    });
  }

  const entity = {
    id: "hans",
    domainId: "street",
    position: { x: 0, y: 0 },
    mobility: { speed: 1 }
  };
  const nodeX = new Map([
    ["closed-shop-street", 5],
    ["open-shop-street", 20],
    ["door", 0],
    ["counter", 1]
  ]);
  const bridge = {
    getEntity(id) { return id === "hans" ? entity : null; },
    planLocalRoute({ position, destinationNodeId }) {
      const x = nodeX.get(destinationNodeId);
      return x == null ? null : { estimatedSeconds: Math.abs(position.x - x) };
    },
    startLocalJourney() { return true; },
    stopLocalJourney() {},
    transferEntity() {}
  };

  const plan = planTravel(
    places,
    bridge,
    "hans",
    { kind: "nearest", tag: "service" },
    {
      anchorPredicate(anchor) {
        return anchor.placeId === "open-shop";
      }
    }
  );

  assert.ok(plan);
  assert.equal(plan.resolvedTarget.placeId, "open-shop");
});


test("nearest semantic target batches thousands of portal costs per domain", () => {
  const places = new PlaceRegistry();
  places.registerDefinition({
    id: "batch-house",
    layers: [{ id: "inside" }],
    portals: [{
      id: "door",
      a: { kind: "external", slot: "street" },
      b: {
        kind: "local",
        layerId: "inside",
        position: { x: 0, y: 0 },
        nodeId: "door"
      }
    }],
    anchors: [{
      id: "bed",
      layerId: "inside",
      tags: ["bed"],
      position: { x: 5, y: 0 },
      nodeId: "bed"
    }]
  });

  const count = 2_000;
  for (let i = 0; i < count; i += 1) {
    places.createPlace({
      id: `house-${i}`,
      definitionId: "batch-house",
      attachments: {
        street: {
          domainId: "street",
          position: { x: i + 1, y: 0 },
          nodeId: `street-door-${i}`
        }
      }
    });
  }

  const entity = {
    id: "hans",
    domainId: "street",
    position: { x: 0, y: 0 },
    mobility: { speed: 1 }
  };

  let batchCalls = 0;
  let singleCalls = 0;
  let largestBatch = 0;

  const bridge = {
    getEntity(id) { return id === "hans" ? entity : null; },
    planLocalRouteCostsToMany({ domainId, destinationNodeIds }) {
      batchCalls += 1;
      const ids = [...destinationNodeIds];
      largestBatch = Math.max(largestBatch, ids.length);
      const result = new Map();
      if (domainId === "street") {
        for (const id of ids) {
          const match = /^street-door-(\d+)$/.exec(id);
          if (match) result.set(id, Number(match[1]) + 1);
        }
      } else {
        for (const id of ids) {
          if (id === "bed") result.set(id, 5);
          else if (id === "door") result.set(id, 0);
        }
      }
      return result;
    },
    planLocalRoute() {
      singleCalls += 1;
      throw new Error("single-target routing should not be used when batching exists");
    },
    startLocalJourney() { return true; },
    stopLocalJourney() {},
    transferEntity() {}
  };

  const plan = planTravel(
    places,
    bridge,
    "hans",
    { kind: "nearest", tag: "bed" }
  );

  assert.ok(plan);
  assert.equal(plan.resolvedTarget.placeId, "house-0");
  assert.equal(plan.estimatedSeconds, 6);
  assert.equal(singleCalls, 0);
  assert.ok(largestBatch >= count);
  assert.ok(batchCalls < 20, `expected bounded batch calls, got ${batchCalls}`);
});


test("all travel plan shapes expose the current travel revision", () => {
  const places = new PlaceRegistry();
  places.registerDefinition({
    id: "revision-place",
    layers: [{ id: "inside" }],
    anchors: [{
      id: "target",
      layerId: "inside",
      tags: ["target"],
      position: { x: 5, y: 0 },
      nodeId: "target"
    }]
  });
  const place = places.createPlace({
    id: "room",
    definitionId: "revision-place"
  });

  const entity = {
    id: "hans",
    domainId: place.layerDomains.get("inside"),
    position: { x: 0, y: 0 },
    mobility: { speed: 1 }
  };
  const bridge = {
    getEntity(id) {
      return id === "hans" ? entity : null;
    },
    planLocalRoute() {
      return { estimatedSeconds: 5 };
    },
    planLocalRouteCostsToMany({ destinationNodeIds }) {
      return new Map(
        [...destinationNodeIds].map((id) => [id, 5])
      );
    },
    startLocalJourney() { return true; },
    stopLocalJourney() {},
    transferEntity() {}
  };

  const explicit = planTravel(
    places,
    bridge,
    "hans",
    { placeId: "room", anchorId: "target" }
  );
  const nearest = planTravel(
    places,
    bridge,
    "hans",
    { kind: "nearest", tag: "target" }
  );

  for (const plan of [explicit, nearest]) {
    assert.ok(plan);
    assert.equal(plan.travelRevision, places.travelRevision);
    assert.equal(plan.travelRevision, places.travelRevision);
  }
});


test("planner keeps a locally failed domain pair available through a different arrival", () => {
  const places = new PlaceRegistry();
  places.registerDefinition({ id: "detour-graph" });
  places.createPlace({
    id: "graph",
    definitionId: "detour-graph"
  });

  const add = (
    id,
    fromDomainId,
    fromX,
    fromNodeId,
    toDomainId,
    toX,
    toNodeId
  ) => {
    places.addPortal("graph", {
      id,
      bidirectional: false,
      a: {
        domainId: fromDomainId,
        position: { x: fromX, y: 0 },
        nodeId: fromNodeId
      },
      b: {
        domainId: toDomainId,
        position: { x: toX, y: 0 },
        nodeId: toNodeId
      }
    });
  };

  add("a-b", "A", 1, "a-to-b", "B", 0, "b-from-a");
  add("b-c", "B", 10, "b-to-c", "C", 0, "c-from-b");
  add("a-d", "A", 2, "a-to-d", "D", 0, "d-from-a");
  add("d-b", "D", 1, "d-to-b", "B", 10, "b-from-d");

  const entity = {
    id: "hans",
    domainId: "A",
    position: { x: 0, y: 0 },
    mobility: { speed: 1 }
  };

  const nodeX = new Map([
    ["A:a-to-b", 1],
    ["A:a-to-d", 2],
    ["B:b-to-c", 10],
    ["D:d-to-b", 1],
    ["C:target", 1]
  ]);

  const bridge = {
    getEntity(id) {
      return id === "hans" ? entity : null;
    },
    planLocalRoute({
      domainId,
      position,
      destinationNodeId
    }) {
      if (
        domainId === "B" &&
        destinationNodeId === "b-to-c" &&
        position.x < 9
      ) {
        return null;
      }

      const x = nodeX.get(
        `${domainId}:${destinationNodeId}`
      );
      return x == null
        ? null
        : {
            estimatedSeconds:
              Math.abs(position.x - x)
          };
    },
    startLocalJourney() { return true; },
    stopLocalJourney() {},
    transferEntity() {}
  };

  const plan = planTravel(
    places,
    bridge,
    "hans",
    {
      domainId: "C",
      position: { x: 1, y: 0 },
      nodeId: "target"
    }
  );

  assert.ok(
    plan,
    "A→D→B reaches the usable side of B→C"
  );
  assert.deepEqual(
    plan.domainPath,
    ["A", "D", "B", "C"]
  );
  assert.deepEqual(
    plan.steps
      .filter((step) => step.type === "traverse-portal")
      .map((step) => step.portalId),
    ["a-d", "d-b", "b-c"]
  );
});


test("concrete detour fallback may revisit a domain through a different portal", () => {
  const places = new PlaceRegistry();
  places.registerDefinition({
    id: "revisit-domain-graph"
  });
  places.createPlace({
    id: "graph",
    definitionId: "revisit-domain-graph"
  });

  const add = (
    id,
    fromDomainId,
    fromX,
    fromNodeId,
    toDomainId,
    toX,
    toNodeId
  ) => places.addPortal("graph", {
    id,
    bidirectional: false,
    a: {
      domainId: fromDomainId,
      position: { x: fromX, y: 0 },
      nodeId: fromNodeId
    },
    b: {
      domainId: toDomainId,
      position: { x: toX, y: 0 },
      nodeId: toNodeId
    }
  });

  add("a-b", "A", 1, "a-b", "B", 0, "b-from-a");
  add("b-c", "B", 10, "b-c", "C", 0, "c-from-b");
  add("b-d", "B", 0, "b-d", "D", 0, "d-from-b");
  add("d-b", "D", 1, "d-b", "B", 10, "b-from-d");

  const entity = {
    id: "hans",
    domainId: "A",
    position: { x: 0, y: 0 },
    mobility: { speed: 1 }
  };

  const nodes = new Map([
    ["A:a-b", 1],
    ["B:b-c", 10],
    ["B:b-d", 0],
    ["D:d-b", 1],
    ["C:target", 1]
  ]);

  const bridge = {
    getEntity(id) {
      return id === "hans"
        ? entity
        : null;
    },
    planLocalRoute({
      domainId,
      position,
      destinationNodeId
    }) {
      if (
        domainId === "B" &&
        destinationNodeId === "b-c" &&
        position.x < 9
      ) {
        return null;
      }
      const x = nodes.get(
        `${domainId}:${destinationNodeId}`
      );
      return x == null
        ? null
        : {
            estimatedSeconds:
              Math.abs(position.x - x)
          };
    },
    startLocalJourney() { return true; },
    stopLocalJourney() {},
    transferEntity() {}
  };

  const plan = planTravel(
    places,
    bridge,
    "hans",
    {
      domainId: "C",
      position: { x: 1, y: 0 },
      nodeId: "target"
    }
  );

  assert.ok(plan);
  assert.deepEqual(
    plan.domainPath,
    ["A", "B", "D", "B", "C"]
  );
});


test("default concrete-state search does not silently discard the globally cheapest portal choice", () => {
  const places = new PlaceRegistry();
  places.registerDefinition({ id: "wide-portal-graph" });
  places.createPlace({
    id: "graph",
    definitionId: "wide-portal-graph"
  });

  for (let i = 0; i < 129; i += 1) {
    places.addPortal("graph", {
      id: `p-${String(i).padStart(3, "0")}`,
      bidirectional: false,
      a: {
        domainId: "A",
        position: { x: i, y: 0 },
        nodeId: `a-${i}`
      },
      b: {
        domainId: "B",
        position: { x: i, y: 0 },
        nodeId: `b-${i}`
      }
    });
  }

  const entity = {
    id: "hans",
    domainId: "A",
    position: { x: 0, y: 0 },
    mobility: { speed: 1 }
  };

  const bridge = {
    getEntity(id) {
      return id === "hans" ? entity : null;
    },
    planLocalRoute({
      domainId,
      position,
      destinationNodeId
    }) {
      const index = Number(
        destinationNodeId.split("-").at(-1)
      );
      if (!Number.isInteger(index)) {
        return null;
      }

      if (domainId === "A") {
        return { estimatedSeconds: index };
      }

      if (domainId === "B") {
        return {
          estimatedSeconds:
            Math.abs(position.x - 128) * 10
        };
      }

      return null;
    },
    startLocalJourney() { return true; },
    stopLocalJourney() {},
    transferEntity() {}
  };

  const plan = planTravel(
    places,
    bridge,
    "hans",
    {
      domainId: "B",
      position: { x: 128, y: 0 },
      nodeId: "target-128"
    }
  );

  assert.ok(plan);
  assert.equal(
    plan.steps.find(
      (step) => step.type === "traverse-portal"
    ).portalId,
    "p-128"
  );
  assert.equal(plan.estimatedSeconds, 128);
});


test("planner rejects invalid local routing costs instead of poisoning travel state", () => {
  const places = new PlaceRegistry();
  const entity = {
    id: "hans",
    domainId: "A",
    position: { x: 0, y: 0 },
    mobility: { speed: 1 }
  };

  for (const estimatedSeconds of [
    Number.NaN,
    Number.POSITIVE_INFINITY,
    -1,
    undefined
  ]) {
    const bridge = {
      getEntity(id) {
        return id === "hans" ? entity : null;
      },
      planLocalRoute() {
        return estimatedSeconds === undefined
          ? {}
          : { estimatedSeconds };
      }
    };

    assert.throws(
      () => planTravel(
        places,
        bridge,
        "hans",
        {
          domainId: "A",
          position: { x: 10, y: 0 },
          nodeId: "target"
        }
      ),
      /estimatedSeconds.*finite.*>= 0/i
    );
  }
});

test("planner validates batched local route costs", () => {
  const places = new PlaceRegistry();
  places.registerDefinition({
    id: "batched-costs",
    layers: [{ id: "inside" }],
    anchors: [{
      id: "goal",
      layerId: "inside",
      tags: ["goal"],
      position: { x: 1, y: 0 },
      nodeId: "target"
    }]
  });
  places.createPlace({
    id: "goal-place",
    definitionId: "batched-costs",
    layerDomains: {
      inside: "B"
    }
  });
  places.registerDefinition({
    id: "portal-holder"
  });
  places.createPlace({
    id: "graph",
    definitionId: "portal-holder"
  });
  places.addPortal("graph", {
    id: "a-b",
    bidirectional: false,
    a: {
      domainId: "A",
      position: { x: 1, y: 0 },
      nodeId: "a-exit"
    },
    b: {
      domainId: "B",
      position: { x: 0, y: 0 },
      nodeId: "b-entry"
    }
  });

  const entity = {
    id: "hans",
    domainId: "A",
    position: { x: 0, y: 0 },
    mobility: { speed: 1 }
  };

  const bridge = {
    getEntity(id) {
      return id === "hans" ? entity : null;
    },
    planLocalRouteCostsToMany() {
      return new Map([
        ["a-exit", Number.NaN]
      ]);
    },
    planLocalRoute() {
      return { estimatedSeconds: 1 };
    }
  };

  assert.throws(
    () => planTravel(
      places,
      bridge,
      "hans",
      {
        kind: "nearest",
        tag: "goal"
      }
    ),
    /route cost.*finite.*>= 0/i
  );
});


test("planner rejects aggregate travel cost overflow", () => {
  const places = new PlaceRegistry();
  places.registerDefinition({
    id: "overflow-graph"
  });
  places.createPlace({
    id: "graph",
    definitionId: "overflow-graph"
  });

  places.addPortal("graph", {
    id: "a-b",
    bidirectional: false,
    transitionCost: 1e308,
    a: {
      domainId: "A",
      position: { x: 1, y: 0 },
      nodeId: "a-exit"
    },
    b: {
      domainId: "B",
      position: { x: 0, y: 0 },
      nodeId: "b-entry"
    }
  });

  const entity = {
    id: "hans",
    domainId: "A",
    position: { x: 0, y: 0 },
    mobility: { speed: 1 }
  };

  const bridge = {
    getEntity(id) {
      return id === "hans" ? entity : null;
    },
    planLocalRoute({ domainId, destinationNodeId }) {
      if (
        domainId === "A" &&
        destinationNodeId === "a-exit"
      ) {
        return { estimatedSeconds: 1e308 };
      }
      if (
        domainId === "B" &&
        destinationNodeId === "target"
      ) {
        return { estimatedSeconds: 0 };
      }
      return null;
    }
  };

  assert.throws(
    () => planTravel(
      places,
      bridge,
      "hans",
      {
        domainId: "B",
        position: { x: 0, y: 0 },
        nodeId: "target"
      }
    ),
    /travel cost.*finite|cost.*overflow/i
  );
});
