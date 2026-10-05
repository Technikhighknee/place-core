export type PlaceId = string | number;
export type EntityId = string | number;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export interface JsonObject {
  [key: string]: JsonValue;
}

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
  options?: {
    spatialCellSize?: number;
    routeCacheSize?: number;
    routeCacheMaxLegs?: number;
    routeCacheMaxTotalLegs?: number;
    hierarchicalRouteCacheSize?: number;
    regionalRouteCacheSize?: number;
  };
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
  spatialMode: "owned" | "embedded";
  tags?: readonly string[];
  topologyId?: string | null;
  navigation?: PlaceNavigationSpec | null;
  metadata?: JsonValue;
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
  enabled?: boolean;
  metadata?: JsonValue;
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
  metadata?: JsonValue;
}

export interface LocalPortalEndpointInput {
  kind?: "local";
  layerId: string;
  spaceId?: string | null;
  position: Vec2;
  nodeId?: string | null;
  metadata?: JsonValue;
}

export interface ExternalPortalEndpointInput {
  kind: "external";
  slot: string;
  metadata?: JsonValue;
}

export interface ResolvedPortalEndpointInput {
  domainId: string;
  position: Vec2;
  nodeId?: string | null;
  placeId?: PlaceId | null;
  layerId?: string | null;
  spaceId?: string | null;
  metadata?: JsonValue;
}

export interface ResolvedPortalEndpoint {
  kind?: "resolved";
  domainId: string;
  position: Vec2;
  nodeId: string | null;
  placeId: PlaceId | null;
  layerId: string | null;
  spaceId: string | null;
  metadata: JsonValue;
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
  metadata?: JsonValue;
}

export interface DynamicPortalInput {
  id: string;
  kind?: string;
  tags?: readonly string[];
  a: ResolvedPortalEndpointInput;
  b: ResolvedPortalEndpointInput;
  bidirectional?: boolean;
  transitionCost?: number;
  enabled?: boolean;
  open?: boolean;
  locked?: boolean;
  blocked?: boolean;
  destroyed?: boolean;
  blocksWhenClosed?: boolean;
  roadBindings?: readonly { layerId: string; roadId: string }[];
  metadata?: JsonValue;
}

export interface PersistedResolvedPortalEndpoint
  extends ResolvedPortalEndpoint {
  kind: "resolved";
}

export interface PersistedDynamicPortal {
  id: string;
  kind: string;
  tags: readonly string[];
  a: PersistedResolvedPortalEndpoint;
  b: PersistedResolvedPortalEndpoint;
  bidirectional: boolean;
  transitionCost: number;
  enabled: boolean;
  open: boolean;
  locked: boolean;
  blocked: boolean;
  destroyed: boolean;
  blocksWhenClosed: boolean;
  roadBindings: readonly {
    layerId: string;
    roadId: string;
  }[];
  metadata: JsonValue;
}

export interface PlaceAnchorInput {
  id: string;
  layerId: string;
  spaceId?: string | null;
  position: Vec2;
  nodeId?: string | null;
  tags?: readonly string[];
  kind?: string;
  metadata?: JsonValue;
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
  metadata?: JsonValue;
}

export interface CanonicalPlaceNavigationSpec {
  options: {
    spatialCellSize: number;
    routeCacheSize: number;
    routeCacheMaxLegs: number;
    routeCacheMaxTotalLegs: number;
    hierarchicalRouteCacheSize: number;
    regionalRouteCacheSize: number;
  };
  regions: readonly { id: string }[];
  nodes: readonly {
    id: string;
    x: number;
    y: number;
    junctionRadius: number;
    regionId: string | null;
  }[];
  roads: readonly {
    id: string;
    from: string;
    to: string;
    shape: readonly Vec2[];
    width: number;
    surface: string;
    bidirectional: boolean;
    enabled: boolean;
    allowedProfiles: readonly string[] | null;
    blockedProfiles: readonly string[];
    tags: readonly string[];
  }[];
}

