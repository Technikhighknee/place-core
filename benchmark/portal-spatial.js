import { performance } from "node:perf_hooks";
import { PlaceRegistry } from "../src/index.js";

const count = Number(process.env.PORTAL_SPATIAL_PLACES ?? 50_000);
const queries = Number(process.env.PORTAL_SPATIAL_QUERIES ?? 10_000);
const blockedQueries = Number(
  process.env.PORTAL_SPATIAL_BLOCKED_QUERIES ?? 1_000
);

const places = new PlaceRegistry();
places.registerDefinition({
  id: "portal-spatial-house",
  layers: [{ spatialMode: "owned", id: "inside" }],
  portals: [{
    id: "door",
    a: { kind: "external", slot: "city" },
    b: {
      kind: "local",
      layerId: "inside",
      position: { x: 0, y: 0 }
    }
  }]
});

for (let i = 0; i < count; i += 1) {
  places.createPlace({
    id: `house-${i}`,
    definitionId: "portal-spatial-house",
    attachments: {
      city: {
        domainId: "city",
        position: { x: i * 4, y: (i % 17) * 3 }
      }
    }
  });
}

const samples = [];
let checksum = 0;
const started = performance.now();

for (let i = 0; i < queries; i += 1) {
  const index = (i * 7919 + 17) % count;
  const point = {
    x: index * 4 + 0.75,
    y: (index % 17) * 3 + 0.25
  };
  const t = performance.now();
  const hit = places.findNearestPortal("city", point);
  samples.push(performance.now() - t);
  if (!hit) throw new Error(`missing nearest portal for query ${i}`);
  checksum += Number(String(hit.portal.instanceId).slice(6));
}

const elapsed = performance.now() - started;
samples.sort((a, b) => a - b);
const percentile = p =>
  samples[Math.min(samples.length - 1, Math.floor(samples.length * p))];

console.log("=== place-core portal spatial benchmark ===");
console.log(`places: ${count.toLocaleString()}`);
console.log(`queries: ${queries.toLocaleString()}`);
console.log(`elapsed: ${elapsed.toFixed(2)} ms`);
console.log(`p50: ${percentile(0.50).toFixed(4)} ms`);
console.log(`p95: ${percentile(0.95).toFixed(4)} ms`);
console.log(`p99: ${percentile(0.99).toFixed(4)} ms`);
console.log(`portal endpoints: ${places.getDiagnostics().portalEndpointCount.toLocaleString()}`);
console.log(`checksum: ${checksum}`);


const lockStarted = performance.now();
for (let i = 0; i < count; i += 1) {
  places.setPortalState(
    `house-${i}`,
    "door",
    { locked: true }
  );
}
const lockElapsed = performance.now() - lockStarted;

const blockedSamples = [];
const blockedStarted = performance.now();
for (let i = 0; i < blockedQueries; i += 1) {
  const index = (i * 3571 + 11) % count;
  const point = {
    x: index * 4 + 0.5,
    y: (index % 17) * 3
  };
  const t = performance.now();
  const hit = places.findNearestPortal("city", point);
  blockedSamples.push(performance.now() - t);
  if (hit !== null) {
    throw new Error(
      `blocked nearest query ${i} unexpectedly found ${hit.portal.key}`
    );
  }
}
const blockedElapsed = performance.now() - blockedStarted;
blockedSamples.sort((a, b) => a - b);

const diagnostics = places.getDiagnostics();
if (diagnostics.traversablePortalEndpointCount !== 0) {
  throw new Error(
    `expected zero traversable endpoints after locking all portals, got ${diagnostics.traversablePortalEndpointCount}`
  );
}

const blockedPercentile = p =>
  blockedSamples[
    Math.min(
      blockedSamples.length - 1,
      Math.floor(blockedSamples.length * p)
    )
  ];

console.log("--- all-portals-blocked phase ---");
console.log(`lock mutations: ${lockElapsed.toFixed(2)} ms`);
console.log(`blocked queries: ${blockedQueries.toLocaleString()}`);
console.log(`blocked elapsed: ${blockedElapsed.toFixed(2)} ms`);
console.log(`blocked p50: ${blockedPercentile(0.50).toFixed(4)} ms`);
console.log(`blocked p95: ${blockedPercentile(0.95).toFixed(4)} ms`);
console.log(`blocked p99: ${blockedPercentile(0.99).toFixed(4)} ms`);
