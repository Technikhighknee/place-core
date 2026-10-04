import { performance } from "node:perf_hooks";
import {
  PlaceRegistry,
  planTravel
} from "../src/index.js";

const count = Number(process.env.NEAREST_TARGET_PLACES ?? 50_000);

const places = new PlaceRegistry();
places.registerDefinition({
  id: "nearest-house",
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

for (let i = 0; i < count; i += 1) {
  places.createPlace({
    id: `house-${i}`,
    definitionId: "nearest-house",
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
let largestBatch = 0;
let destinationsCosted = 0;

const bridge = {
  getEntity(id) {
    return id === entity.id ? entity : null;
  },
  planLocalRouteCostsToMany({ domainId, destinationNodeIds }) {
    batchCalls += 1;
    const ids = [...destinationNodeIds];
    largestBatch = Math.max(largestBatch, ids.length);
    destinationsCosted += ids.length;
    const result = new Map();

    if (domainId === "street") {
      for (const id of ids) {
        const match = /^street-door-(\d+)$/.exec(id);
        if (match) result.set(id, Number(match[1]) + 1);
      }
    } else {
      for (const id of ids) {
        if (id === "door") result.set(id, 0);
        else if (id === "bed") result.set(id, 5);
      }
    }

    return result;
  },
  planLocalRoute() {
    throw new Error("nearest-target benchmark unexpectedly used single-target routing");
  },
  startLocalJourney() { return true; },
  stopLocalJourney() {},
  transferEntity() {}
};

if (global.gc) global.gc();
const heapBefore = process.memoryUsage().heapUsed;
const started = performance.now();

const plan = planTravel(
  places,
  bridge,
  "hans",
  { kind: "nearest", tag: "bed" }
);

const elapsedMs = performance.now() - started;
if (global.gc) global.gc();
const heapAfter = process.memoryUsage().heapUsed;

if (!plan) throw new Error("nearest-target benchmark failed to find a route");
if (plan.resolvedTarget.placeId !== "house-0") {
  throw new Error(`unexpected nearest target: ${String(plan.resolvedTarget.placeId)}`);
}

console.log("=== place-core nearest semantic target benchmark ===");
console.log(`places: ${count.toLocaleString()}`);
console.log(`elapsed: ${elapsedMs.toFixed(2)} ms`);
console.log(`batch calls: ${batchCalls.toLocaleString()}`);
console.log(`largest batch: ${largestBatch.toLocaleString()}`);
console.log(`destinations costed: ${destinationsCosted.toLocaleString()}`);
console.log(`estimated travel seconds: ${plan.estimatedSeconds.toFixed(2)}`);
console.log(`post-GC heap delta: ${((heapAfter - heapBefore) / 1024 / 1024).toFixed(2)} MiB`);