export interface CompiledPlaceLayer {
  readonly id: string;
  readonly kind: string;
  readonly spatialMode: "owned" | "embedded";
  readonly tags: readonly string[];
  readonly topologyId: string | null;
  readonly navigation: CanonicalPlaceNavigationSpec | null;
  readonly metadata: JsonValue;
}

export interface CompiledPlaceSpace {
  readonly id: string;
  readonly layerId: string;
  readonly kind: string;
  readonly tags: readonly string[];
  readonly geometry: Geometry;
  readonly parentSpaceId: string | null;
  readonly defaultAnchorId: string | null;
  readonly priority: number;
  readonly enabled: boolean;
  readonly metadata: JsonValue;
}

export interface CompiledPlaceBoundary {
  readonly id: string;
  readonly layerId: string;
  readonly kind: string;
  readonly tags: readonly string[];
  readonly a: Vec2;
  readonly b: Vec2;
  readonly enabled: boolean;
  readonly roadBindings: readonly { roadId: string }[];
  readonly metadata: JsonValue;
}

export interface CompiledLocalPortalEndpoint {
  readonly kind: "local";
  readonly layerId: string;
  readonly spaceId: string | null;
  readonly position: Vec2;
  readonly nodeId: string | null;
  readonly metadata: JsonValue;
}

export interface CompiledExternalPortalEndpoint {
  readonly kind: "external";
  readonly slot: string;
  readonly metadata: JsonValue;
}

export type CompiledPortalEndpoint =
  | CompiledLocalPortalEndpoint
  | CompiledExternalPortalEndpoint;

export interface CompiledPlacePortal {
  readonly id: string;
  readonly kind: string;
  readonly tags: readonly string[];
  readonly a: CompiledPortalEndpoint;
  readonly b: CompiledPortalEndpoint;
  readonly bidirectional: boolean;
  readonly transitionCost: number;
  readonly enabled: boolean;
  readonly open: boolean;
  readonly locked: boolean;
  readonly blocked: boolean;
  readonly destroyed: boolean;
  readonly blocksWhenClosed: boolean;
  readonly roadBindings: readonly {
    layerId: string;
    roadId: string;
  }[];
  readonly metadata: JsonValue;
}

export interface CompiledPlaceAnchor {
  readonly id: string;
  readonly layerId: string;
  readonly spaceId: string | null;
  readonly position: Vec2;
  readonly nodeId: string | null;
  readonly tags: readonly string[];
  readonly kind: string;
  readonly metadata: JsonValue;
}

export interface CanonicalPlaceDefinition {
  id: string;
  kind: string;
  tags: readonly string[];
  revision: number | string;
  defaultAnchorId: string | null;
  layers: readonly CompiledPlaceLayer[];
  spaces: readonly CompiledPlaceSpace[];
  boundaries: readonly CompiledPlaceBoundary[];
  portals: readonly CompiledPlacePortal[];
  anchors: readonly CompiledPlaceAnchor[];
  footprint: Geometry | null;
  metadata: JsonValue;
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
  readonly boundaries: readonly CompiledPlaceBoundary[];
  readonly portals: readonly CompiledPlacePortal[];
  readonly anchors: readonly CompiledPlaceAnchor[];
  readonly footprint: Geometry | null;
  readonly metadata: JsonValue;

