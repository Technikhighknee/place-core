import {
  StaticGeometryIndex,
  cloneVec2,
  geometryBounds,
  geometryContainsGeometry,
  normalizeGeometry,
  pointInGeometry
} from "./geometry.js";
import {
  assertStringId,
  canonicalStringify,
  cloneJson,
  deepFreeze,
  normalizeBoolean,
  normalizeStringList,
  sha256
} from "./utils.js";

const DEFAULT_SPACE_INDEX_CELL_SIZE = 8;

function uniqueById(items, label) {
  const seen = new Set();
  for (const item of items) {
    assertStringId(item.id, `${label}.id`);
    if (seen.has(item.id)) throw new Error(`duplicate ${label} id: ${item.id}`);
    seen.add(item.id);
  }
}

function requireArray(value, label, defaultValue = []) {
  if (value === undefined) return defaultValue;
  if (!Array.isArray(value)) {
    throw new TypeError(`${label} must be an array`);
  }
  return value;
}

function normalizeKind(value, label, defaultValue) {
  const kind = value ?? defaultValue;
  assertStringId(kind, label);
  return kind;
}

function normalizeNullableStringId(value, label) {
  if (value == null) return null;
  assertStringId(value, label);
  return value;
}

function normalizeNavigationSpec(spec, label) {
  if (spec == null) return null;
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) {
    throw new TypeError(`${label} must be an object`);
  }

  const rawOptions = spec.options ?? {};
  if (!rawOptions ||
      typeof rawOptions !== "object" ||
      Array.isArray(rawOptions)) {
    throw new TypeError(`${label}.options must be an object`);
  }

  const optionDefaults = {
    spatialCellSize: 50,
    routeCacheSize: 5000,
    routeCacheMaxLegs: 256,
    routeCacheMaxTotalLegs: 100000,
    hierarchicalRouteCacheSize: 1000,
    regionalRouteCacheSize: 5000
  };
  for (const key of Object.keys(rawOptions)) {
    if (!Object.hasOwn(optionDefaults, key)) {
      throw new Error(`${label}.options contains unknown field ${key}`);
    }
  }

  const options = {};
  for (const [key, defaultValue] of Object.entries(optionDefaults)) {
    const value = rawOptions[key] ?? defaultValue;
    if (key === "spatialCellSize") {
      if (!Number.isFinite(value) || value <= 0) {
        throw new RangeError(
          `${label}.options.spatialCellSize must be a finite number > 0`
        );
      }
    } else if (!Number.isInteger(value) || value < 0) {
      throw new RangeError(
        `${label}.options.${key} must be an integer >= 0`
      );
    }
    options[key] = value;
  }
  const regions = requireArray(
    spec.regions,
    `${label}.regions`
  ).map((region, index) => {
    assertStringId(region.id, `${label}.regions[${index}].id`);
    return deepFreeze({ id: region.id });
  });
  uniqueById(regions, `${label}.region`);
  const regionIds = new Set(regions.map((x) => x.id));
  const nodes = requireArray(
    spec.nodes,
    `${label}.nodes`
  ).map((node, index) => {
    assertStringId(node.id, `${label}.nodes[${index}].id`);
    if (!Number.isFinite(node.x) ||
        !Number.isFinite(node.y)) {
      throw new TypeError(
        `${label}.node ${node.id} requires finite x/y`
      );
    }
    if (node.regionId != null &&
        !regionIds.has(node.regionId)) {
      throw new Error(
        `${label}.node ${node.id} references unknown region ${node.regionId}`
      );
    }
    const junctionRadius = node.junctionRadius ?? 0;
    if (!Number.isFinite(junctionRadius) || junctionRadius < 0) {
      throw new RangeError(
        `${label}.node ${node.id} junctionRadius must be a finite number >= 0`
      );
    }
    return deepFreeze({
      id: node.id,
      x: node.x,
      y: node.y,
      junctionRadius,
      regionId: node.regionId ?? null
    });
  });
  uniqueById(nodes, `${label}.node`);
  const nodeIds = new Set(nodes.map((x) => x.id));
  const roads = requireArray(
    spec.roads,
    `${label}.roads`
  ).map((road, index) => {
    assertStringId(road.id, `${label}.roads[${index}].id`);
    assertStringId(road.from, `${label}.road(${road.id}).from`);
    assertStringId(road.to, `${label}.road(${road.id}).to`);
    if (!nodeIds.has(road.from) || !nodeIds.has(road.to)) {
      throw new Error(`${label}.road ${road.id} references unknown node`);
    }

    const width = road.width ?? 4;
    if (!Number.isFinite(width) || width <= 0) {
      throw new RangeError(
        `${label}.road ${road.id} width must be a finite number > 0`
      );
    }

    const surface = road.surface ?? "street";
    assertStringId(surface, `${label}.road(${road.id}).surface`);

    if (road.shape != null && !Array.isArray(road.shape)) {
      throw new TypeError(
        `${label}.road(${road.id}).shape must be an array of Vec2 points`
      );
    }
    const shape = Object.freeze(
      (road.shape ?? []).map((point, shapeIndex) => {
        try {
          return cloneVec2(point);
        } catch (error) {
          throw new TypeError(
            `${label}.road(${road.id}).shape[${shapeIndex}] must be a finite Vec2`,
            { cause: error }
          );
        }
      })
    );

    return deepFreeze({
      id: road.id,
      from: road.from,
      to: road.to,
      shape,
      width,
      surface,
      bidirectional: normalizeBoolean(
        road.bidirectional,
        `${label}.road(${road.id}).bidirectional`,
        { defaultValue: true }
      ),
      enabled: normalizeBoolean(
        road.enabled,
        `${label}.road(${road.id}).enabled`,
        { defaultValue: true }
      ),
      allowedProfiles: normalizeStringList(
        road.allowedProfiles,
        `${label}.road(${road.id}).allowedProfiles`,
        { allowNull: true, defaultValue: null }
      ),
      blockedProfiles: normalizeStringList(
        road.blockedProfiles,
        `${label}.road(${road.id}).blockedProfiles`,
        { defaultValue: [] }
      ),
      tags: normalizeStringList(
        road.tags,
        `${label}.road(${road.id}).tags`,
        { defaultValue: [] }
      )
    });
  });
  uniqueById(roads, `${label}.road`);
  return deepFreeze({
    options: deepFreeze(options),
    regions: Object.freeze(regions),
    nodes: Object.freeze(nodes),
    roads: Object.freeze(roads)
  });
}

