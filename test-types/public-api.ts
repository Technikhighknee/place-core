import {
  PlaceRegistry,
  serializePlaceCore,
  type CreatePlaceInput,
  type EmbeddedNodeBindingsState,
  type PlaceCoreSnapshot
} from "place-core";

const registry = new PlaceRegistry();

const snapshot: PlaceCoreSnapshot =
  serializePlaceCore(registry);

const instanceBindings:
  EmbeddedNodeBindingsState | undefined =
    snapshot.instances[0]
      ?.embeddedNodeBindings;

const createInput: CreatePlaceInput = {
  id: "market",
  definitionId: "marketplace",
  layerDomains: {
    market: "default"
  },
  embeddedNodeBindings: {
    anchors: {
      "food-stall": "market-food"
    },
    portals: {
      gate: {
        a: "market-gate"
      }
    }
  }
};

void instanceBindings;
void createInput;
