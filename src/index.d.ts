export type PlaceId = string | number;
export type EntityId = string | number;

export interface Vec2 {
  x: number;
  y: number;
}

export interface Transform2D {
  x?: number;
  y?: number;
  position?: Vec2;
  rotation?: number;
  scale?: number;
}

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export type Geometry =
  | { type: "aabb"; minX: number; minY: number; maxX: number; maxY: number }
  | { type: "circle"; center: Vec2; radius: number }
  | { type: "polygon"; points: readonly Vec2[] };

export interface PlaceNavigationSpec {
  options?: Record<string, unknown>;
  regions?: readonly { id: string }[];
  nodes?: readonly {
    id: string;
    x: number;
    y: number;
    junctionRadius?: number;
    regionId?: string | null;
  }[];
  roads?: readonly {
    id: string;
    from: string;
    to: string;
    shape?: readonly Vec2[];
    width?: number;
    surface?: string;
    bidirectional?: boolean;
    enabled?: boolean;
    allowedProfiles?: readonly string[] | null;
    blockedProfiles?: readonly string[];
    tags?: readonly string[];
  }[];
}

export interface PlaceLayerInput {
  id: string;
  kind?: string;
  tags?: readonly string[];
  topologyId?: string | null;
  navigation?: PlaceNavigationSpec | null;
  metadata?: unknown;
}

export interface PlaceSpaceInput {
  id: string;
  layerId: string;
  kind?: string;
  tags?: readonly string[];
  geometry: Geometry;
  parentSpaceId?: string | null;
  defaultAnchorId?: string | null;
  priority?: number;
  metadata?: unknown;
}

export interface PlaceBoundaryInput {
  id: string;
  layerId: string;
  kind?: string;
  tags?: readonly string[];
  a: Vec2;
  b: Vec2;
  enabled?: boolean;
  roadBindings?: readonly { roadId: string }[];
  metadata?: unknown;
}

export interface LocalPortalEndpointInput {
  kind?: "local";
  layerId: string;
  spaceId?: string | null;
  position: Vec2;
  nodeId?: string | null;
  metadata?: unknown;
}

export interface ExternalPortalEndpointInput {
  kind: "external";
  slot: string;
  metadata?: unknown;
}

export interface ResolvedPortalEndpoint {
  domainId: string;
  position: Vec2;
  nodeId?: string | null;
  placeId?: PlaceId | null;
  layerId?: string | null;
  spaceId?: string | null;
}

export interface PlacePortalInput {
  id: string;
  kind?: string;
  tags?: readonly string[];
  a: LocalPortalEndpointInput | ExternalPortalEndpointInput;
  b: LocalPortalEndpointInput | ExternalPortalEndpointInput;
  bidirectional?: boolean;
  transitionCost?: number;
  enabled?: boolean;
  open?: boolean;
  locked?: boolean;
  blocked?: boolean;
  destroyed?: boolean;
  blocksWhenClosed?: boolean;
  roadBindings?: readonly { layerId: string; roadId: string }[];
  metadata?: unknown;
}

export interface DynamicPortalInput {
  id: string;
  kind?: string;
  tags?: readonly string[];
  a: ResolvedPortalEndpoint;
  b: ResolvedPortalEndpoint;
  bidirectional?: boolean;
  transitionCost?: number;
  enabled?: boolean;
  open?: boolean;
  locked?: boolean;
  blocked?: boolean;
  destroyed?: boolean;
  blocksWhenClosed?: boolean;
  roadBindings?: readonly { layerId: string; roadId: string }[];
  metadata?: unknown;
}

export interface PlaceAnchorInput {
  id: string;
  layerId: string;
  spaceId?: string | null;
  position: Vec2;
  nodeId?: string | null;
  tags?: readonly string[];
  kind?: string;
  metadata?: unknown;
}

export interface PlaceDefinitionInput {
  id: string;
  kind?: string;
  tags?: readonly string[];
  revision?: number | string;
  defaultAnchorId?: string | null;
  layers?: readonly PlaceLayerInput[];
  spaces?: readonly PlaceSpaceInput[];
  boundaries?: readonly PlaceBoundaryInput[];
  portals?: readonly PlacePortalInput[];
  anchors?: readonly PlaceAnchorInput[];
  footprint?: Geometry | null;
  metadata?: unknown;
}

