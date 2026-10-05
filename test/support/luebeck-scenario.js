import {
  World,
  Navigation,
  NavigationRegistry,
  mobilityProfile,
  startJourney,
  stopJourney,
  stepSimulation
} from "world-core";

import {
  PlaceRegistry,
  WorldCoreBridge,
  compilePlace,
  startTravel,
  stepPlaceSimulation
} from "../../src/index.js";

export const STREET_DOMAIN = "luebeck-streets";

function semanticContainerBlueprint() {
  return {
    id: "semantic-container",
    kind: "semantic-container"
  };
}

function houseBlueprint() {
  return {
    id: "burgher-house",
    kind: "building",
    tags: ["building", "house"],
    defaultAnchorId: "bed",
    footprint: {
      type: "aabb",
      minX: -1,
      minY: -3,
      maxX: 12,
      maxY: 3
    },
    layers: [
      {
        spatialMode: "owned",
        id: "ground",
        navigation: {
          nodes: [
            { id: "front", x: 0, y: 0 },
            { id: "stairs-ground", x: 8, y: 0 }
          ],
          roads: [
            {
              id: "ground-hall",
              from: "front",
              to: "stairs-ground",
              width: 2
            }
          ]
        }
      },
      {
        spatialMode: "owned",
        id: "upper",
        navigation: {
          nodes: [
            { id: "stairs-upper", x: 0, y: 0 },
            { id: "landing", x: 4, y: 0 },
            { id: "landing-door", x: 6.3, y: 0 },
            { id: "bedroom-door", x: 6.7, y: 0 },
            { id: "bed", x: 10, y: 0 }
          ],
          roads: [
            {
              id: "upper-stairs",
              from: "stairs-upper",
              to: "landing",
              width: 2
            },
            {
              id: "landing-hall",
              from: "landing",
              to: "landing-door",
              width: 2
            },
            {
              id: "bedroom-threshold",
              from: "landing-door",
              to: "bedroom-door",
              width: 1
            },
            {
              id: "bedroom-floor",
              from: "bedroom-door",
              to: "bed",
              width: 2
            }
          ]
        }
      }
    ],
    spaces: [
      {
        id: "ground-hall",
        layerId: "ground",
        kind: "hall",
        geometry: {
          type: "aabb",
          minX: -1,
          minY: -2,
          maxX: 9,
          maxY: 2
        }
      },
      {
        id: "upper-floor",
        layerId: "upper",
        kind: "floor",
        geometry: {
          type: "aabb",
          minX: -1,
          minY: -2,
          maxX: 11,
          maxY: 2
        }
      },
      {
        id: "landing",
        layerId: "upper",
        parentSpaceId: "upper-floor",
        kind: "landing",
        geometry: {
          type: "aabb",
          minX: -1,
          minY: -2,
          maxX: 6.4,
          maxY: 2
        }
      },
      {
        id: "bedroom",
        layerId: "upper",
        parentSpaceId: "upper-floor",
        kind: "room",
        geometry: {
          type: "aabb",
          minX: 6.6,
          minY: -2,
          maxX: 11,
          maxY: 2
        },
        defaultAnchorId: "bed"
      }
    ],
    portals: [
      {
        id: "front-door",
        kind: "door",
        a: {
          kind: "external",
          slot: "street"
        },
        b: {
          kind: "local",
          layerId: "ground",
          spaceId: "ground-hall",
          position: { x: 0, y: 0 },
          nodeId: "front"
        },
        transitionCost: 0.5,
        blocksWhenClosed: true
      },
      {
        id: "stairs",
        kind: "stairs",
        a: {
          kind: "local",
          layerId: "ground",
          spaceId: "ground-hall",
          position: { x: 8, y: 0 },
          nodeId: "stairs-ground"
        },
        b: {
          kind: "local",
          layerId: "upper",
          spaceId: "landing",
          position: { x: 0, y: 0 },
          nodeId: "stairs-upper"
        },
        transitionCost: 1
      },
      {
        id: "bedroom-door",
        kind: "door",
        a: {
          kind: "local",
          layerId: "upper",
          spaceId: "landing",
          position: { x: 6.3, y: 0 },
          nodeId: "landing-door"
        },
        b: {
          kind: "local",
          layerId: "upper",
          spaceId: "bedroom",
          position: { x: 6.7, y: 0 },
          nodeId: "bedroom-door"
        },
        blocksWhenClosed: true,
        roadBindings: [{
          layerId: "upper",
          roadId: "bedroom-threshold"
        }]
      }
    ],
    anchors: [
      {
        id: "bed",
        layerId: "upper",
        spaceId: "bedroom",
        position: { x: 10, y: 0 },
        nodeId: "bed",
        tags: ["sleep", "bed"]
      },
      {
        id: "front",
        layerId: "ground",
        spaceId: "ground-hall",
        position: { x: 0, y: 0 },
        nodeId: "front",
        tags: ["entrance"]
      }
    ]
  };
}