function normalizeDefinitionRevision(value) {
  const revision = value ?? 1;
  if (typeof revision === "string") {
    assertStringId(revision, "place.revision");
    return revision;
  }
  if (typeof revision === "number" && Number.isFinite(revision)) {
    return revision;
  }
  throw new TypeError(
    "place.revision must be a non-empty string or finite number"
  );
}

function defaultTopologyId(definitionId, layerId) {
  return `${encodeURIComponent(definitionId)}:${encodeURIComponent(layerId)}`;
}

function normalizeLayer(layer, definitionId) {
  assertStringId(layer.id, "layer.id");
  const navigation = normalizeNavigationSpec(
    layer.navigation,
    `layer(${layer.id}).navigation`
  );
  const topologyId = layer.topologyId ??
    (navigation ? defaultTopologyId(definitionId, layer.id) : null);
  if (topologyId != null) {
    assertStringId(topologyId, `layer(${layer.id}).topologyId`);
  }

  return deepFreeze({
    id: layer.id,
    kind: normalizeKind(
      layer.kind,
      `layer(${layer.id}).kind`,
      "spatial-layer"
    ),
    tags: normalizeStringList(layer.tags, `layer(${layer.id}).tags`, { defaultValue: [] }),
    topologyId,
    navigation,
    metadata: cloneJson(layer.metadata ?? null)
  });
}

