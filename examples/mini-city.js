import {
  compilePlace,
  PlaceRegistry,
  serializePlaceCore,
  computePlaceCoreStateHash
} from "../src/index.js";

const tavern = compilePlace({
  id: "small-tavern",
  defaultAnchorId: "counter",
  layers: [{ id: "ground" }, { id: "cellar" }],
  spaces: [
    { id: "taproom", layerId: "ground", geometry: { type: "aabb", minX: 0, minY: 0, maxX: 20, maxY: 14 }, defaultAnchorId: "counter" },
    { id: "kitchen", layerId: "ground", geometry: { type: "aabb", minX: 20, minY: 0, maxX: 30, maxY: 14 } },
    { id: "cellar", layerId: "cellar", geometry: { type: "aabb", minX: 0, minY: 0, maxX: 30, maxY: 14 } }
  ],
  portals: [{
    id: "stairs",
    a: { kind: "local", layerId: "ground", spaceId: "taproom", position: { x: 15, y: 7 } },
    b: { kind: "local", layerId: "cellar", spaceId: "cellar", position: { x: 4, y: 7 } }
  }],
  anchors: [
    { id: "counter", layerId: "ground", spaceId: "taproom", position: { x: 10, y: 7 }, tags: ["service"] },
    { id: "barrel", layerId: "cellar", spaceId: "cellar", position: { x: 20, y: 7 }, tags: ["storage"] }
  ],
  footprint: { type: "aabb", minX: 0, minY: 0, maxX: 30, maxY: 14 }
});

const places = new PlaceRegistry({ captureEvents: true });
places.registerDefinition(tavern);
places.createPlace({
  id: "golden-goose",
  definitionId: tavern.id,
  placement: { domainId: "luebeck", transform: { x: 118, y: 73 }, containment: "footprint" }
});

console.log(places.locate("golden-goose:ground", { x: 8, y: 7 }));
console.log(places.findAnchor("golden-goose", "barrel"));
places.setPortalState("golden-goose", "stairs", { locked: true });
console.log(places.resolvePortal("golden-goose", "stairs"));
console.log("snapshot hash:", computePlaceCoreStateHash(places));
console.log("snapshot instances:", serializePlaceCore(places).instances.length);