function tavernBlueprint() {
  return {
    id: "luebeck-tavern",
    kind: "building",
    tags: ["building", "tavern"],
    defaultAnchorId: "barrel",
    footprint: {
      type: "aabb",
      minX: -1,
      minY: -4,
      maxX: 16,
      maxY: 4
    },
    layers: [
      {
        spatialMode: "owned",
        id: "ground",
        navigation: {
          nodes: [
            { id: "front", x: 0, y: 0 },
            { id: "bar", x: 5, y: 0 },
            { id: "main-stairs", x: 10, y: 0 },
            { id: "service-stairs", x: 14, y: 0 }
          ],
          roads: [
            { id: "front-bar", from: "front", to: "bar", width: 2 },
            { id: "bar-main", from: "bar", to: "main-stairs", width: 2 },
            { id: "bar-service", from: "bar", to: "service-stairs", width: 2 }
          ]
        }
      },
      {
        spatialMode: "owned",
        id: "cellar",
        navigation: {
          nodes: [
            { id: "main-cellar", x: 0, y: 0 },
            { id: "barrel", x: 4, y: 0 },
            { id: "service-cellar", x: 8, y: 0 }
          ],
          roads: [
            { id: "main-barrel", from: "main-cellar", to: "barrel", width: 2 },
            { id: "service-barrel", from: "service-cellar", to: "barrel", width: 2 }
          ]
        }
      }
    ],
    spaces: [
      {
        id: "taproom",
        layerId: "ground",
        kind: "taproom",
        geometry: {
          type: "aabb",
          minX: -1,
          minY: -3,
          maxX: 15,
          maxY: 3
        }
      },
      {
        id: "cellar-room",
        layerId: "cellar",
        kind: "cellar",
        geometry: {
          type: "aabb",
          minX: -1,
          minY: -3,
          maxX: 9,
          maxY: 3
        },
        defaultAnchorId: "barrel"
      }
    ],
    portals: [
      {
        id: "front-door",
        kind: "door",
        a: {
          kind: "external",
          slot: "street"
        },
        b: {
          kind: "local",
          layerId: "ground",
          spaceId: "taproom",
          position: { x: 0, y: 0 },
          nodeId: "front"
        },
        transitionCost: 0.5,
        blocksWhenClosed: true
      },
      {
        id: "cellar-main",
        kind: "stairs",
        a: {
          kind: "local",
          layerId: "ground",
          spaceId: "taproom",
          position: { x: 10, y: 0 },
          nodeId: "main-stairs"
        },
        b: {
          kind: "local",
          layerId: "cellar",
          spaceId: "cellar-room",
          position: { x: 0, y: 0 },
          nodeId: "main-cellar"
        },
        transitionCost: 1
      },
      {
        id: "cellar-service",
        kind: "stairs",
        a: {
          kind: "local",
          layerId: "ground",
          spaceId: "taproom",
          position: { x: 14, y: 0 },
          nodeId: "service-stairs"
        },
        b: {
          kind: "local",
          layerId: "cellar",
          spaceId: "cellar-room",
          position: { x: 8, y: 0 },
          nodeId: "service-cellar"
        },
        transitionCost: 3
      }
    ],
    anchors: [
      {
        id: "bar",
        layerId: "ground",
        spaceId: "taproom",
        position: { x: 5, y: 0 },
        nodeId: "bar",
        tags: ["counter"]
      },
      {
        id: "barrel",
        layerId: "cellar",
        spaceId: "cellar-room",
        position: { x: 4, y: 0 },
        nodeId: "barrel",
        tags: ["storage", "barrel"]
      }
    ]
  };
}