  getLayer(id: string): CompiledPlaceLayer | null;
  getSpace(id: string): CompiledPlaceSpace | null;
  getBoundary(id: string): CompiledPlaceBoundary | null;
  getPortal(id: string): CompiledPlacePortal | null;
  getAnchor(id: string): CompiledPlaceAnchor | null;
  getSpaceDepth(id: string): number;
  getAnchorsForSpace(id: string): readonly CompiledPlaceAnchor[];
  getAnchorsByTag(tag: string): readonly CompiledPlaceAnchor[];
  getPortalsForLayer(id: string): readonly CompiledPlacePortal[];
  getBlueprint(): CanonicalPlaceDefinition;
  locateSpaces(layerId: string, position: Vec2): CompiledPlaceSpace[];
  primarySpaceAt(layerId: string, position: Vec2): CompiledPlaceSpace | null;
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

export interface PlaceAttachment {
  domainId: string;
  position: Vec2;
  nodeId?: string | null;
  placeId?: PlaceId | null;
  spaceId?: string | null;
  metadata?: JsonValue;
}

export interface ResolvedPlaceAttachment {
  domainId: string;
  position: Vec2;
  nodeId: string | null;
  placeId: PlaceId | null;
  spaceId: string | null;
  metadata: JsonValue;
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

export type NormalizedPlacePlacement =
  | {
      domainId: string;
      parentPlaceId: null;
      transform: Required<
        Pick<
          Transform2D,
          "x" | "y" | "rotation" | "scale"
        >
      >;
      containment: "none" | "footprint";
    }
  | {
      domainId: null;
      parentPlaceId: PlaceId;
      transform: Required<
        Pick<
          Transform2D,
          "x" | "y" | "rotation" | "scale"
        >
      >;
      containment: "none" | "footprint";
    };

export interface ResolvedPlacePlacement {
  domainId: string;
  transform: Required<
    Pick<
      Transform2D,
      "x" | "y" | "rotation" | "scale"
    >
  >;
  containment: "none" | "footprint";
}

export interface PlaceMembershipInput {
  parentPlaceId: PlaceId;
  kind?: string;
  metadata?: JsonValue;
}

export interface PlaceMembership {
  parentPlaceId: PlaceId;
  kind: string;
  metadata: JsonValue;
}

export interface PortalStateOverride {
  enabled?: boolean;
  open?: boolean;
  locked?: boolean;
  blocked?: boolean;
  destroyed?: boolean;
}

export interface EnabledStateOverride {
  enabled: boolean;
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
  metadata: JsonValue;
}

export interface IndexedResolvedPortal
  extends ResolvedPortal {
  key: string;
  a: ResolvedPortalEndpoint;
  b: ResolvedPortalEndpoint;
  connected: true;
}

export class PlaceInstance {
  readonly id: PlaceId;
  readonly definitionId: string;
  readonly parentId: PlaceId | null;
  readonly layerDomains: ReadonlyMap<string, string>;
  readonly attachments: ReadonlyMap<string, ResolvedPlaceAttachment>;
  readonly placement: NormalizedPlacePlacement | null;
  readonly metadata: JsonValue;
  readonly portalOverrides: ReadonlyMap<
    string,
    Readonly<PortalStateOverride>
  >;
  readonly boundaryOverrides: ReadonlyMap<
    string,
    Readonly<EnabledStateOverride>
  >;
  readonly spaceOverrides: ReadonlyMap<
    string,
    Readonly<EnabledStateOverride>
  >;
  readonly dynamicPortals: ReadonlyMap<
    string,
    Readonly<PersistedDynamicPortal>
  >;
  getMembership(
    parentPlaceId: PlaceId,
    kind?: string
  ): PlaceMembership | null;
  getMemberships(): PlaceMembership[];
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
  semanticPlaces: readonly PlaceId[];
  spaces: readonly SpaceLocation[];
  placeId: PlaceId | null;
  layerId: string | null;
  deepestSpace: SpaceLocation | null;
}

export interface PlaceRegistryOptions {
  bridge?: WorldCoreBridge | null;
  captureEvents?: boolean;
  eventQueueLimit?: number;
  eventOverflowPolicy?: "drop-newest" | "drop-oldest";
}

export interface CreatePlaceInput {
  id: PlaceId;
  definitionId: string;
  parentId?: PlaceId | null;
  layerDomains?: Record<string, string>;
  attachments?: Record<string, PlaceAttachment>;
  placement?: PlacePlacement | null;
  memberships?: readonly PlaceMembershipInput[];
  metadata?: JsonValue;
}

export interface PlaceEvent {
  sequence: number;
  type: string;
  [key: string]: unknown;
}

export class PlaceRegistry {
  constructor(options?: PlaceRegistryOptions);

