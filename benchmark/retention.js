import { performance } from "node:perf_hooks";
import { PlaceRegistry } from "../src/index.js";

const count = Number(process.env.PLACE_COUNT ?? 20_000);
const cycles = Number(process.env.CHURN_CYCLES ?? 40);
const churnPerCycle = Number(process.env.CHURN_PER_CYCLE ?? 500);

const places = new PlaceRegistry();
places.registerDefinition({
  id: "retention-place",
  layers: [{ id: "ground" }],
  spaces: [{
    id: "room",
    layerId: "ground",
    geometry: { type: "aabb", minX: 0, minY: 0, maxX: 10, maxY: 10 }
  }]
});

let serial = 0;
const live = [];
for (let i = 0; i < count; i += 1) {
  const id = `p-${serial++}`;
  places.createPlace({ id, definitionId: "retention-place" });
  live.push(id);
}

if (global.gc) global.gc();
const baseline = process.memoryUsage().heapUsed;
const checkpoints = [];
const started = performance.now();

for (let cycle = 0; cycle < cycles; cycle += 1) {
  for (let i = 0; i < churnPerCycle; i += 1) {
    const index = (cycle * churnPerCycle + i) % live.length;
    const oldId = live[index];

    places.addPortal(oldId, {
      id: "temporary-breach",
      a: {
        domainId: `${oldId}:ground`,
        position: { x: 10, y: 5 }
      },
      b: {
        domainId: `outside-${i % 16}`,
        position: { x: i % 100, y: cycle }
      }
    });
    places.removePortal(oldId, "temporary-breach");
    places.removePlace(oldId);

    const newId = `p-${serial++}`;
    places.createPlace({ id: newId, definitionId: "retention-place" });
    live[index] = newId;
  }

  places.assertInternalConsistency();
  const diagnostics = places.getDiagnostics();
  if (diagnostics.instanceCount !== count) throw new Error("instance count drift");
  if (diagnostics.portalRecordCount !== 0) throw new Error("portal record retention after breach cleanup");

  if (global.gc) global.gc();
  const heapUsed = process.memoryUsage().heapUsed;
  checkpoints.push({
    cycle: cycle + 1,
    heapMiB: heapUsed / 1024 / 1024,
    driftMiB: (heapUsed - baseline) / 1024 / 1024
  });
}

const elapsed = performance.now() - started;
const final = checkpoints.at(-1);

console.log("=== place-core retention benchmark ===");
console.log(`instances maintained: ${count.toLocaleString()}`);
console.log(`cycles: ${cycles.toLocaleString()}`);
console.log(`create/remove pairs: ${(cycles * churnPerCycle).toLocaleString()}`);
console.log(`elapsed: ${elapsed.toFixed(2)} ms`);
console.log(`baseline post-GC heap: ${(baseline / 1024 / 1024).toFixed(2)} MiB`);
console.log(`final post-GC heap: ${final.heapMiB.toFixed(2)} MiB`);
console.log(`retained drift: ${final.driftMiB.toFixed(2)} MiB`);
console.log("checkpoints:", checkpoints);
