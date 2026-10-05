import { performance } from "node:perf_hooks";
import { compilePlace, PlaceRegistry } from "../src/index.js";

const count = Number(process.env.PLACE_COUNT ?? 100_000);
const queries = Number(process.env.QUERY_COUNT ?? 500_000);
const definition = compilePlace({
  id: "locate-house",
  layers: [{ spatialMode: "owned", id: "ground" }],
  spaces: [
    { id: "whole", layerId: "ground", geometry: { type: "aabb", minX: 0, minY: 0, maxX: 20, maxY: 20 } },
    { id: "a", layerId: "ground", parentSpaceId: "whole", geometry: { type: "aabb", minX: 0, minY: 0, maxX: 10, maxY: 20 } },
    { id: "b", layerId: "ground", parentSpaceId: "whole", geometry: { type: "aabb", minX: 10, minY: 0, maxX: 20, maxY: 20 } }
  ]
});
const places = new PlaceRegistry();
places.registerDefinition(definition);
for (let i = 0; i < count; i += 1) places.createPlace({ id: `house-${i}`, definitionId: definition.id });

const samples = [];
let checksum = 0;
for (let batch = 0; batch < Math.ceil(queries / 1000); batch += 1) {
  const start = performance.now();
  const end = Math.min(queries, (batch + 1) * 1000);
  for (let q = batch * 1000; q < end; q += 1) {
    const id = q % count;
    checksum += places.locate(`house-${id}:ground`, { x: q % 20, y: (q * 7) % 20 }).spaces.length;
  }
  samples.push((performance.now() - start) / Math.max(1, end - batch * 1000));
}
samples.sort((a, b) => a - b);
const p = (x) => samples[Math.min(samples.length - 1, Math.floor(samples.length * x))];
console.log("=== place-core locate benchmark ===");
console.log(`instances: ${count.toLocaleString()}`);
console.log(`queries: ${queries.toLocaleString()}`);
console.log(`per-query batch p50: ${(p(0.50) * 1000).toFixed(2)} µs`);
console.log(`per-query batch p95: ${(p(0.95) * 1000).toFixed(2)} µs`);
console.log(`per-query batch p99: ${(p(0.99) * 1000).toFixed(2)} µs`);
console.log(`checksum: ${checksum}`);