function attachedPlaceBlueprint(id, kind, anchorTag) {
  return {
    id,
    kind,
    footprint: {
      type: "aabb",
      minX: -1,
      minY: -2,
      maxX: 8,
      maxY: 2
    },
    layers: [{
      spatialMode: "owned",
      id: "inside",
      navigation: {
        nodes: [
          { id: "door", x: 0, y: 0 },
          { id: "center", x: 6, y: 0 }
        ],
        roads: [{
          id: "inside-road",
          from: "door",
          to: "center",
          width: 2
        }]
      }
    }],
    spaces: [{
      id: "inside",
      layerId: "inside",
      kind,
      geometry: {
        type: "aabb",
        minX: -1,
        minY: -2,
        maxX: 7,
        maxY: 2
      },
      defaultAnchorId: "center"
    }],
    portals: [{
      id: "entrance",
      a: {
        kind: "external",
        slot: "street"
      },
      b: {
        kind: "local",
        layerId: "inside",
        spaceId: "inside",
        position: { x: 0, y: 0 },
        nodeId: "door"
      }
    }],
    anchors: [{
      id: "center",
      layerId: "inside",
      spaceId: "inside",
      position: { x: 6, y: 0 },
      nodeId: "center",
      tags: [anchorTag]
    }]
  };
}

function shipBlueprint() {
  return {
    id: "cog",
    kind: "ship",
    tags: ["ship"],
    footprint: {
      type: "aabb",
      minX: -8,
      minY: -3,
      maxX: 8,
      maxY: 3
    },
    layers: [{
      spatialMode: "owned",
      id: "deck",
      navigation: {
        nodes: [
          { id: "gangplank", x: -6, y: 0 },
          { id: "mast", x: 0, y: 0 },
          { id: "stern", x: 6, y: 0 }
        ],
        roads: [
          { id: "fore-deck", from: "gangplank", to: "mast", width: 3 },
          { id: "aft-deck", from: "mast", to: "stern", width: 3 }
        ]
      }
    }],
    spaces: [{
      id: "deck",
      layerId: "deck",
      kind: "deck",
      geometry: {
        type: "aabb",
        minX: -8,
        minY: -3,
        maxX: 8,
        maxY: 3
      },
      defaultAnchorId: "stern"
    }],
    portals: [{
      id: "gangplank",
      kind: "gangplank",
      a: {
        kind: "external",
        slot: "quay"
      },
      b: {
        kind: "local",
        layerId: "deck",
        spaceId: "deck",
        position: { x: -6, y: 0 },
        nodeId: "gangplank"
      },
      transitionCost: 1
    }],
    anchors: [{
      id: "stern",
      layerId: "deck",
      spaceId: "deck",
      position: { x: 6, y: 0 },
      nodeId: "stern",
      tags: ["ship-stern"]
    }]
  };
}