export interface CompiledPlaceLayer extends PlaceLayerInput {
  readonly topologyId: string | null;
  readonly navigation: PlaceNavigationSpec | null;
}

export interface CompiledPlaceSpace extends PlaceSpaceInput {
  readonly kind: string;
  readonly tags: readonly string[];
  readonly parentSpaceId: string | null;
  readonly defaultAnchorId: string | null;
  readonly priority: number;
}

export interface CompiledPlaceAnchor extends PlaceAnchorInput {
  readonly kind: string;
  readonly tags: readonly string[];
  readonly spaceId: string | null;
  readonly nodeId: string | null;
}

export class CompiledPlaceDefinition {
  readonly id: string;
  readonly kind: string;
  readonly tags: readonly string[];
  readonly revision: number | string;
  readonly contentHash: string;
  readonly defaultAnchorId: string | null;
  readonly layers: readonly CompiledPlaceLayer[];
  readonly spaces: readonly CompiledPlaceSpace[];
  readonly boundaries: readonly PlaceBoundaryInput[];
  readonly portals: readonly PlacePortalInput[];
  readonly anchors: readonly CompiledPlaceAnchor[];
  readonly footprint: Geometry | null;
  readonly metadata: unknown;

  getLayer(id: string): CompiledPlaceLayer | null;
  getSpace(id: string): CompiledPlaceSpace | null;
  getBoundary(id: string): PlaceBoundaryInput | null;
  getPortal(id: string): PlacePortalInput | null;
  getAnchor(id: string): CompiledPlaceAnchor | null;
  getSpaceDepth(id: string): number;
  getAnchorsForSpace(id: string): readonly CompiledPlaceAnchor[];
  getAnchorsByTag(tag: string): readonly CompiledPlaceAnchor[];
  getPortalsForLayer(id: string): readonly PlacePortalInput[];
  getBlueprint(): PlaceDefinitionInput;
  locateSpaces(layerId: string, position: Vec2): CompiledPlaceSpace[];
  getDiagnostics(): {
    layerCount: number;
    spaceCount: number;
    boundaryCount: number;
    portalCount: number;
    anchorCount: number;
    spatialIndexCells: number;
  };
}

export function definePlace(input: PlaceDefinitionInput): Readonly<PlaceDefinitionInput>;
export function compilePlace(
  input: PlaceDefinitionInput,
  options?: { spaceIndexCellSize?: number }
): CompiledPlaceDefinition;
export function definitionBounds(definition: CompiledPlaceDefinition): Bounds | null;

export interface PlaceAttachment extends ResolvedPortalEndpoint {
  metadata?: unknown;
}

export type PlacePlacement =
  | {
      domainId: string;
      parentPlaceId?: null;
      transform?: Transform2D;
      containment?: "none" | "footprint";
    }
  | {
      domainId?: null;
      parentPlaceId: PlaceId;
      transform?: Transform2D;
      containment?: "none" | "footprint";
    };

export interface ResolvedPlacePlacement {
  domainId: string;
  transform: Required<Pick<Transform2D, "x" | "y" | "rotation" | "scale">>;
  containment: "none" | "footprint";
}

export interface ResolvedPortal {
  key?: string;
  id: string;
  instanceId: PlaceId;
  definitionId: string;
  kind: string;
  tags: readonly string[];
  a: ResolvedPortalEndpoint | null;
  b: ResolvedPortalEndpoint | null;
  connected: boolean;
  bidirectional: boolean;
  transitionCost: number;
  enabled: boolean;
  open: boolean;
  locked: boolean;
  blocked: boolean;
  destroyed: boolean;
  blocksWhenClosed: boolean;
  traversable: boolean;
  source: "definition" | "dynamic";
  metadata?: unknown;
}