  readonly definitions: ReadonlyMap<string, CompiledPlaceDefinition>;
  readonly instances: ReadonlyMap<PlaceId, PlaceInstance>;
  readonly domainBindings: ReadonlyMap<
    string,
    Readonly<{
      instanceId: PlaceId;
      layerId: string;
    }>
  >;
  readonly activeTravels: ReadonlyMap<
    EntityId,
    Readonly<TravelState>
  >;
  readonly pendingTravels:
    readonly Readonly<PersistedPendingTravel>[];
  readonly stateRevision: number;
  readonly travelRevision: number;
  readonly bridge: WorldCoreBridge | null;

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
  getMemberships(instanceId: PlaceId): PlaceMembership[];
  addMembership(
    instanceId: PlaceId,
    membership: PlaceMembershipInput
  ): PlaceMembership;
  removeMembership(
    instanceId: PlaceId,
    parentPlaceId: PlaceId,
    kind?: string
  ): boolean;
  getSemanticAncestors(
    instanceId: PlaceId,
    options?: { includeSelf?: boolean }
  ): PlaceId[];
  setPlacement(
    instanceId: PlaceId,
    placement: PlacePlacement | null
  ): NormalizedPlacePlacement | null;
  getResolvedPlacement(instanceId: PlaceId): ResolvedPlacePlacement | null;

  getDomainBinding(
    domainId: string
  ): Readonly<{
    instanceId: PlaceId;
    layerId: string;
  }> | null;
  getLayerDomain(instanceId: PlaceId, layerId: string): string | null;

  getSpace(instanceId: PlaceId, spaceId: string): (CompiledPlaceSpace & { enabled: boolean }) | null;
  resolveBoundary(instanceId: PlaceId, boundaryId: string): CompiledPlaceBoundary | null;

  resolvePortal(instanceId: PlaceId, portalId: string): ResolvedPortal | null;
  getPortalRecord(key: string): IndexedResolvedPortal | null;
  getPortalsForDomain(domainId: string): IndexedResolvedPortal[];
  getPortalsForRoad(domainId: string, roadId: string): IndexedResolvedPortal[];
  resolvedPortals(placeId?: PlaceId | null): IterableIterator<ResolvedPortal>;

  setPortalState(
    instanceId: PlaceId,
    portalId: string,
    patch: Partial<Pick<ResolvedPortal, "enabled" | "open" | "locked" | "blocked" | "destroyed">>
  ): ResolvedPortal;
  setBoundaryState(instanceId: PlaceId, boundaryId: string, patch: { enabled?: boolean }): CompiledPlaceBoundary;
  setSpaceState(instanceId: PlaceId, spaceId: string, patch: { enabled?: boolean }): CompiledPlaceSpace & { enabled: boolean };
  setAttachment(
    instanceId: PlaceId,
    slot: string,
    value: PlaceAttachment
  ): ResolvedPlaceAttachment;
  clearAttachment(instanceId: PlaceId, slot: string): boolean;
  addPortal(instanceId: PlaceId, spec: DynamicPortalInput): ResolvedPortal;
  removePortal(instanceId: PlaceId, portalId: string): boolean;

