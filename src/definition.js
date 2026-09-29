import {
  StaticGeometryIndex,
  cloneVec2,
  geometryBounds,
  normalizeGeometry,
  pointInGeometry
} from "./geometry.js";
import {
  assertStringId,
  canonicalStringify,
  cloneJson,
  deepFreeze,
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

function normalizeNavigationSpec(spec, label) {
  if (spec == null) return null;
  if (typeof spec !== "object") throw new TypeError(`${label} must be an object`);
  const regions = (spec.regions ?? []).map((region, index) => {
    assertStringId(region.id, `${label}.regions[${index}].id`);
    return deepFreeze({ id: region.id });
  });
  uniqueById(regions, `${label}.region`);
  const regionIds = new Set(regions.map((x) => x.id));
  const nodes = (spec.nodes ?? []).map((node, index) => {
    assertStringId(node.id, `${label}.nodes[${index}].id`);
    if (!Number.isFinite(node.x) || !Number.isFinite(node.y)) throw new TypeError(`${label}.node ${node.id} requires finite x/y`);
    if (node.regionId != null && !regionIds.has(node.regionId)) throw new Error(`${label}.node ${node.id} references unknown region ${node.regionId}`);
    return deepFreeze({
      id: node.id, x: node.x, y: node.y,
      junctionRadius: node.junctionRadius ?? 0,
      regionId: node.regionId ?? null
    });
  });
  uniqueById(nodes, `${label}.node`);
  const nodeIds = new Set(nodes.map((x) => x.id));
  const roads = (spec.roads ?? []).map((road, index) => {
    assertStringId(road.id, `${label}.roads[${index}].id`);
    assertStringId(road.from, `${label}.road(${road.id}).from`);
    assertStringId(road.to, `${label}.road(${road.id}).to`);
    if (!nodeIds.has(road.from) || !nodeIds.has(road.to)) throw new Error(`${label}.road ${road.id} references unknown node`);
    return deepFreeze({
      id: road.id, from: road.from, to: road.to,
      shape: road.shape ? Object.freeze(road.shape.map(cloneVec2)) : undefined,
      width: road.width, surface: road.surface, bidirectional: road.bidirectional,
      enabled: road.enabled, allowedProfiles: road.allowedProfiles ? Object.freeze([...road.allowedProfiles]) : road.allowedProfiles,
      blockedProfiles: road.blockedProfiles ? Object.freeze([...road.blockedProfiles]) : undefined,
      tags: road.tags ? Object.freeze([...road.tags]) : undefined
    });
  });
  uniqueById(roads, `${label}.road`);
  return deepFreeze({
    options: cloneJson(spec.options ?? {}),
    regions: Object.freeze(regions),
    nodes: Object.freeze(nodes),
    roads: Object.freeze(roads)
  });
}

function normalizeLayer(layer, definitionId) {
  assertStringId(layer.id, "layer.id");
  const navigation = normalizeNavigationSpec(layer.navigation, `layer(${layer.id}).navigation`);
  return deepFreeze({
    id: layer.id,
    kind: layer.kind ?? "spatial-layer",
    tags: [...new Set(layer.tags ?? [])],
    topologyId: layer.topologyId ?? (navigation ? `${definitionId}:${layer.id}` : null),
    navigation,
    metadata: cloneJson(layer.metadata ?? null)
  });
}

function normalizeSpace(space, layersById) {
  assertStringId(space.id, "space.id");
  assertStringId(space.layerId, `space(${space.id}).layerId`);
  if (!layersById.has(space.layerId)) throw new Error(`space ${space.id} references unknown layer ${space.layerId}`);
  const geometry = normalizeGeometry(space.geometry);
  return deepFreeze({
    id: space.id,
    layerId: space.layerId,
    kind: space.kind ?? "space",
    tags: [...new Set(space.tags ?? [])],
    geometry,
    parentSpaceId: space.parentSpaceId ?? null,
    defaultAnchorId: space.defaultAnchorId ?? null,
    priority: Number.isFinite(space.priority) ? space.priority : 0,
    metadata: cloneJson(space.metadata ?? null)
  });
}

function normalizeBoundary(boundary, layersById) {
  assertStringId(boundary.id, "boundary.id");
  assertStringId(boundary.layerId, `boundary(${boundary.id}).layerId`);
  if (!layersById.has(boundary.layerId)) throw new Error(`boundary ${boundary.id} references unknown layer ${boundary.layerId}`);
  if (!boundary.a || !boundary.b) throw new TypeError(`boundary ${boundary.id} requires endpoints a and b`);
  const roadBindings = (boundary.roadBindings ?? []).map((binding, index) => {
    assertStringId(binding.roadId, `boundary(${boundary.id}).roadBindings[${index}].roadId`);
    return deepFreeze({ roadId: binding.roadId });
  });
  return deepFreeze({
    id: boundary.id,
    layerId: boundary.layerId,
    kind: boundary.kind ?? "wall",
    tags: [...new Set(boundary.tags ?? [])],
    a: cloneVec2(boundary.a),
    b: cloneVec2(boundary.b),
    enabled: boundary.enabled !== false,
    roadBindings: Object.freeze(roadBindings),
    metadata: cloneJson(boundary.metadata ?? null)
  });
}

function normalizeEndpoint(endpoint, portalId, layersById, spacesById) {
  if (!endpoint || typeof endpoint !== "object") throw new TypeError(`portal ${portalId} endpoint is required`);
  const kind = endpoint.kind ?? "local";
  if (kind === "local") {
    assertStringId(endpoint.layerId, `portal(${portalId}).endpoint.layerId`);
    if (!layersById.has(endpoint.layerId)) throw new Error(`portal ${portalId} references unknown layer ${endpoint.layerId}`);
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
      nodeId: endpoint.nodeId ?? null,
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
  const a = normalizeEndpoint(portal.a, portal.id, layersById, spacesById);
  const b = normalizeEndpoint(portal.b, portal.id, layersById, spacesById);
  const roadBindings = (portal.roadBindings ?? []).map((binding, index) => {
    assertStringId(binding.layerId, `portal(${portal.id}).roadBindings[${index}].layerId`);
    assertStringId(binding.roadId, `portal(${portal.id}).roadBindings[${index}].roadId`);
    if (!layersById.has(binding.layerId)) throw new Error(`portal ${portal.id} road binding references unknown layer ${binding.layerId}`);
    return deepFreeze({ layerId: binding.layerId, roadId: binding.roadId });
  });
  return deepFreeze({
    id: portal.id,
    kind: portal.kind ?? "portal",
    tags: [...new Set(portal.tags ?? [])],
    a,
    b,
    bidirectional: portal.bidirectional !== false,
    transitionCost: Number.isFinite(portal.transitionCost) ? Math.max(0, portal.transitionCost) : 0,
    enabled: portal.enabled !== false,
    open: portal.open !== false,
    locked: portal.locked === true,
    blocked: portal.blocked === true,
    destroyed: portal.destroyed === true,
    blocksWhenClosed: portal.blocksWhenClosed === true,
    roadBindings: Object.freeze(roadBindings),
    metadata: cloneJson(portal.metadata ?? null)
  });
}

function normalizeAnchor(anchor, layersById, spacesById) {
  assertStringId(anchor.id, "anchor.id");
  assertStringId(anchor.layerId, `anchor(${anchor.id}).layerId`);
  if (!layersById.has(anchor.layerId)) throw new Error(`anchor ${anchor.id} references unknown layer ${anchor.layerId}`);
  let space = null;
  if (anchor.spaceId != null) {
    space = spacesById.get(anchor.spaceId);
    if (!space) throw new Error(`anchor ${anchor.id} references unknown space ${anchor.spaceId}`);
    if (space.layerId !== anchor.layerId) {
      throw new Error(`anchor ${anchor.id} space ${anchor.spaceId} is on another layer`);
    }
  }
  const position = cloneVec2(anchor.position);
  if (space && !pointInGeometry(position, space.geometry)) {
    throw new Error(`anchor ${anchor.id} is outside space ${anchor.spaceId}`);
  }
  return deepFreeze({
    id: anchor.id,
    layerId: anchor.layerId,
    spaceId: anchor.spaceId ?? null,
    position,
    nodeId: anchor.nodeId ?? null,
    tags: [...new Set(anchor.tags ?? [])],
    kind: anchor.kind ?? "anchor",
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
    return index.queryPoint(position).sort((a, b) => {
      const depthDelta = this.getSpaceDepth(a.id) - this.getSpaceDepth(b.id);
      if (depthDelta !== 0) return depthDelta;
      const priorityDelta = a.priority - b.priority;
      if (priorityDelta !== 0) return priorityDelta;
      return a.id.localeCompare(b.id);
    });
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
  const blueprint = definePlace(input);
  assertStringId(blueprint.id, "place.id");
  const layersInput = blueprint.layers ?? [];
  const spacesInput = blueprint.spaces ?? [];
  const boundariesInput = blueprint.boundaries ?? [];
  const portalsInput = blueprint.portals ?? [];
  const anchorsInput = blueprint.anchors ?? [];
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
      const roads = navigationRoadMaps.get(binding.layerId);
      if (roads && !roads.has(binding.roadId)) {
        throw new Error(
          `portal ${portal.id} references unknown navigation road ${binding.roadId}`
        );
      }
    }

    if (
      portal.a.kind === "local" &&
      portal.b.kind === "local" &&
      portal.a.layerId === portal.b.layerId &&
      portal.a.nodeId != null &&
      portal.b.nodeId != null
    ) {
      for (const binding of portal.roadBindings) {
        if (binding.layerId !== portal.a.layerId) continue;
        const road = navigationRoadMaps
          .get(binding.layerId)
          ?.get(binding.roadId);
        if (!road) continue;
        const connectsEndpoints =
          (road.from === portal.a.nodeId && road.to === portal.b.nodeId) ||
          (road.from === portal.b.nodeId && road.to === portal.a.nodeId);
        if (!connectsEndpoints) {
          throw new Error(
            `portal ${portal.id} road binding ${binding.roadId} does not connect its endpoint nodes`
          );
        }
      }
    }
  }
  for (const boundary of boundaries) {
    const roads = navigationRoadMaps.get(boundary.layerId);
    for (const binding of boundary.roadBindings) {
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

  if (blueprint.defaultAnchorId != null && !anchorsById.has(blueprint.defaultAnchorId)) {
    throw new Error(`place ${blueprint.id} references unknown default anchor ${blueprint.defaultAnchorId}`);
  }

  const footprint = blueprint.footprint ? normalizeGeometry(blueprint.footprint) : null;
  const canonicalBlueprint = {
    ...blueprint,
    layers,
    spaces,
    boundaries,
    portals,
    anchors,
    footprint
  };
  const contentHash = sha256(canonicalStringify(canonicalBlueprint));

  return new CompiledPlaceDefinition({
    id: blueprint.id,
    kind: blueprint.kind ?? "place",
    tags: Object.freeze([...new Set(blueprint.tags ?? [])]),
    revision: blueprint.revision ?? 1,
    contentHash,
    defaultAnchorId: blueprint.defaultAnchorId ?? null,
    layers,
    spaces,
    boundaries,
    portals,
    anchors,
    footprint,
    metadata: deepFreeze(cloneJson(blueprint.metadata ?? null)),
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
    blueprint
  });
}

export function definitionBounds(definition) {
  if (definition.footprint) return geometryBounds(definition.footprint);
  return null;
}