export class PlaceInstance {
  readonly id: PlaceId;
  readonly definitionId: string;
  parentId: PlaceId | null;
  readonly layerDomains: Map<string, string>;
  readonly attachments: Map<string, PlaceAttachment>;
  placement: PlacePlacement | null;
  metadata: unknown;
  readonly portalOverrides: Map<string, Record<string, boolean>>;
  readonly boundaryOverrides: Map<string, { enabled?: boolean }>;
  readonly spaceOverrides: Map<string, { enabled?: boolean }>;
  readonly dynamicPortals: Map<string, DynamicPortalInput>;
}

export interface SpaceLocation {
  id: string;
  spaceId: string;
  placeId: PlaceId;
  layerId: string;
  kind: string;
}

export interface LocationContext {
  domainId: string;
  position: Vec2;
  places: readonly PlaceId[];
  spaces: readonly SpaceLocation[];
  placeId: PlaceId | null;
  layerId: string | null;
  deepestSpace: SpaceLocation | null;
}

export interface PlaceRegistryOptions {
  bridge?: WorldCoreBridge | null;
  worldCoreBridge?: WorldCoreBridge | null;
  captureEvents?: boolean;
  eventQueueLimit?: number;
  eventOverflowPolicy?: "drop-newest" | "drop-oldest" | "throw";
}

export interface CreatePlaceInput {
  id: PlaceId;
  definitionId: string;
  parentId?: PlaceId | null;
  parentPlaceId?: PlaceId | null;
  layerDomains?: Record<string, string> | Map<string, string>;
  attachments?: Record<string, PlaceAttachment>;
  externalBindings?: Record<string, PlaceAttachment>;
  placement?: PlacePlacement | Transform2D | null;
  placementDomainId?: string | null;
  containment?: "none" | "footprint";
  metadata?: unknown;
}

export interface PlaceEvent {
  sequence: number;
  type: string;
  [key: string]: unknown;
}

export class PlaceRegistry {
  constructor(options?: PlaceRegistryOptions);

  readonly definitions: Map<string, CompiledPlaceDefinition>;
  readonly instances: Map<PlaceId, PlaceInstance>;
  readonly domainBindings: Map<string, { instanceId: PlaceId; layerId: string }>;
  readonly activeTravels: Map<EntityId, TravelState>;
  readonly pendingTravels: Array<Record<string, unknown>>;
  readonly stateRevision: number;
  readonly travelRevision: number;
  /** @deprecated Alias for travelRevision. */
  readonly graphRevision: number;
  readonly bridge: WorldCoreBridge | null;

  attachBridge(bridge: WorldCoreBridge): this;
  attachWorldCoreBridge(bridge: WorldCoreBridge): this;

  registerDefinition(
    definition: CompiledPlaceDefinition | PlaceDefinitionInput,
    options?: { spaceIndexCellSize?: number }
  ): CompiledPlaceDefinition;
  removeDefinition(definitionId: string): boolean;
  getDefinition(id: string): CompiledPlaceDefinition | null;
  getPlace(id: PlaceId): PlaceInstance | null;

  createPlace(input: CreatePlaceInput): PlaceInstance;
  removePlace(id: PlaceId): boolean;
  setParent(instanceId: PlaceId, parentId: PlaceId | null): PlaceInstance;
  setPlacement(instanceId: PlaceId, placement: PlacePlacement | null): PlacePlacement | null;
  getResolvedPlacement(instanceId: PlaceId): ResolvedPlacePlacement | null;

  getDomainBinding(domainId: string): { instanceId: PlaceId; layerId: string } | null;
  domainForLayer(instanceId: PlaceId, layerId: string): string | null;
  getLayerDomain(instanceId: PlaceId, layerId: string): string | null;

  getSpace(instanceId: PlaceId, spaceId: string): (CompiledPlaceSpace & { enabled: boolean }) | null;
  getBoundary(instanceId: PlaceId, boundaryId: string): (PlaceBoundaryInput & { enabled: boolean }) | null;
  resolveBoundary(instanceId: PlaceId, boundaryId: string): (PlaceBoundaryInput & { enabled: boolean }) | null;

  getPortal(instanceId: PlaceId, portalId: string): ResolvedPortal | null;
  resolvePortal(instanceId: PlaceId, portalId: string): ResolvedPortal | null;
  getPortalRecord(key: string): ResolvedPortal | null;
  getPortalsForDomain(domainId: string): ResolvedPortal[];
  resolvedPortals(placeId?: PlaceId | null): IterableIterator<ResolvedPortal>;