function normalizeSpace(space, layersById) {
  assertStringId(space.id, "space.id");
  assertStringId(space.layerId, `space(${space.id}).layerId`);
  if (!layersById.has(space.layerId)) throw new Error(`space ${space.id} references unknown layer ${space.layerId}`);
  const geometry = normalizeGeometry(space.geometry);
  const parentSpaceId = normalizeNullableStringId(
    space.parentSpaceId,
    `space(${space.id}).parentSpaceId`
  );
  const defaultAnchorId = normalizeNullableStringId(
    space.defaultAnchorId,
    `space(${space.id}).defaultAnchorId`
  );
  return deepFreeze({
    id: space.id,
    layerId: space.layerId,
    kind: normalizeKind(
      space.kind,
      `space(${space.id}).kind`,
      "space"
    ),
    tags: normalizeStringList(space.tags, `space(${space.id}).tags`, { defaultValue: [] }),
    geometry,
    parentSpaceId,
    defaultAnchorId,
    priority: (() => {
      const value = space.priority ?? 0;
      if (!Number.isFinite(value)) {
        throw new TypeError(`space(${space.id}).priority must be a finite number`);
      }
      return value;
    })(),
    metadata: cloneJson(space.metadata ?? null)
  });
}

function normalizeBoundary(boundary, layersById) {
  assertStringId(boundary.id, "boundary.id");
  assertStringId(boundary.layerId, `boundary(${boundary.id}).layerId`);
  if (!layersById.has(boundary.layerId)) {
    throw new Error(
      `boundary ${boundary.id} references unknown layer ${boundary.layerId}`
    );
  }
  if (!boundary.a || !boundary.b) throw new TypeError(`boundary ${boundary.id} requires endpoints a and b`);
  const roadBindings = requireArray(
    boundary.roadBindings,
    `boundary(${boundary.id}).roadBindings`
  ).map((binding, index) => {
    assertStringId(binding.roadId, `boundary(${boundary.id}).roadBindings[${index}].roadId`);
    return deepFreeze({ roadId: binding.roadId });
  });
  return deepFreeze({
    id: boundary.id,
    layerId: boundary.layerId,
    kind: normalizeKind(
      boundary.kind,
      `boundary(${boundary.id}).kind`,
      "wall"
    ),
    tags: normalizeStringList(boundary.tags, `boundary(${boundary.id}).tags`, { defaultValue: [] }),
    a: cloneVec2(boundary.a),
    b: cloneVec2(boundary.b),
    enabled: normalizeBoolean(
      boundary.enabled,
      `boundary(${boundary.id}).enabled`,
      { defaultValue: true }
    ),
    roadBindings: Object.freeze(roadBindings),
    metadata: cloneJson(boundary.metadata ?? null)
  });
}

function normalizeEndpoint(endpoint, portalId, layersById, spacesById) {
  if (!endpoint || typeof endpoint !== "object") throw new TypeError(`portal ${portalId} endpoint is required`);
  const kind = endpoint.kind ?? "local";
  if (kind === "local") {
    assertStringId(endpoint.layerId, `portal(${portalId}).endpoint.layerId`);
    if (!layersById.has(endpoint.layerId)) {
    throw new Error(
      `portal ${portalId} references unknown layer ${endpoint.layerId}`
    );
  }
    let space = null;
    if (endpoint.spaceId != null) {
      space = spacesById.get(endpoint.spaceId);
      if (!space) {
        throw new Error(`portal ${portalId} references unknown space ${endpoint.spaceId}`);
      }
      if (space.layerId !== endpoint.layerId) {
        throw new Error(
          `portal ${portalId} endpoint space ${endpoint.spaceId} is on another layer`
        );
      }
    }
    const position = cloneVec2(endpoint.position);
    const nodeId = normalizeNullableStringId(
      endpoint.nodeId,
      `portal(${portalId}).endpoint.nodeId`
    );
    if (space && !pointInGeometry(position, space.geometry)) {
      throw new Error(
        `portal ${portalId} endpoint is outside space ${endpoint.spaceId}`
      );
    }
    return deepFreeze({
      kind: "local",
      layerId: endpoint.layerId,
      spaceId: endpoint.spaceId ?? null,
      position,
      nodeId,
      metadata: cloneJson(endpoint.metadata ?? null)
    });
  }
  if (kind === "external") {
    assertStringId(endpoint.slot, `portal(${portalId}).endpoint.slot`);
    return deepFreeze({
      kind: "external",
      slot: endpoint.slot,
      metadata: cloneJson(endpoint.metadata ?? null)
    });
  }
  throw new TypeError(`portal ${portalId} has unsupported endpoint kind ${kind}`);
}

