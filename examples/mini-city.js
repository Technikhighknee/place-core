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
  startTravel,
  stepPlaceSimulation,
  compilePlace
} from "../src/index.js";

const building = compilePlace({
  id: "small-building",
  defaultAnchorId: "room-center",
  layers: [{
    spatialMode: "owned",
    id: "ground",
    navigation: {
      nodes: [
        { id: "door", x: 0, y: 0 },
        { id: "center", x: 5, y: 0 }
      ],
      roads: [{ id: "hall", from: "door", to: "center", width: 2 }]
    }
  }],
  spaces: [{
    id: "room",
    layerId: "ground",
    geometry: { type: "aabb", minX: -1, minY: -2, maxX: 6, maxY: 2 },
    defaultAnchorId: "room-center"
  }],
  portals: [{
    id: "front-door",
    kind: "door",
    a: { kind: "external", slot: "street" },
    b: {
      kind: "local",
      layerId: "ground",
      spaceId: "room",
      position: { x: 0, y: 0 },
      nodeId: "door"
    },
    blocksWhenClosed: true
  }],
  anchors: [{
    id: "room-center",
    layerId: "ground",
    spaceId: "room",
    position: { x: 5, y: 0 },
    nodeId: "center",
    tags: ["inside"]
  }]
});

const world = new World({ domains: [{ id: "street" }] });
const navigation = new NavigationRegistry();
const street = new Navigation();
street.addNode({ id: "home-door", x: 0, y: 0 });
street.addNode({ id: "inn-door", x: 30, y: 0 });
street.addRoad({ id: "main-street", from: "home-door", to: "inn-door", width: 5 });
navigation.registerTopology("street", street);
navigation.bindDomain("street", "street");

const bridge = new WorldCoreBridge({
  world,
  navigation,
  Navigation,
  startJourney,
  stopJourney
});

const places = new PlaceRegistry({ bridge });
places.registerDefinition(building);

const home = places.createPlace({
  id: "home",
  definitionId: "small-building",
  attachments: {
    street: { domainId: "street", position: { x: 0, y: 0 }, nodeId: "home-door" }
  }
});

places.createPlace({
  id: "inn",
  definitionId: "small-building",
  attachments: {
    street: { domainId: "street", position: { x: 30, y: 0 }, nodeId: "inn-door" }
  }
});

world.addEntity({
  id: "hans",
  domainId: home.layerDomains.get("ground"),
  position: { x: 5, y: 0 },
  mobility: mobilityProfile("pedestrian")
});
places.updateEntityOccupancy(world.getEntity("hans"));

const travel = startTravel(
  places,
  bridge,
  "hans",
  { placeId: "inn", anchorId: "room-center" }
);
if (!travel) throw new Error("failed to plan mini-city travel");

let ticks = 0;
while (places.activeTravels?.has("hans") && ticks < 200) {
  stepSimulation(world, navigation, 0.5);
  stepPlaceSimulation(places, bridge, 0.5);
  ticks += 1;
}

if (places.activeTravels?.has("hans")) throw new Error("mini-city travel did not complete");

const hans = world.getEntity("hans");
const location = places.locateEntity(hans);

console.log(JSON.stringify({
  ticks,
  entity: { id: hans.id, domainId: hans.domainId, position: hans.position },
  placeId: location.placeId,
  spaceId: location.deepestSpace?.id ?? null,
  placeDiagnostics: places.getDiagnostics(),
  worldDiagnostics: world.getDiagnostics()
}, null, 2));
