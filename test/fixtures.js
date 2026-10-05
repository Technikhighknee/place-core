export function tavernBlueprint() {
  return {
    id: "tavern",
    kind: "building",
    tags: ["building", "tavern"],
    defaultAnchorId: "front",
    footprint: { type: "aabb", minX: -1, minY: -1, maxX: 12, maxY: 6 },
    layers: [
      {
        spatialMode: "owned",
        id: "ground",
        navigation: {
          nodes: [
            { id: "g-door", x: 0, y: 0 },
            { id: "g-bar", x: 5, y: 0 },
            { id: "g-stairs", x: 10, y: 0 }
          ],
          roads: [
            { id: "g-main", from: "g-door", to: "g-bar", width: 2 },
            { id: "g-back", from: "g-bar", to: "g-stairs", width: 2 }
          ]
        }
      },
      {
        spatialMode: "owned",
        id: "cellar",
        navigation: {
          nodes: [
            { id: "c-stairs", x: 0, y: 0 },
            { id: "c-barrel", x: 6, y: 0 }
          ],
          roads: [
            { id: "c-main", from: "c-stairs", to: "c-barrel", width: 2 }
          ]
        }
      }
    ],
    spaces: [
      {
        id: "ground-floor",
        layerId: "ground",
        kind: "floor",
        geometry: { type: "aabb", minX: -1, minY: -2, maxX: 11, maxY: 2 },
        defaultAnchorId: "front"
      },
      {
        id: "taproom",
        layerId: "ground",
        kind: "room",
        parentSpaceId: "ground-floor",
        geometry: { type: "aabb", minX: -1, minY: -2, maxX: 7, maxY: 2 },
        defaultAnchorId: "bar"
      },
      {
        id: "cellar-room",
        layerId: "cellar",
        kind: "cellar",
        geometry: { type: "aabb", minX: -1, minY: -2, maxX: 7, maxY: 2 },
        defaultAnchorId: "barrel"
      }
    ],
    boundaries: [
      {
        id: "taproom-wall",
        layerId: "ground",
        a: { x: 7, y: -2 },
        b: { x: 7, y: 2 },
        kind: "wall"
      }
    ],
    portals: [
      {
        id: "front-door",
        kind: "door",
        a: { kind: "external", slot: "street" },
        b: {
          kind: "local",
          layerId: "ground",
          spaceId: "taproom",
          position: { x: 0, y: 0 },
          nodeId: "g-door"
        },
        transitionCost: 1,
        blocksWhenClosed: true
      },
      {
        id: "cellar-stairs",
        kind: "stairs",
        a: {
          kind: "local",
          layerId: "ground",
          position: { x: 10, y: 0 },
          nodeId: "g-stairs"
        },
        b: {
          kind: "local",
          layerId: "cellar",
          spaceId: "cellar-room",
          position: { x: 0, y: 0 },
          nodeId: "c-stairs"
        },
        transitionCost: 2
      }
    ],
    anchors: [
      {
        id: "front",
        layerId: "ground",
        spaceId: "taproom",
        position: { x: 0, y: 0 },
        nodeId: "g-door",
        tags: ["entrance"]
      },
      {
        id: "bar",
        layerId: "ground",
        spaceId: "taproom",
        position: { x: 5, y: 0 },
        nodeId: "g-bar",
        tags: ["counter"]
      },
      {
        id: "barrel",
        layerId: "cellar",
        spaceId: "cellar-room",
        position: { x: 6, y: 0 },
        nodeId: "c-barrel",
        tags: ["storage", "barrel"]
      }
    ]
  };
}