  setPortalState(
    instanceId: PlaceId,
    portalId: string,
    patch: Partial<Pick<ResolvedPortal, "enabled" | "open" | "locked" | "blocked" | "destroyed">>
  ): ResolvedPortal;
  setBoundaryState(instanceId: PlaceId, boundaryId: string, patch: { enabled?: boolean }): PlaceBoundaryInput & { enabled: boolean };
  setSpaceState(instanceId: PlaceId, spaceId: string, patch: { enabled?: boolean }): CompiledPlaceSpace & { enabled: boolean };
  setAttachment(instanceId: PlaceId, slot: string, value: PlaceAttachment): PlaceAttachment;
  clearAttachment(instanceId: PlaceId, slot: string): boolean;
  setExternalBinding(instanceId: PlaceId, slot: string, value: PlaceAttachment): PlaceAttachment;
  clearExternalBinding(instanceId: PlaceId, slot: string): boolean;
  addInstancePortal(instanceId: PlaceId, spec: DynamicPortalInput): ResolvedPortal;
  addPortal(instanceId: PlaceId, spec: DynamicPortalInput): ResolvedPortal;
  removeInstancePortal(instanceId: PlaceId, portalId: string): boolean;
  removePortal(instanceId: PlaceId, portalId: string): boolean;

  findAnchor(instanceId: PlaceId, anchorId: string): (CompiledPlaceAnchor & { placeId: PlaceId; domainId: string }) | null;
  resolveAnchor(instanceId: PlaceId, anchorId: string): (CompiledPlaceAnchor & { placeId: PlaceId; domainId: string }) | null;
  findAnchorsByTag(instanceId: PlaceId, tag: string): Array<CompiledPlaceAnchor & { placeId: PlaceId; domainId: string }>;
  findAnchors(options?: {
    placeId?: PlaceId | null;
    tag?: string | null;
    kind?: string | null;
    spaceId?: string | null;
  }): Array<CompiledPlaceAnchor & { placeId: PlaceId; domainId: string }>;
  findNearestAnchor(
    instanceId: PlaceId,
    position: Vec2,
    options?: { tag?: string; layerId?: string }
  ): (CompiledPlaceAnchor & { placeId: PlaceId; domainId: string; distance: number }) | null;
  getAnchorsForDomain(
    domainId: string,
    options?: { tag?: string; kind?: string; spaceId?: string }
  ): Array<CompiledPlaceAnchor & { placeId: PlaceId; domainId: string }>;
  findNearestAnchorInDomain(
    domainId: string,
    position: Vec2,
    options?: { tag?: string; kind?: string; spaceId?: string }
  ): (CompiledPlaceAnchor & { placeId: PlaceId; domainId: string; distance: number }) | null;
  findPortalEndpointsNear(
    domainId: string,
    position: Vec2,
    radius: number,
    options?: { traversableOnly?: boolean; kind?: string; tag?: string }
  ): Array<{
    portal: ResolvedPortal;
    endpoint: ResolvedPortalEndpoint;
    side: "a" | "b";
    distance: number;
  }>;
  findNearestPortal(
    domainId: string,
    position: Vec2,
    options?: {
      traversableOnly?: boolean;
      kind?: string;
      tag?: string;
      maxDistance?: number;
    }
  ): {
    portal: ResolvedPortal;
    endpoint: ResolvedPortalEndpoint;
    side: "a" | "b";
    distance: number;
  } | null;
  getBoundariesForDomain(
    domainId: string,
    options?: { enabledOnly?: boolean; kind?: string; tag?: string }
  ): Array<PlaceBoundaryInput & { enabled: boolean; placeId: PlaceId; domainId: string }>;
  boundariesIntersectingBounds(
    domainId: string,
    bounds: Bounds,
    options?: { enabledOnly?: boolean; kind?: string; tag?: string }
  ): Array<PlaceBoundaryInput & { enabled: boolean; placeId: PlaceId; domainId: string }>;
  findNearestBoundary(
    domainId: string,
    position: Vec2,
    options?: { enabledOnly?: boolean; kind?: string; tag?: string }
  ): {
    boundary: PlaceBoundaryInput & { enabled: boolean; placeId: PlaceId; domainId: string };
    distance: number;
  } | null;
  placesInBounds(domainId: string, bounds: Bounds): PlaceInstance[];

