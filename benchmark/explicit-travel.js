import { performance } from "node:perf_hooks";
import {
  PlaceRegistry,
  planTravel
} from "../src/index.js";

const count = Number(process.env.EXPLICIT_TRAVEL_PLACES ?? 50_000);
const queries = Number(process.env.EXPLICIT_TRAVEL_QUERIES ?? 2_000);

const places = new PlaceRegistry();
places.registerDefinition({
  id: "explicit-house",
  defaultAnchorId: "bed",
  layers: [{ spatialMode: "owned", id: "inside" }],
  portals: [{
    id: "door",
    a: { kind: "external", slot: "city" },
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
    position: { x: 5, y: 0 },
    nodeId: "bed"
  }]
});

for (let i = 0; i < count; i += 1) {
  places.createPlace({
    id: `house-${i}`,
    definitionId: "explicit-house",
    attachments: {
      city: {
        domainId: "city",
        position: { x: i, y: 0 },
        nodeId: `city-door-${i}`
      }
    }
  });
}

const entity = {
  id: "hans",
  domainId: "house-0:inside",
  position: { x: 5, y: 0 },
  mobility: { speed: 1 }
};

let singleRouteCalls = 0;
const bridge = {
  getEntity(id) {
    return id === "hans" ? entity : null;
  },
  planLocalRoute({ domainId, position, destinationNodeId }) {
    singleRouteCalls += 1;
    let x;
    if (destinationNodeId === "door") x = 0;
    else if (destinationNodeId === "bed") x = 5;
    else {
      const match = /^city-door-(\d+)$/.exec(destinationNodeId);
      if (!match) return null;
      x = Number(match[1]);
    }
    return { estimatedSeconds: Math.abs(position.x - x) };
  },
  startLocalJourney() { return true; },
  stopLocalJourney() {},
  transferEntity() {}
};

const samples = [];
let checksum = 0;
const started = performance.now();

for (let i = 0; i < queries; i += 1) {
  const target = (i * 7919 + 17) % count;
  const t = performance.now();
  const plan = planTravel(
    places,
    bridge,
    "hans",
    { placeId: `house-${target}`, anchorId: "bed" }
  );
  samples.push(performance.now() - t);
  if (!plan) throw new Error(`failed explicit travel query ${i}`);
  checksum += plan.domainPath.length;
}

const elapsed = performance.now() - started;
samples.sort((a, b) => a - b);
const percentile = p => samples[Math.min(samples.length - 1, Math.floor(samples.length * p))];

console.log("=== place-core explicit travel benchmark ===");
console.log(`places: ${count.toLocaleString()}`);
console.log(`queries: ${queries.toLocaleString()}`);
console.log(`elapsed: ${elapsed.toFixed(2)} ms`);
console.log(`p50: ${percentile(0.50).toFixed(4)} ms`);
console.log(`p95: ${percentile(0.95).toFixed(4)} ms`);
console.log(`p99: ${percentile(0.99).toFixed(4)} ms`);
console.log(`single local route calls/query: ${(singleRouteCalls / queries).toFixed(2)}`);
console.log(`checksum: ${checksum}`);