function normalizePortal(portal, layersById, spacesById) {
  assertStringId(portal.id, "portal.id");
  const transitionCost = portal.transitionCost ?? 0;
  if (!Number.isFinite(transitionCost) || transitionCost < 0) {
    throw new RangeError(
      `portal ${portal.id} transitionCost must be a finite number >= 0`
    );
  }
  const a = normalizeEndpoint(portal.a, portal.id, layersById, spacesById);
  const b = normalizeEndpoint(portal.b, portal.id, layersById, spacesById);
  const roadBindings = requireArray(
    portal.roadBindings,
    `portal(${portal.id}).roadBindings`
  ).map((binding, index) => {
    assertStringId(binding.layerId, `portal(${portal.id}).roadBindings[${index}].layerId`);
    assertStringId(binding.roadId, `portal(${portal.id}).roadBindings[${index}].roadId`);
    if (!layersById.has(binding.layerId)) {
      throw new Error(
        `portal ${portal.id} road binding references unknown layer ${binding.layerId}`
      );
    }
    return deepFreeze({ layerId: binding.layerId, roadId: binding.roadId });
  });
  return deepFreeze({
    id: portal.id,
    kind: normalizeKind(
      portal.kind,
      `portal(${portal.id}).kind`,
      "portal"
    ),
    tags: normalizeStringList(portal.tags, `portal(${portal.id}).tags`, { defaultValue: [] }),
    a,
    b,
    bidirectional: normalizeBoolean(
      portal.bidirectional,
      `portal(${portal.id}).bidirectional`,
      { defaultValue: true }
    ),
    transitionCost,
    enabled: normalizeBoolean(
      portal.enabled,
      `portal(${portal.id}).enabled`,
      { defaultValue: true }
    ),
    open: normalizeBoolean(
      portal.open,
      `portal(${portal.id}).open`,
      { defaultValue: true }
    ),
    locked: normalizeBoolean(
      portal.locked,
      `portal(${portal.id}).locked`,
      { defaultValue: false }
    ),
    blocked: normalizeBoolean(
      portal.blocked,
      `portal(${portal.id}).blocked`,
      { defaultValue: false }
    ),
    destroyed: normalizeBoolean(
      portal.destroyed,
      `portal(${portal.id}).destroyed`,
      { defaultValue: false }
    ),
    blocksWhenClosed: normalizeBoolean(
      portal.blocksWhenClosed,
      `portal(${portal.id}).blocksWhenClosed`,
      { defaultValue: false }
    ),
    roadBindings: Object.freeze(roadBindings),
    metadata: cloneJson(portal.metadata ?? null)
  });
}

function normalizeAnchor(anchor, layersById, spacesById) {
  assertStringId(anchor.id, "anchor.id");
  assertStringId(anchor.layerId, `anchor(${anchor.id}).layerId`);
  if (!layersById.has(anchor.layerId)) {
    throw new Error(
      `anchor ${anchor.id} references unknown layer ${anchor.layerId}`
    );
  }
  let space = null;
  if (anchor.spaceId != null) {
    space = spacesById.get(anchor.spaceId);
    if (!space) throw new Error(`anchor ${anchor.id} references unknown space ${anchor.spaceId}`);
    if (space.layerId !== anchor.layerId) {
      throw new Error(`anchor ${anchor.id} space ${anchor.spaceId} is on another layer`);
    }
  }
  const position = cloneVec2(anchor.position);
  const nodeId = normalizeNullableStringId(
    anchor.nodeId,
    `anchor(${anchor.id}).nodeId`
  );
  if (space && !pointInGeometry(position, space.geometry)) {
    throw new Error(`anchor ${anchor.id} is outside space ${anchor.spaceId}`);
  }
  return deepFreeze({
    id: anchor.id,
    layerId: anchor.layerId,
    spaceId: anchor.spaceId ?? null,
    position,
    nodeId,
    tags: normalizeStringList(anchor.tags, `anchor(${anchor.id}).tags`, { defaultValue: [] }),
    kind: normalizeKind(
      anchor.kind,
      `anchor(${anchor.id}).kind`,
      "anchor"
    ),
    metadata: cloneJson(anchor.metadata ?? null)
  });
}

