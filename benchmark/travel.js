import { performance } from "node:perf_hooks";
import { compilePlace, PlaceRegistry, findDomainPortalPath } from "../src/index.js";

const count = Number(process.env.PLACE_COUNT ?? 50_000);
const queries = Number(process.env.QUERY_COUNT ?? 10_000);
const definition = compilePlace({
  id: "portal-house",
  layers: [{ spatialMode: "owned", id: "ground" }],
  portals: [{
    id: "front",
    a: { kind: "external", slot: "street" },
    b: { kind: "local", layerId: "ground", position: { x: 0, y: 0 } }
  }]
});
const places = new PlaceRegistry();
places.registerDefinition(definition);
for (let i = 0; i < count; i += 1) {
  places.createPlace({
    id: `house-${i}`,
    definitionId: definition.id,
    attachments: { street: { domainId: "city", position: { x: i, y: 0 } } }
  });
}
const samples = [];
let checksum = 0;
for (let i = 0; i < queries; i += 1) {
  const a = i % count;
  const b = (i * 7919 + 17) % count;
  const start = performance.now();
  const path = findDomainPortalPath(places, `house-${a}:ground`, `house-${b}:ground`);
  samples.push(performance.now() - start);
  checksum += path?.length ?? 0;
}
samples.sort((a, b) => a - b);
const p = (x) => samples[Math.min(samples.length - 1, Math.floor(samples.length * x))];
console.log("=== place-core portal graph benchmark ===");
console.log(`instances: ${count.toLocaleString()}`);
console.log(`queries: ${queries.toLocaleString()}`);
console.log(`p50: ${p(0.50).toFixed(4)} ms`);
console.log(`p95: ${p(0.95).toFixed(4)} ms`);
console.log(`p99: ${p(0.99).toFixed(4)} ms`);
console.log(`checksum: ${checksum}`);