  resolveAnchor(instanceId: PlaceId, anchorId: string): (CompiledPlaceAnchor & { placeId: PlaceId; domainId: string }) | null;
  findAnchorsByTag(instanceId: PlaceId, tag: string): Array<CompiledPlaceAnchor & { placeId: PlaceId; domainId: string }>;
  findAnchors(options?: {
    placeId?: PlaceId | null;
    tag?: string | null;
    kind?: string | null;
    spaceId?: string | null;
    enabledOnly?: boolean;
  }): Array<CompiledPlaceAnchor & { placeId: PlaceId; domainId: string }>;
  findNearestAnchor(
    instanceId: PlaceId,
    position: Vec2,
    options?: {
      tag?: string;
      layerId?: string;
      kind?: string;
      spaceId?: string;
    }
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
    portal: IndexedResolvedPortal;
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
    portal: IndexedResolvedPortal;
    endpoint: ResolvedPortalEndpoint;
    side: "a" | "b";
    distance: number;
  } | null;
  getBoundariesForDomain(
    domainId: string,
    options?: { enabledOnly?: boolean; kind?: string; tag?: string }
  ): Array<CompiledPlaceBoundary & { placeId: PlaceId; domainId: string }>;
  boundariesIntersectingBounds(
    domainId: string,
    bounds: Bounds,
    options?: { enabledOnly?: boolean; kind?: string; tag?: string }
  ): Array<CompiledPlaceBoundary & { placeId: PlaceId; domainId: string }>;
  findNearestBoundary(
    domainId: string,
    position: Vec2,
    options?: { enabledOnly?: boolean; kind?: string; tag?: string }
  ): {
    boundary: CompiledPlaceBoundary & { placeId: PlaceId; domainId: string };
    distance: number;
  } | null;
  placesInBounds(domainId: string, bounds: Bounds): PlaceInstance[];

  locate(domainId: string, position: Vec2): LocationContext;
  locateEntity(entity: { domainId?: string; position: Vec2 }): LocationContext;
  placesAt(domainId: string, position: Vec2): PlaceInstance[];

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
    overflowPolicy: "drop-newest" | "drop-oldest";
    dropped: number;
  };

  getDiagnostics(): {
    definitionCount: number;
    instanceCount: number;
    domainBindingCount: number;
    semanticMembershipCount: number;
    semanticMembershipParentCount: number;
    semanticClosureCacheSize: number;
    portalRecordCount: number;
    portalEndpointCount: number;
    portalEndpointDomainCount: number;
    traversablePortalEndpointCount: number;
    traversablePortalEndpointDomainCount: number;
    portalRoadBindingCount: number;
    portalRoadDomainCount: number;
    portalOverrideCount: number;
    boundaryOverrideCount: number;
    spaceOverrideCount: number;
    dynamicPortalCount: number;
    occupiedEntityCount: number;
    occupancySpatialDomainCount: number;
    stateRevision: number;
    travelRevision: number;
    footprintIndexCells: number;
    eventQueueSize: number;
    droppedEventCount: number;
  };
  assertInternalConsistency(): ReturnType<PlaceRegistry["getDiagnostics"]>;
}

export function isPortalTraversable(portal: {
  enabled?: boolean;
  open?: boolean;
  locked?: boolean;
  blocked?: boolean;
  destroyed?: boolean;
  blocksWhenClosed?: boolean;
}): boolean;

export class WorldCoreBridge {
  constructor(input: {
    world: any;
    navigation: any;
    startJourney: Function;
    stopJourney: Function;
    Navigation?: new (options?: any) => any;
    existingDomainPolicy?: "reject" | "adopt";
  });

  readonly world: any;
  readonly navigation: any;
  readonly existingDomainPolicy: "reject" | "adopt";