function computeSpaceDepth(space, spacesById, memo, visiting) {
  if (memo.has(space.id)) return memo.get(space.id);
  if (visiting.has(space.id)) throw new Error(`space containment cycle involving ${space.id}`);
  visiting.add(space.id);
  let depth = 0;
  if (space.parentSpaceId != null) {
    const parent = spacesById.get(space.parentSpaceId);
    if (!parent) throw new Error(`space ${space.id} references unknown parent ${space.parentSpaceId}`);
    if (parent.layerId !== space.layerId) throw new Error(`space ${space.id} cannot have a parent in another layer`);
    if (!geometryContainsGeometry(parent.geometry, space.geometry)) {
      throw new Error(
        `space ${space.id} geometry is not fully contained by parent ${parent.id}`
      );
    }
    depth = computeSpaceDepth(parent, spacesById, memo, visiting) + 1;
  }
  visiting.delete(space.id);
  memo.set(space.id, depth);
  return depth;
}

export function definePlace(blueprint) {
  if (!blueprint || typeof blueprint !== "object") throw new TypeError("place blueprint is required");
  return deepFreeze(cloneJson(blueprint));
}

export class CompiledPlaceDefinition {
  #layersById;
  #spacesById;
  #boundariesById;
  #portalsById;
  #anchorsById;
  #spaceIndexes;
  #spaceDepth;
  #anchorsBySpace;
  #anchorsByTag;
  #portalsByLayer;
  #blueprint;

  constructor(data) {
    Object.assign(this, {
      id: data.id,
      kind: data.kind,
      tags: data.tags,
      revision: data.revision,
      contentHash: data.contentHash,
      defaultAnchorId: data.defaultAnchorId,
      layers: data.layers,
      spaces: data.spaces,
      boundaries: data.boundaries,
      portals: data.portals,
      anchors: data.anchors,
      footprint: data.footprint,
      metadata: data.metadata
    });
    this.#layersById = data.layersById;
    this.#spacesById = data.spacesById;
    this.#boundariesById = data.boundariesById;
    this.#portalsById = data.portalsById;
    this.#anchorsById = data.anchorsById;
    this.#spaceIndexes = data.spaceIndexes;
    this.#spaceDepth = data.spaceDepth;
    this.#anchorsBySpace = data.anchorsBySpace;
    this.#anchorsByTag = data.anchorsByTag;
    this.#portalsByLayer = data.portalsByLayer;
    this.#blueprint = data.blueprint;
    Object.freeze(this);
  }

