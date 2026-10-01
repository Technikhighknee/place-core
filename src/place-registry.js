import {
  PlaceRegistry as CorePlaceRegistry,
  PlaceInstance,
  isPortalTraversable
} from "./registry.js";
import { compilePlace, CompiledPlaceDefinition } from "./definition.js";
import {
  assertId,
  assertStringId,
  compareStrings,
  deepFreeze,
  normalizeBoolean
} from "./utils.js";
import { typedIdKey } from "./registry/support.js";

export class PlaceRegistry extends CorePlaceRegistry {
  registerDefinition(input, options) {
    const definition = input instanceof CompiledPlaceDefinition
      ? input
      : compilePlace(input, options);
    return super.registerDefinition(definition);
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

  findAnchors(options = {}) {
    if (!options ||
        typeof options !== "object" ||
        Array.isArray(options)) {
      throw new TypeError(
        "findAnchors options must be a plain object"
      );
    }
    const prototype = Object.getPrototypeOf(options);
    if (prototype !== Object.prototype &&
        prototype !== null) {
      throw new TypeError(
        "findAnchors options must be a plain object"
      );
    }
    const allowed = new Set([
      "placeId",
      "tag",
      "kind",
      "spaceId",
      "enabledOnly"
    ]);
    for (const key of Object.keys(options)) {
      if (!allowed.has(key)) {
        throw new Error(
          `findAnchors options contains unknown field ${key}`
        );
      }
    }

    const {
      placeId = null,
      tag = null,
      kind = null,
      spaceId = null,
      enabledOnly: rawEnabledOnly = false
    } = options;

    if (placeId != null) {
      assertId(placeId, "findAnchors.placeId");
    }
    for (const [value, label] of [
      [tag, "findAnchors.tag"],
      [kind, "findAnchors.kind"],
      [spaceId, "findAnchors.spaceId"]
    ]) {
      if (value != null) {
        assertStringId(value, label);
      }
    }

    const enabledOnly = normalizeBoolean(
      rawEnabledOnly,
      "findAnchors.enabledOnly",
      { defaultValue: false }
    );

    const result = [];
    const places = placeId == null
      ? [...this.instances.values()]
          .sort((a, b) =>
            compareStrings(
              typedIdKey(a.id),
              typedIdKey(b.id)
            )
          )
      : [this.getPlace(placeId)]
          .filter(Boolean);

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
    const places = placeId == null
      ? [...this.instances.values()]
          .sort((a, b) =>
            compareStrings(
              typedIdKey(a.id),
              typedIdKey(b.id)
            )
          )
      : [this.getPlace(placeId)]
          .filter(Boolean);

    for (const instance of places) {
      const definition =
        this.getDefinition(instance.definitionId);

      for (const portal of definition.portals) {
        yield this.resolvePortal(
          instance.id,
          portal.id
        );
      }

      const dynamicPortalIds = [
        ...instance.dynamicPortals.keys()
      ].sort(compareStrings);
      for (const portalId of dynamicPortalIds) {
        yield this.resolvePortal(
          instance.id,
          portalId
        );
      }
    }
  }
}

export { PlaceInstance, isPortalTraversable };