  dispose(): boolean;
  validateHostNavigationPoint(
    domainId: string,
    nodeId: NavigationId,
    position: Vec2,
    label?: string
  ): true;
  validateEmbeddedHostNavigation(
    instance: PlaceInstance,
    definition: CompiledPlaceDefinition
  ): true;
  materializePlace(
    instance: PlaceInstance,
    definition: CompiledPlaceDefinition
  ): unknown;
  rollbackMaterializePlace(
    instance: PlaceInstance,
    definition: CompiledPlaceDefinition,
    receipt: unknown
  ): boolean;
  unmaterializePlace(instance: PlaceInstance, definition: CompiledPlaceDefinition): void;
  ensureLayerTopology(definition: CompiledPlaceDefinition, layer: CompiledPlaceLayer): any;
  syncBoundaryState(instance: PlaceInstance, boundary: CompiledPlaceBoundary): void;
  syncPortalState(
    instance: PlaceInstance,
    portalDefinition: CompiledPlacePortal | PersistedDynamicPortal,
    resolvedPortal: ResolvedPortal
  ): void;
  getEntity(entityId: EntityId): any;
  navigationForDomain(domainId: string): any;
  planLocalRoute(input: {
    domainId: string;
    position: Vec2;
    destinationNodeId: string;
    mobility: any;
    options?: any;
  }):
    | ({ estimatedSeconds: number } & Record<string, unknown>)
    | ({ route: { estimatedSeconds: number } } & Record<string, unknown>)
    | null;
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

export interface ResolvedTravelTarget {
  placeId: PlaceId | null;
  anchorId: string | null;
  spaceId: string | null;
  layerId: string | null;
  domainId: string;
  position: Vec2;
  nodeId: string | null;
}

export interface TravelPlan {
  entityId: EntityId;
  target: TravelTarget;
  resolvedTarget: ResolvedTravelTarget;
  /** Revision of the travel-relevant place graph used by this plan. */
  travelRevision: number;
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
  readonly entityId: EntityId;
  readonly target: TravelTarget;
  readonly plan: TravelPlan;
  readonly options: Readonly<RetainedTravelOptions>;
  readonly stepIndex: number;
  readonly localStarted: boolean;
  readonly portalEntered: boolean;
  readonly portalTransitionRemaining: number;
  readonly travelRevision: number;
  readonly worldChangePolicy: "encounter" | "eager";
  readonly status: "active" | "complete" | "failed" | "cancelled";
  readonly failureReason: string | null;
  readonly replans: number;
}

export type PersistedTravelOptions =
  Omit<RetainedTravelOptions, "anchorPredicate">;

export type PersistedTravelPlan =
  Omit<TravelPlan, "travelRevision">;

export interface PersistedActiveTravelState {
  entityId: EntityId;
  target: TravelTarget;
  plan: PersistedTravelPlan;
  options: PersistedTravelOptions;
  stepIndex: number;
  localStarted: boolean;
  portalEntered: boolean;
  portalTransitionRemaining: number;
  worldChangePolicy: "encounter" | "eager";
  status: "active";
  failureReason: null;
  replans: number;
  planStale: boolean;
}

export interface PersistedPendingTravel {
  entityId: EntityId;
  target: TravelTarget;
  savedState: PersistedActiveTravelState & {
    planStale: true;
  };
  restartError?: {
    name: string;
    message: string;
  };
}

export interface DomainPathOptions {
  excludedPortalKeys?: Iterable<string>;
  excludedDomainPairs?: Iterable<string>;
}

export interface TravelEntityInput {
  id: EntityId;
  domainId?: string;
  position: Vec2;
  mobility: unknown;
}

export interface TravelPlanningOptions extends DomainPathOptions {
  bridge?: WorldCoreBridge;
  journeyOptions?: any;
  maxDomainPathAttempts?: number;
  maxShortestDomainPaths?: number;
  allowPartialShortestPathSearch?: boolean;
  maxConcreteStatesPerLayer?: number;
  maxNearestTargetExpansions?: number;
  maxCost?: number;
  anchorPredicate?: (
    anchor: CompiledPlaceAnchor & {
      placeId: PlaceId;
      domainId: string;
    }
  ) => boolean;
  worldChangePolicy?: "encounter" | "eager";
  portalEntryTolerance?: number;
}

export interface TravelStepOptions extends TravelPlanningOptions {
  deltaSeconds?: number;
}

export interface StopTravelOptions {
  bridge?: WorldCoreBridge;
  reason?: string;
}

export function domainPairKey(
  fromDomainId: string,
  toDomainId: string
): string;

export interface DomainPortalTransition {
  portal: IndexedResolvedPortal;
  portalKey: string;
  side: "a" | "b";
  from: ResolvedPortalEndpoint;
  to: ResolvedPortalEndpoint;
}

export type DomainPortalPath =
  DomainPortalTransition[] & {
    readonly domains: readonly string[];
  };

export function findDomainPortalPath(
  registry: PlaceRegistry,
  startDomainId: string,
  targetDomainId: string,
  options?: DomainPathOptions
): DomainPortalPath | null;

export function resolveTravelTarget(
  registry: PlaceRegistry,
  target: TravelTarget
): ResolvedTravelTarget;

export function planTravel(
  registry: PlaceRegistry,
  entityOrId: EntityId | TravelEntityInput,
  target: TravelTarget,
  options?: TravelPlanningOptions
): TravelPlan | null;
export function planTravel(
  registry: PlaceRegistry,
  bridge: WorldCoreBridge,
  entityOrId: EntityId | TravelEntityInput,
  target: TravelTarget,
  options?: TravelPlanningOptions
): TravelPlan | null;

export function startTravel(
  registry: PlaceRegistry,
  entityId: EntityId,
  target: TravelTarget,
  options?: TravelPlanningOptions
): TravelState | null;
export function startTravel(
  registry: PlaceRegistry,
  bridge: WorldCoreBridge,
  entityId: EntityId,
  target: TravelTarget,
  options?: TravelPlanningOptions
): TravelState | null;

export function stepTravel(
  registry: PlaceRegistry,
  entityId: EntityId,
  options?: TravelStepOptions
): TravelState | null;
export function stepTravel(
  registry: PlaceRegistry,
  bridge: WorldCoreBridge,
  entityId: EntityId,
  options?: TravelStepOptions
): TravelState | null;

export function stepPlaceSimulation(
  registry: PlaceRegistry,
  options?: TravelStepOptions
): number;
export function stepPlaceSimulation(
  registry: PlaceRegistry,
  bridge: WorldCoreBridge,
  deltaSeconds?: number,
  options?: TravelStepOptions
): number;

export function stopTravel(
  registry: PlaceRegistry,
  entityId: EntityId,
  options?: StopTravelOptions
): boolean;
export function stopTravel(
  registry: PlaceRegistry,
  bridge: WorldCoreBridge,
  entityId: EntityId,
  options?: StopTravelOptions
): boolean;

export interface PlaceCoreSnapshot {
  format: "place-core";
  version: number;
  definitions: Array<{
    id: string;
    revision: number | string;
    contentHash: string;
    blueprint: CanonicalPlaceDefinition;
  }>;
  instances: Array<{
    id: PlaceId;
    definitionId: string;
    parentId: PlaceId | null;
    memberships: PlaceMembership[];
    layerDomains: Record<string, string>;
    attachments: Record<string, ResolvedPlaceAttachment>;
    placement: NormalizedPlacePlacement | null;
    metadata: JsonValue;
    portalOverrides: Record<string, PortalStateOverride>;
    boundaryOverrides: Record<string, EnabledStateOverride>;
    spaceOverrides: Record<string, EnabledStateOverride>;
    dynamicPortals: PersistedDynamicPortal[];
  }>;
  occupancy: Array<{
    entityId: EntityId;
    domainId: string;
    position: Vec2;
  }>;
  activeTravels: PersistedActiveTravelState[];
  pendingTravels: PersistedPendingTravel[];
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
export function geometryContainsGeometry(parent: Geometry, child: Geometry): boolean;
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
    predicate?: ((item: T) => boolean) | null
  ): T[];
  readonly cellCount: number;
  readonly largeItemCount: number;
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
  readonly largeItemCount: number;
}