  getLayer(id) { return this.#layersById.get(id) ?? null; }
  getSpace(id) { return this.#spacesById.get(id) ?? null; }
  getBoundary(id) { return this.#boundariesById.get(id) ?? null; }
  getPortal(id) { return this.#portalsById.get(id) ?? null; }
  getAnchor(id) { return this.#anchorsById.get(id) ?? null; }
  getSpaceDepth(id) { return this.#spaceDepth.get(id) ?? -1; }
  getAnchorsForSpace(spaceId) { return this.#anchorsBySpace.get(spaceId) ?? EMPTY; }
  getAnchorsByTag(tag) { return this.#anchorsByTag.get(tag) ?? EMPTY; }
  getPortalsForLayer(layerId) { return this.#portalsByLayer.get(layerId) ?? EMPTY; }
  getBlueprint() { return cloneJson(this.#blueprint); }

  locateSpaces(layerId, position) {
    const index = this.#spaceIndexes.get(layerId);
    if (!index) return [];

    // Ordered from least-specific to most-specific so consumers can use the
    // final entry as the primary/deepest semantic space.
    return index.queryPoint(position).sort((a, b) => {
      const depthDelta =
        this.getSpaceDepth(a.id) -
        this.getSpaceDepth(b.id);
      if (depthDelta !== 0) return depthDelta;

      const priorityDelta = a.priority - b.priority;
      if (priorityDelta !== 0) return priorityDelta;

      // The final entry wins. Reverse lexical order here so the smaller ID is
      // the deterministic winner when depth and priority are identical.
      return b.id.localeCompare(a.id);
    });
  }

  primarySpaceAt(layerId, position) {
    const spaces = this.locateSpaces(layerId, position);
    return spaces.length ? spaces[spaces.length - 1] : null;
  }

  getDiagnostics() {
    let spatialIndexCells = 0;
    for (const index of this.#spaceIndexes.values()) spatialIndexCells += index.cellCount;
    return {
      layerCount: this.layers.length,
      spaceCount: this.spaces.length,
      boundaryCount: this.boundaries.length,
      portalCount: this.portals.length,
      anchorCount: this.anchors.length,
      spatialIndexCells
    };
  }
}

const EMPTY = Object.freeze([]);

export function compilePlace(input, options = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("place blueprint is required");
  }
  const blueprint = input;
  assertStringId(blueprint.id, "place.id");
  const layersInput = requireArray(blueprint.layers, "place.layers");
  const spacesInput = requireArray(blueprint.spaces, "place.spaces");
  const boundariesInput = requireArray(
    blueprint.boundaries,
    "place.boundaries"
  );
  const portalsInput = requireArray(blueprint.portals, "place.portals");
  const anchorsInput = requireArray(blueprint.anchors, "place.anchors");
  uniqueById(layersInput, "layer");
  uniqueById(spacesInput, "space");
  uniqueById(boundariesInput, "boundary");
  uniqueById(portalsInput, "portal");
  uniqueById(anchorsInput, "anchor");

  const layers = Object.freeze(layersInput.map((layer) => normalizeLayer(layer, blueprint.id)));
  const layersById = new Map(layers.map((x) => [x.id, x]));
  const spaces = Object.freeze(spacesInput.map((x) => normalizeSpace(x, layersById)));
  const spacesById = new Map(spaces.map((x) => [x.id, x]));
  const boundaries = Object.freeze(boundariesInput.map((x) => normalizeBoundary(x, layersById)));
  const boundariesById = new Map(boundaries.map((x) => [x.id, x]));
  const anchors = Object.freeze(anchorsInput.map((x) => normalizeAnchor(x, layersById, spacesById)));
  const anchorsById = new Map(anchors.map((x) => [x.id, x]));

  for (const space of spaces) {
    if (space.defaultAnchorId != null) {
      const anchor = anchorsById.get(space.defaultAnchorId);
      if (!anchor) throw new Error(`space ${space.id} references unknown default anchor ${space.defaultAnchorId}`);
      if (anchor.layerId !== space.layerId) throw new Error(`space ${space.id} default anchor is on another layer`);
      if (!pointInGeometry(anchor.position, space.geometry)) {
        throw new Error(`space ${space.id} default anchor is outside the space geometry`);
      }
    }
  }

  const portals = Object.freeze(portalsInput.map((x) => normalizePortal(x, layersById, spacesById)));
  const portalsById = new Map(portals.map((x) => [x.id, x]));

  const navigationNodeMaps = new Map();
  const navigationRoadMaps = new Map();
  for (const layer of layers) {
    if (!layer.navigation) continue;
    navigationNodeMaps.set(
      layer.id,
      new Map(layer.navigation.nodes.map((node) => [node.id, node]))
    );
    navigationRoadMaps.set(
      layer.id,
      new Map(layer.navigation.roads.map((road) => [road.id, road]))
    );
  }

  const assertNodePosition = (kind, id, layerId, nodeId, position) => {
    if (nodeId == null) return;
    const nodes = navigationNodeMaps.get(layerId);
    if (!nodes) return;
    const node = nodes.get(nodeId);
    if (!node) {
      throw new Error(`${kind} ${id} references unknown navigation node ${nodeId}`);
    }
    const dx = Math.abs(node.x - position.x);
    const dy = Math.abs(node.y - position.y);
    if (dx > 1e-9 || dy > 1e-9) {
      throw new Error(
        `${kind} ${id} position does not match navigation node ${nodeId}`
      );
    }
  };

  for (const anchor of anchors) {
    assertNodePosition(
      "anchor",
      anchor.id,
      anchor.layerId,
      anchor.nodeId,
      anchor.position
    );
  }
  const sameDomainPortalRoadOwners = new Map();
  for (const portal of portals) {
    for (const endpoint of [portal.a, portal.b]) {
      if (endpoint.kind !== "local" || endpoint.nodeId == null) continue;
      assertNodePosition(
        "portal",
        portal.id,
        endpoint.layerId,
        endpoint.nodeId,
        endpoint.position
      );
    }
    for (const binding of portal.roadBindings) {
      const layer = layersById.get(binding.layerId);
      if (layer?.topologyId == null) {
        throw new Error(
          `portal ${portal.id} road binding requires navigation topology on layer ${binding.layerId}`
        );
      }

      const roads = navigationRoadMaps.get(binding.layerId);
      if (roads && !roads.has(binding.roadId)) {
        throw new Error(
          `portal ${portal.id} references unknown navigation road ${binding.roadId}`
        );
      }
    }

    const sameLayerLocal =
      portal.a.kind === "local" &&
      portal.b.kind === "local" &&
      portal.a.layerId === portal.b.layerId;

    if (sameLayerLocal) {
      const layerId = portal.a.layerId;
      const thresholdBindings = portal.roadBindings
        .filter((binding) => binding.layerId === layerId);
      const crossesSpaces =
        portal.a.spaceId != null &&
        portal.b.spaceId != null &&
        portal.a.spaceId !== portal.b.spaceId;
      const initiallyTraversable =
        portal.enabled &&
        !portal.locked &&
        !portal.blocked &&
        !portal.destroyed &&
        (!portal.blocksWhenClosed || portal.open);
      const needsPhysicalEnforcement =
        crossesSpaces ||
        portal.transitionCost > 0 ||
        !initiallyTraversable;

      if (needsPhysicalEnforcement && thresholdBindings.length === 0) {
        throw new Error(
          `same-domain portal ${portal.id} requires a threshold road binding for physical enforcement`
        );
      }

      if (
        thresholdBindings.length > 0 &&
        navigationRoadMaps.has(layerId) &&
        (portal.a.nodeId == null || portal.b.nodeId == null)
      ) {
        throw new Error(
          `same-domain portal ${portal.id} with a threshold road binding requires nodeId on both endpoints`
        );
      }

      let allowsForward = false;
      let allowsReverse = false;
      let verifiedThresholdRoad = false;

      for (const binding of thresholdBindings) {
        const road = navigationRoadMaps
          .get(binding.layerId)
          ?.get(binding.roadId);

        if (road) {
          verifiedThresholdRoad = true;
          const connectsForward =
            road.from === portal.a.nodeId &&
            road.to === portal.b.nodeId;
          const connectsReverse =
            road.from === portal.b.nodeId &&
            road.to === portal.a.nodeId;

          if (!connectsForward && !connectsReverse) {
            throw new Error(
              `portal ${portal.id} road binding ${binding.roadId} does not connect its endpoint nodes`
            );
          }

          allowsForward ||= connectsForward ||
            (connectsReverse && road.bidirectional);
          allowsReverse ||= connectsReverse ||
            (connectsForward && road.bidirectional);
        }

        const ownerKey = `${binding.layerId}\u0000${binding.roadId}`;
        const owner = sameDomainPortalRoadOwners.get(ownerKey);
        if (owner != null && owner !== portal.id) {
          throw new Error(
            `navigation road ${binding.roadId} is bound as a threshold by multiple portals: ${owner}, ${portal.id}`
          );
        }
        sameDomainPortalRoadOwners.set(ownerKey, portal.id);
      }

      if (verifiedThresholdRoad) {
        if (!allowsForward) {
          throw new Error(
            `portal ${portal.id} threshold roads do not allow traversal from endpoint a to b`
          );
        }
        if (portal.bidirectional) {
          if (!allowsReverse) {
            throw new Error(
              `portal ${portal.id} is bidirectional but its threshold roads do not allow traversal from endpoint b to a`
            );
          }
        } else if (allowsReverse) {
          throw new Error(
            `portal ${portal.id} is unidirectional but its threshold roads allow reverse traversal`
          );
        }
      }
    }
  }
  for (const boundary of boundaries) {
    const layer = layersById.get(boundary.layerId);
    const roads = navigationRoadMaps.get(boundary.layerId);
    for (const binding of boundary.roadBindings) {
      if (layer?.topologyId == null) {
        throw new Error(
          `boundary ${boundary.id} road binding requires navigation topology on layer ${boundary.layerId}`
        );
      }
      if (roads && !roads.has(binding.roadId)) {
        throw new Error(
          `boundary ${boundary.id} references unknown navigation road ${binding.roadId}`
        );
      }
    }
  }

  const spaceDepth = new Map();
  for (const space of spaces) computeSpaceDepth(space, spacesById, spaceDepth, new Set());

  const spaceIndexes = new Map();
  const cellSize = options.spaceIndexCellSize ?? DEFAULT_SPACE_INDEX_CELL_SIZE;
  for (const layer of layers) {
    const layerSpaces = spaces.filter((space) => space.layerId === layer.id);
    spaceIndexes.set(layer.id, new StaticGeometryIndex(layerSpaces, { cellSize }));
  }

  const anchorsBySpace = new Map();
  const anchorsByTag = new Map();
  for (const anchor of anchors) {
    if (anchor.spaceId != null) {
      let list = anchorsBySpace.get(anchor.spaceId);
      if (!list) anchorsBySpace.set(anchor.spaceId, list = []);
      list.push(anchor);
    }
    for (const tag of anchor.tags) {
      let list = anchorsByTag.get(tag);
      if (!list) anchorsByTag.set(tag, list = []);
      list.push(anchor);
    }
  }
  for (const [key, list] of anchorsBySpace) anchorsBySpace.set(key, Object.freeze(list));
  for (const [key, list] of anchorsByTag) anchorsByTag.set(key, Object.freeze(list));

  const portalsByLayer = new Map();
  for (const portal of portals) {
    for (const endpoint of [portal.a, portal.b]) {
      if (endpoint.kind !== "local") continue;
      let list = portalsByLayer.get(endpoint.layerId);
      if (!list) portalsByLayer.set(endpoint.layerId, list = []);
      if (!list.includes(portal)) list.push(portal);
    }
  }
  for (const [key, list] of portalsByLayer) portalsByLayer.set(key, Object.freeze(list));

  const kind = blueprint.kind ?? "place";
  assertStringId(kind, "place.kind");

  const tags = normalizeStringList(
    blueprint.tags,
    "place.tags",
    { defaultValue: [] }
  );
  const revision = normalizeDefinitionRevision(blueprint.revision);
  const defaultAnchorId = blueprint.defaultAnchorId ?? null;
  if (defaultAnchorId != null) {
    assertStringId(defaultAnchorId, "place.defaultAnchorId");
    if (!anchorsById.has(defaultAnchorId)) {
      throw new Error(
        `place ${blueprint.id} references unknown default anchor ${defaultAnchorId}`
      );
    }
  }

  const footprint = blueprint.footprint == null
    ? null
    : normalizeGeometry(blueprint.footprint);
  const metadata = deepFreeze(cloneJson(blueprint.metadata ?? null));

  const canonicalBlueprint = deepFreeze({
    id: blueprint.id,
    kind,
    tags,
    revision,
    defaultAnchorId,
    layers,
    spaces,
    boundaries,
    portals,
    anchors,
    footprint,
    metadata
  });
  const contentHash = sha256(canonicalStringify(canonicalBlueprint));

  return new CompiledPlaceDefinition({
    id: blueprint.id,
    kind,
    tags,
    revision,
    contentHash,
    defaultAnchorId,
    layers,
    spaces,
    boundaries,
    portals,
    anchors,
    footprint,
    metadata,
    layersById,
    spacesById,
    boundariesById,
    portalsById,
    anchorsById,
    spaceIndexes,
    spaceDepth,
    anchorsBySpace,
    anchorsByTag,
    portalsByLayer,
    blueprint: canonicalBlueprint
  });
}

export function definitionBounds(definition) {
  if (definition.footprint) return geometryBounds(definition.footprint);
  return null;
}
