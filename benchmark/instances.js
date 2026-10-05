import { performance } from "node:perf_hooks";
import { compilePlace, PlaceRegistry } from "../src/index.js";

const count = Number(process.env.PLACE_COUNT ?? 100_000);
const definition = compilePlace({
  id: "bench-house",
  layers: [{ spatialMode: "owned", id: "ground" }, { spatialMode: "owned", id: "cellar" }],
  spaces: [
    { id: "room", layerId: "ground", geometry: { type: "aabb", minX: 0, minY: 0, maxX: 10, maxY: 10 } },
    { id: "storage", layerId: "cellar", geometry: { type: "aabb", minX: 0, minY: 0, maxX: 10, maxY: 10 } }
  ]
});
if (global.gc) global.gc();
const before = process.memoryUsage();
const places = new PlaceRegistry();
places.registerDefinition(definition);
const started = performance.now();
for (let i = 0; i < count; i += 1) places.createPlace({ id: `house-${i}`, definitionId: definition.id });
const elapsed = performance.now() - started;
if (global.gc) global.gc();
const after = process.memoryUsage();

console.log("=== place-core instance benchmark ===");
console.log(`instances: ${count.toLocaleString()}`);
console.log(`logical spaces: ${(count * definition.spaces.length).toLocaleString()}`);
console.log(`create: ${elapsed.toFixed(2)} ms (${Math.round(count / (elapsed / 1000)).toLocaleString()}/s)`);
console.log(`heap delta after GC: ${((after.heapUsed - before.heapUsed) / 1024 / 1024).toFixed(2)} MiB`);
console.log(`approx retained bytes/instance: ${Math.round((after.heapUsed - before.heapUsed) / count)}`);
console.log(places.getDiagnostics());
places.assertInternalConsistency();
