import {
  PlaceRegistry as CorePlaceRegistry,
  PlaceInstance,
  isPortalTraversable
} from "./registry.js";
import { compilePlace, CompiledPlaceDefinition } from "./definition.js";
import { deepFreeze, normalizeBoolean } from "./utils.js";

export class PlaceRegistry extends CorePlaceRegistry {
  constructor(options = {}) {
    const normalized = { ...options };

    if (normalized.worldCoreBridge != null) {
      if (normalized.bridge != null &&
          normalized.bridge !== normalized.worldCoreBridge) {
        throw new Error(
          "cannot specify both bridge and worldCoreBridge with different values"
        );
      }
      normalized.bridge ??= normalized.worldCoreBridge;
      delete normalized.worldCoreBridge;
    }

    super(normalized);
  }

  attachWorldCoreBridge(bridge) {
    return this.attachBridge(bridge);
  }

  registerDefinition(input, options) {
    const definition = input instanceof CompiledPlaceDefinition
      ? input
      : compilePlace(input, options);
    return super.registerDefinition(definition);
  }

  createPlace(input) {
    if (!input ||
        typeof input !== "object" ||
        Array.isArray(input)) {
      return super.createPlace(input);
    }

    const normalized = { ...input };

    if (normalized.externalBindings != null) {
      if (normalized.attachments != null) {
        throw new Error(
          "cannot specify both attachments and externalBindings"
        );
      }
      normalized.attachments = normalized.externalBindings;
    }
    delete normalized.externalBindings;

    if (normalized.parentPlaceId != null) {
      if (normalized.parentId != null) {
        throw new Error(
          "cannot specify both parentId and parentPlaceId"
        );
      }
      normalized.parentId = normalized.parentPlaceId;
    }
    delete normalized.parentPlaceId;

    if (normalized.layerDomains instanceof Map) {
      normalized.layerDomains =
        Object.fromEntries(normalized.layerDomains);
    }

    if (normalized.placementDomainId != null) {
      const placement = normalized.placement;

      if (placement?.domainId != null ||
          placement?.parentPlaceId != null) {
        throw new Error(
          "placementDomainId cannot be combined with canonical placement ownership"
        );
      }

      normalized.placement = {
        domainId: normalized.placementDomainId,
        transform: placement ?? {},
        containment: normalized.containment ?? "footprint"
      };
    } else if (normalized.containment != null) {
      throw new Error(
        "top-level containment requires placementDomainId"
      );
    }

    delete normalized.placementDomainId;
    delete normalized.containment;

    return super.createPlace(normalized);
  }

  getLayerDomain(placeId, layerId) {
    return this.domainForLayer(placeId, layerId);
  }

  resolveAnchor(placeId, anchorId) {
    return this.findAnchor(placeId, anchorId);
  }

  resolveBoundary(placeId, boundaryId) {
    return this.getBoundary(placeId, boundaryId);
  }

  addPortal(placeId, portal) {
    return this.addInstancePortal(placeId, portal);
  }

  removePortal(placeId, portalId) {
    return this.removeInstancePortal(placeId, portalId);
  }

  setExternalBinding(placeId, slot, endpoint) {
    return this.setAttachment(placeId, slot, endpoint);
  }

  clearExternalBinding(placeId, slot) {
    return this.clearAttachment(placeId, slot);
  }

  updateEntityOccupancy(entity) {
    return this.syncEntityOccupancy(entity);
  }

  locate(domainId, position) {
    const location = super.locate(domainId, position);
    const binding = this.getDomainBinding(domainId);
    const spaces = location.spaces.map((space) => ({
      ...space,
      id: space.spaceId
    }));
    const deepestSpace = spaces.length ? spaces[spaces.length - 1] : null;

    return deepFreeze({
      ...location,
      spaces,
      placeId: location.places.length ? location.places[location.places.length - 1] : null,
      layerId: binding?.layerId ?? null,
      deepestSpace
    });
  }

  locateEntity(entity) {
    if (!entity) throw new TypeError("entity is required");
    return this.locate(entity.domainId ?? "default", entity.position);
  }

  placesAt(domainId, position) {
    return this.locate(domainId, position).places
      .map((placeId) => this.getPlace(placeId))
      .filter(Boolean);
  }

  findAnchors({
    placeId = null,
    tag = null,
    kind = null,
    spaceId = null,
    enabledOnly = false
  } = {}) {
    enabledOnly = normalizeBoolean(
      enabledOnly,
      "findAnchors.enabledOnly",
      { defaultValue: false }
    );

    const result = [];
    const places = placeId == null
      ? this.instances.values()
      : [this.getPlace(placeId)].filter(Boolean);

    for (const instance of places) {
      const definition = this.getDefinition(instance.definitionId);
      let anchors = tag != null
        ? definition.getAnchorsByTag(tag)
        : definition.anchors;

      if (spaceId != null) {
        anchors = anchors.filter(
          (anchor) => anchor.spaceId === spaceId
        );
      }
      if (kind != null) {
        anchors = anchors.filter(
          (anchor) => anchor.kind === kind
        );
      }

      for (const anchor of anchors) {
        if (enabledOnly && anchor.spaceId != null) {
          if (this.getSpace(instance.id, anchor.spaceId)?.enabled !== true) {
            continue;
          }
        }

        result.push({
          ...anchor,
          placeId: instance.id,
          domainId: instance.layerDomains.get(anchor.layerId)
        });
      }
    }
    return result;
  }

  *resolvedPortals(placeId = null) {
    const places = placeId == null ? this.instances.values() : [this.getPlace(placeId)].filter(Boolean);
    for (const instance of places) {
      const definition = this.getDefinition(instance.definitionId);
      for (const portal of definition.portals) yield this.resolvePortal(instance.id, portal.id);
      for (const portalId of instance.dynamicPortals.keys()) yield this.resolvePortal(instance.id, portalId);
    }
  }
}

export { PlaceInstance, isPortalTraversable };