  locate(domainId: string, position: Vec2): LocationContext;
  locateEntity(entity: { domainId?: string; position: Vec2 }): LocationContext;
  placesAt(domainId: string, position: Vec2): PlaceInstance[];

  syncEntityOccupancy(entity: { id: EntityId; domainId?: string; position: Vec2 }): LocationContext;
  updateEntityOccupancy(entity: { id: EntityId; domainId?: string; position: Vec2 }): LocationContext;
  removeEntityOccupancy(entityId: EntityId): boolean;
  getEntityLocation(entityId: EntityId): LocationContext | null;
  entitiesInPlace(instanceId: PlaceId): Set<EntityId>;
  entitiesInSpace(instanceId: PlaceId, spaceId: string): Set<EntityId>;

  setEventCapture(enabled: boolean): void;
  emit(type: string, data?: Record<string, unknown>): PlaceEvent | null;
  drainEvents(target?: PlaceEvent[]): PlaceEvent[];
  peekEvents(): PlaceEvent[];
  getEventQueueStats(): {
    size: number;
    limit: number;
    overflowPolicy: string;
    dropped: number;
  };

  getDiagnostics(): {
    definitionCount: number;
    instanceCount: number;
    domainBindingCount: number;
    portalRecordCount: number;
    portalEndpointCount: number;
    portalEndpointDomainCount: number;
    portalOverrideCount: number;
    boundaryOverrideCount: number;
    spaceOverrideCount: number;
    dynamicPortalCount: number;
    occupiedEntityCount: number;
    occupancySpatialDomainCount: number;
    stateRevision: number;
    travelRevision: number;
    graphRevision: number;
    footprintIndexCells: number;
    eventQueueSize: number;
    droppedEventCount: number;
  };
  assertInternalConsistency(): ReturnType<PlaceRegistry["getDiagnostics"]>;
}

export function isPortalTraversable(portal: ResolvedPortal | PlacePortalInput): boolean;

export class WorldCoreBridge {
  constructor(input: {
    world: any;
    navigation: any;
    startJourney: Function;
    stopJourney: Function;
    Navigation?: new (options?: any) => any;
  });

  readonly world: any;
  readonly navigation: any;

  attachRegistry(registry: PlaceRegistry): void;
  materializePlace(instance: PlaceInstance, definition: CompiledPlaceDefinition): void;
  unmaterializePlace(instance: PlaceInstance, definition: CompiledPlaceDefinition): void;
  ensureLayerTopology(definition: CompiledPlaceDefinition, layer: CompiledPlaceLayer): any;
  syncBoundaryState(instance: PlaceInstance, boundary: PlaceBoundaryInput & { enabled?: boolean }): void;
  syncPortalState(instance: PlaceInstance, portalDefinition: PlacePortalInput, resolvedPortal: ResolvedPortal): void;
  getEntity(entityId: EntityId): any;
  navigationForDomain(domainId: string): any;
  planLocalRoute(input: {
    domainId: string;
    position: Vec2;
    destinationNodeId: string;
    mobility: any;
    options?: any;
  }): any;
  planLocalRouteCostsToMany(input: {
    domainId: string;
    position: Vec2;
    destinationNodeIds: Iterable<string>;
    mobility: any;
    options?: any;
  }): Map<string, number>;
  startLocalJourney(entityId: EntityId, destinationNodeId: string, options?: any): boolean;
  stopLocalJourney(entityId: EntityId): void;
  transferEntity(entityId: EntityId, endpoint: ResolvedPortalEndpoint): any;
}

export type TravelTarget =
  | { placeId: PlaceId; anchorId?: string; spaceId?: string }
  | {
      domainId: string;
      position: Vec2;
      nodeId?: string | null;
      placeId?: PlaceId | null;
      anchorId?: string | null;
      spaceId?: string | null;
      layerId?: string | null;
    }
  | {
      kind: "nearest";
      tag: string;
      anchorKind?: string;
      placeId?: PlaceId;
      spaceId?: string;
    };

