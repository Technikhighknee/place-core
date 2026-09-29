import { performance } from "node:perf_hooks";
import { PlaceRegistry } from "../src/index.js";

const count = Number(process.env.PLACE_COUNT ?? 50_000);
const operations = Number(process.env.MUTATION_COUNT ?? 200_000);
const batchSize = Number(process.env.BATCH_SIZE ?? 1_000);

const places = new PlaceRegistry();
places.registerDefinition({
  id: "mutation-place",
  layers: [{ id: "a" }, { id: "b" }],
  portals: [{
    id: "door",
    a: { kind: "local", layerId: "a", position: { x: 0, y: 0 } },
    b: { kind: "local", layerId: "b", position: { x: 0, y: 0 } }
  }]
});

for (let i = 0; i < count; i += 1) {
  places.createPlace({ id: `p-${i}`, definitionId: "mutation-place" });
}

const samples = [];
for (let start = 0; start < operations; start += batchSize) {
  const end = Math.min(operations, start + batchSize);
  const t = performance.now();
  for (let i = start; i < end; i += 1) {
    const id = `p-${i % count}`;
    places.setPortalState(id, "door", { locked: (i & 1) === 0 });
  }
  samples.push((performance.now() - t) / (end - start));
}

samples.sort((a, b) => a - b);
const percentile = (p) => samples[Math.min(samples.length - 1, Math.floor(samples.length * p))];

places.assertInternalConsistency();

console.log("=== place-core mutation benchmark ===");
console.log(`instances: ${count.toLocaleString()}`);
console.log(`mutations: ${operations.toLocaleString()}`);
console.log(`per-op batch p50: ${(percentile(0.50) * 1000).toFixed(2)} µs`);
console.log(`per-op batch p95: ${(percentile(0.95) * 1000).toFixed(2)} µs`);
console.log(`per-op batch p99: ${(percentile(0.99) * 1000).toFixed(2)} µs`);
console.log(places.getDiagnostics());