function makeStreetTopology() {
  const navigation = new Navigation();
  const stops = [
    { id: "city-gate", x: 0 },
    ...Array.from({ length: 50 }, (_, i) => ({
      id: `house-${i}-door`,
      x: 10 + i * 4
    })),
    { id: "courtyard-door", x: 214 },
    { id: "warehouse-door", x: 224 },
    { id: "tavern-door", x: 236 },
    { id: "quay-a", x: 248 },
    { id: "quay-b", x: 260 }
  ];

  for (const stop of stops) {
    navigation.addNode({
      id: stop.id,
      x: stop.x,
      y: 0
    });
  }

  for (let i = 1; i < stops.length; i += 1) {
    navigation.addRoad({
      id: `street-${i - 1}-${i}`,
      from: stops[i - 1].id,
      to: stops[i].id,
      width: 6,
      surface: "road"
    });
  }

  return navigation;
}

export function buildLuebeckScenario({ captureEvents = true } = {}) {
  const world = new World({
    domains: [{ id: STREET_DOMAIN }]
  });
  const navigation = new NavigationRegistry();
  navigation.registerTopology(STREET_DOMAIN, makeStreetTopology());
  navigation.bindDomain(STREET_DOMAIN, STREET_DOMAIN);

  const bridge = new WorldCoreBridge({
    world,
    navigation,
    Navigation,
    startJourney,
    stopJourney
  });

  const places = new PlaceRegistry({
    captureEvents,
    eventQueueLimit: 10000
  });
  places.attachWorldCoreBridge(bridge);

  const definitions = {
    semantic: compilePlace(semanticContainerBlueprint()),
    house: compilePlace(houseBlueprint()),
    tavern: compilePlace(tavernBlueprint()),
    courtyard: compilePlace(
      attachedPlaceBlueprint("courtyard-place", "courtyard", "courtyard")
    ),
    warehouse: compilePlace(
      attachedPlaceBlueprint("warehouse-place", "warehouse", "storage")
    ),
    gate: compilePlace(
      attachedPlaceBlueprint("city-gate-place", "gate", "gate")
    ),
    ship: compilePlace(shipBlueprint())
  };

  for (const definition of Object.values(definitions)) {
    places.registerDefinition(definition);
  }

  places.createPlace({
    id: "luebeck",
    definitionId: definitions.semantic.id
  });
  places.createPlace({
    id: "merchant-quarter",
    definitionId: definitions.semantic.id,
    parentId: "luebeck"
  });
  places.createPlace({
    id: "tax-ward-3",
    definitionId: definitions.semantic.id,
    parentId: "luebeck"
  });
  places.createPlace({
    id: "harbor",
    definitionId: definitions.semantic.id,
    parentId: "luebeck"
  });

  const houses = [];
  for (let i = 0; i < 50; i += 1) {
    houses.push(places.createPlace({
      id: `house-${i}`,
      definitionId: definitions.house.id,
      parentId: "merchant-quarter",
      memberships: [{
        parentPlaceId: "tax-ward-3",
        kind: "tax-jurisdiction"
      }],
      attachments: {
        street: {
          domainId: STREET_DOMAIN,
          position: { x: 10 + i * 4, y: 0 },
          nodeId: `house-${i}-door`
        }
      },
      placement: {
        domainId: STREET_DOMAIN,
        transform: {
          x: 10 + i * 4,
          y: 8,
          rotation: 0,
          scale: 1
        },
        containment: "footprint"
      }
    }));
  }

  const courtyard = places.createPlace({
    id: "merchant-courtyard",
    definitionId: definitions.courtyard.id,
    parentId: "merchant-quarter",
    attachments: {
      street: {
        domainId: STREET_DOMAIN,
        position: { x: 214, y: 0 },
        nodeId: "courtyard-door"
      }
    }
  });

  const warehouse = places.createPlace({
    id: "salt-warehouse",
    definitionId: definitions.warehouse.id,
    parentId: "merchant-quarter",
    attachments: {
      street: {
        domainId: STREET_DOMAIN,
        position: { x: 224, y: 0 },
        nodeId: "warehouse-door"
      }
    }
  });

  const tavern = places.createPlace({
    id: "golden-goose",
    definitionId: definitions.tavern.id,
    parentId: "merchant-quarter",
    memberships: [{
      parentPlaceId: "tax-ward-3",
      kind: "tax-jurisdiction"
    }],
    attachments: {
      street: {
        domainId: STREET_DOMAIN,
        position: { x: 236, y: 0 },
        nodeId: "tavern-door"
      }
    }
  });

  const gate = places.createPlace({
    id: "city-gate",
    definitionId: definitions.gate.id,
    parentId: "luebeck",
    attachments: {
      street: {
        domainId: STREET_DOMAIN,
        position: { x: 0, y: 0 },
        nodeId: "city-gate"
      }
    }
  });

  const ship = places.createPlace({
    id: "cog-hildegard",
    definitionId: definitions.ship.id,
    parentId: "harbor",
    attachments: {
      quay: {
        domainId: STREET_DOMAIN,
        position: { x: 248, y: 0 },
        nodeId: "quay-a"
      }
    },
    placement: {
      domainId: STREET_DOMAIN,
      transform: {
        x: 248,
        y: 12,
        rotation: 0,
        scale: 1
      },
      containment: "footprint"
    }
  });

  const home = houses[17];
  world.addEntity({
    id: "hans",
    kind: "person",
    domainId: home.layerDomains.get("upper"),
    position: { x: 10, y: 0 },
    body: { radius: 0.3 },
    mobility: mobilityProfile("pedestrian")
  });

  world.addEntity({
    id: "sailor",
    kind: "person",
    domainId: ship.layerDomains.get("deck"),
    position: { x: 6, y: 0 },
    body: { radius: 0.3 },
    mobility: mobilityProfile("pedestrian")
  });

  places.updateEntityOccupancy(world.getEntity("hans"));
  places.updateEntityOccupancy(world.getEntity("sailor"));
  places.drainEvents();

  return {
    world,
    navigation,
    bridge,
    places,
    definitions,
    houses,
    home,
    courtyard,
    warehouse,
    tavern,
    gate,
    ship
  };
}