export type TravelStep =
  | {
      type: "local-journey";
      domainId: string;
      destinationNodeId: string;
      destinationPosition: Vec2;
      estimatedSeconds: number;
    }
  | {
      type: "traverse-portal";
      portalKey: string;
      placeId: PlaceId;
      portalId: string;
      fromDomainId: string;
      toDomainId: string;
      destinationPosition: Vec2;
      transitionCost: number;
    };

export interface TravelPlan {
  entityId: EntityId;
  target: TravelTarget;
  resolvedTarget: ResolvedPortalEndpoint & {
    placeId?: PlaceId | null;
    anchorId?: string | null;
    spaceId?: string | null;
    layerId?: string | null;
  };
  /** Revision of the travel-relevant place graph used by this plan. */
  travelRevision: number;
  /** @deprecated Alias for travelRevision. */
  graphRevision: number;
  startDomainId: string;
  domainPath: readonly string[];
  steps: readonly TravelStep[];
  legs: readonly TravelStep[];
  estimatedSeconds: number;
  rejectedDomainPairs: readonly string[];
}

export interface RetainedTravelOptions {
  journeyOptions?: any;
  excludedPortalKeys?: readonly string[];
  excludedDomainPairs?: readonly string[];
  maxDomainPathAttempts?: number;
  maxShortestDomainPaths?: number;
  allowPartialShortestPathSearch?: boolean;
  maxConcreteStatesPerLayer?: number;
  maxNearestTargetExpansions?: number;
  maxCost?: number;
  anchorPredicate?: (
    anchor: CompiledPlaceAnchor & { placeId: PlaceId; domainId: string }
  ) => boolean;
  worldChangePolicy: "encounter" | "eager";
  portalEntryTolerance: number;
}

export interface TravelState {
  entityId: EntityId;
  target: TravelTarget;
  plan: TravelPlan;
  options: Readonly<RetainedTravelOptions>;
  stepIndex: number;
  localStarted: boolean;
  portalEntered: boolean;
  portalTransitionRemaining: number;
  travelRevision: number;
  /** @deprecated Alias for travelRevision. */
  graphRevision: number;
  worldChangePolicy: "encounter" | "eager";
  status: "active" | "complete" | "failed" | "cancelled";
  failureReason: string | null;
  replans: number;
}

export interface TravelOptions {
  bridge?: WorldCoreBridge;
  journeyOptions?: any;
  excludedPortalKeys?: Iterable<string>;
  excludedDomainPairs?: Iterable<string>;
  maxDomainPathAttempts?: number;
  maxShortestDomainPaths?: number;
  allowPartialShortestPathSearch?: boolean;
  maxConcreteStatesPerLayer?: number;
  maxNearestTargetExpansions?: number;
  maxCost?: number;
  anchorPredicate?: (anchor: CompiledPlaceAnchor & { placeId: PlaceId; domainId: string }) => boolean;
  worldChangePolicy?: "encounter" | "eager";
  portalEntryTolerance?: number;
  deltaSeconds?: number;
}

export function findDomainPortalPath(
  registry: PlaceRegistry,
  startDomainId: string,
  targetDomainId: string,
  options?: TravelOptions
): any[] | null;

export function resolveTravelTarget(
  registry: PlaceRegistry,
  target: TravelTarget
): TravelPlan["resolvedTarget"];

export function planTravel(
  registry: PlaceRegistry,
  entityOrId: EntityId | any,
  target: TravelTarget,
  options?: TravelOptions
): TravelPlan | null;
export function planTravel(
  registry: PlaceRegistry,
  bridge: WorldCoreBridge,
  entityOrId: EntityId | any,
  target: TravelTarget,
  options?: TravelOptions
): TravelPlan | null;

export function startTravel(
  registry: PlaceRegistry,
  entityId: EntityId,
  target: TravelTarget,
  options?: TravelOptions
): TravelState | null;
export function startTravel(
  registry: PlaceRegistry,
  bridge: WorldCoreBridge,
  entityId: EntityId,
  target: TravelTarget,
  options?: TravelOptions
): TravelState | null;

export function stepTravel(
  registry: PlaceRegistry,
  entityId: EntityId,
  options?: TravelOptions
): TravelState | null;
export function stepTravel(
  registry: PlaceRegistry,
  bridge: WorldCoreBridge,
  entityId: EntityId,
  options?: TravelOptions
): TravelState | null;

export function stepPlaceSimulation(
  registry: PlaceRegistry,
  options?: TravelOptions
): number;
export function stepPlaceSimulation(
  registry: PlaceRegistry,
  bridge: WorldCoreBridge,
  deltaSeconds?: number,
  options?: TravelOptions
): number;

export function stopTravel(
  registry: PlaceRegistry,
  entityId: EntityId,
  options?: TravelOptions & { reason?: string }
): boolean;
export function stopTravel(
  registry: PlaceRegistry,
  bridge: WorldCoreBridge,
  entityId: EntityId,
  options?: TravelOptions & { reason?: string }
): boolean;

export interface PlaceCoreSnapshot {
  format: "place-core";
  version: number;
  definitions: Array<{
    id: string;
    revision: number | string;
    contentHash: string;
    blueprint: PlaceDefinitionInput;
  }>;
  instances: Array<{
    id: PlaceId;
    definitionId: string;
    parentId: PlaceId | null;
    layerDomains: Record<string, string>;
    attachments: Record<string, PlaceAttachment>;
    placement: PlacePlacement | null;
    metadata: unknown;
    portalOverrides: Record<string, Record<string, boolean>>;
    boundaryOverrides: Record<string, { enabled?: boolean }>;
    spaceOverrides: Record<string, { enabled?: boolean }>;
    dynamicPortals: DynamicPortalInput[];
  }>;
  activeTravels: any[];
  pendingTravels: any[];
}

export const PLACE_CORE_SNAPSHOT_VERSION: number;
export function serializePlaceCore(registry: PlaceRegistry): PlaceCoreSnapshot;
export function validatePlaceCoreSnapshot(
  snapshot: unknown,
  options?: { expectedVersion?: number }
): true;
export function deserializePlaceCore(
  snapshot: unknown,
  options?: PlaceRegistryOptions & {
    resumeWorldCoreState?: boolean;
    restartTravels?: boolean;
  }
): PlaceRegistry;
export function computePlaceCoreStateHash(registry: PlaceRegistry): string;

export function geometryBounds(geometry: Geometry): Bounds;
export function pointInGeometry(point: Vec2, geometry: Geometry): boolean;
export function transformPoint(point: Vec2, transform?: Transform2D): Vec2;
export function inverseTransformPoint(point: Vec2, transform?: Transform2D): Vec2;
export function composeTransforms(parent?: Transform2D, child?: Transform2D): Required<Pick<Transform2D, "x" | "y" | "rotation" | "scale">>;
export function boundsIntersect(a: Bounds, b: Bounds): boolean;
export function segmentBounds(a: Vec2, b: Vec2): Bounds;
export function segmentIntersectsBounds(a: Vec2, b: Vec2, bounds: Bounds): boolean;
export function squaredDistancePointToSegment(point: Vec2, a: Vec2, b: Vec2): number;
export function transformBounds(bounds: Bounds, transform?: Transform2D): Bounds;

export class StaticGeometryIndex<T = any> {
  constructor(
    items: readonly T[],
    options?: { cellSize?: number; geometryOf?: (item: T) => Geometry }
  );
  queryPoint(
    point: Vec2,
    predicate?: ((item: T) => boolean) | null,
    geometryOf?: (item: T) => Geometry
  ): T[];
  readonly cellCount: number;
}

export class DynamicAabbIndex {
  constructor(cellSize?: number);
  set(id: PlaceId | string, bounds: Bounds): void;
  delete(id: PlaceId | string): boolean;
  queryPoint(point: Vec2): Array<PlaceId | string>;
  queryBounds(bounds: Bounds): Array<PlaceId | string>;
  getBounds(id: PlaceId | string): Bounds | null;
  readonly size: number;
  readonly cellSize: number;
  readonly cellCount: number;
}