export function addLuebeckTraveler(
  scenario,
  entityId,
  houseIndex
) {
  if (!Number.isInteger(houseIndex) ||
      houseIndex < 0 ||
      houseIndex >= scenario.houses.length) {
    throw new RangeError("houseIndex must reference an existing Lübeck house");
  }
  const house = scenario.houses[houseIndex];
  scenario.world.addEntity({
    id: entityId,
    kind: "person",
    domainId: house.layerDomains.get("upper"),
    position: { x: 10, y: 0 },
    body: { radius: 0.3 },
    mobility: mobilityProfile("pedestrian")
  });
  scenario.places.updateEntityOccupancy(
    scenario.world.getEntity(entityId)
  );
  return scenario.world.getEntity(entityId);
}

export function stepScenario(
  scenario,
  deltaSeconds = 0.5
) {
  stepSimulation(
    scenario.world,
    scenario.navigation,
    deltaSeconds
  );
  stepPlaceSimulation(
    scenario.places,
    scenario.bridge,
    deltaSeconds
  );
}

export function runTravelToCompletion(
  scenario,
  entityId = "hans",
  {
    deltaSeconds = 0.5,
    maxTicks = 2000
  } = {}
) {
  let ticks = 0;
  while (scenario.places.activeTravels.has(entityId) &&
         ticks < maxTicks) {
    stepScenario(scenario, deltaSeconds);
    ticks += 1;
  }
  if (scenario.places.activeTravels.has(entityId)) {
    throw new Error(
      `travel for ${entityId} did not complete within ${maxTicks} ticks`
    );
  }
  return ticks;
}

export function startHansToBarrel(
  scenario,
  options = {}
) {
  return startTravel(
    scenario.places,
    scenario.bridge,
    "hans",
    {
      placeId: "golden-goose",
      anchorId: "barrel"
    },
    options
  );
}
