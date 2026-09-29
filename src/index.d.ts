export type PlaceId = string | number;
export type EntityId = string | number;
export interface Vec2 { x: number; y: number }
export type Geometry =
  | { type: "aabb"; minX: number; minY: number; maxX: number; maxY: number }
  | { type: "circle"; center: Vec2; radius: number }
  | { type: "polygon"; points: readonly Vec2[] };

export interface PlaceNavigationSpec {
  options?: Record<string, unknown>;
  regions?: readonly { id: string }[];
  nodes?: readonly { id: string; x: number; y: number; junctionRadius?: number; regionId?: string | null }[];
  roads?: readonly {
    id: string; from: string; to: string; shape?: readonly Vec2[]; width?: number; surface?: string;
    bidirectional?: boolean; enabled?: boolean; allowedProfiles?: readonly string[] | null;
    blockedProfiles?: readonly string[]; tags?: readonly string[];
  }[];
}
export interface PlaceLayerInput { id: string; kind?: string; tags?: readonly string[]; topologyId?: string | null; navigation?: PlaceNavigationSpec | null; metadata?: unknown }
export interface PlaceSpaceInput { id: string; layerId: string; kind?: string; tags?: readonly string[]; geometry: Geometry; parentSpaceId?: string | null; defaultAnchorId?: string | null; priority?: number; metadata?: unknown }
export interface PlaceBoundaryInput { id: string; layerId: string; kind?: string; tags?: readonly string[]; a: Vec2; b: Vec2; enabled?: boolean; roadBindings?: readonly { roadId: string }[]; metadata?: unknown }
export interface LocalPortalEndpointInput { kind?: "local"; layerId: string; spaceId?: string | null; position: Vec2; nodeId?: string | null; metadata?: unknown }
export interface ExternalPortalEndpointInput { kind: "external"; slot: string; metadata?: unknown }
export interface PlacePortalInput {
  id: string; kind?: string; tags?: readonly string[];
  a: LocalPortalEndpointInput | ExternalPortalEndpointInput;
  b: LocalPortalEndpointInput | ExternalPortalEndpointInput;
  bidirectional?: boolean; transitionCost?: number; enabled?: boolean; open?: boolean;
  locked?: boolean; blocked?: boolean; destroyed?: boolean; blocksWhenClosed?: boolean;
  roadBindings?: readonly { layerId: string; roadId: string }[]; metadata?: unknown;
}
export interface PlaceAnchorInput { id: string; layerId: string; spaceId?: string | null; position: Vec2; nodeId?: string | null; tags?: readonly string[]; kind?: string; metadata?: unknown }
export interface PlaceDefinitionInput {
  id: string; kind?: string; tags?: readonly string[]; revision?: number | string; defaultAnchorId?: string | null;
  layers?: readonly PlaceLayerInput[]; spaces?: readonly PlaceSpaceInput[]; boundaries?: readonly PlaceBoundaryInput[];
  portals?: readonly PlacePortalInput[]; anchors?: readonly PlaceAnchorInput[]; footprint?: Geometry | null; metadata?: unknown;
}

export class CompiledPlaceDefinition {
  readonly id: string; readonly kind: string; readonly tags: readonly string[]; readonly revision: number | string;
  readonly contentHash: string; readonly defaultAnchorId: string | null; readonly layers: readonly any[];
  readonly spaces: readonly any[]; readonly boundaries: readonly any[]; readonly portals: readonly any[];
  readonly anchors: readonly any[]; readonly footprint: Geometry | null;
  getLayer(id: string): any | null; getSpace(id: string): any | null; getBoundary(id: string): any | null;
  getPortal(id: string): any | null; getAnchor(id: string): any | null; getSpaceDepth(id: string): number;
  getAnchorsForSpace(id: string): readonly any[]; getAnchorsByTag(tag: string): readonly any[];
  getPortalsForLayer(id: string): readonly any[]; getBlueprint(): PlaceDefinitionInput;
  locateSpaces(layerId: string, position: Vec2): any[]; getDiagnostics(): Record<string, number>;
}
export function definePlace(input: PlaceDefinitionInput): Readonly<PlaceDefinitionInput>;
export function compilePlace(input: PlaceDefinitionInput, options?: { spaceIndexCellSize?: number }): CompiledPlaceDefinition;
export function definitionBounds(definition: CompiledPlaceDefinition): { minX: number; minY: number; maxX: number; maxY: number } | null;

export interface PlaceAttachment { domainId: string; position: Vec2; nodeId?: string | null; placeId?: PlaceId | null; spaceId?: string | null; metadata?: unknown }
export interface PlacePlacement { domainId: string; transform?: { x?: number; y?: number; position?: Vec2; rotation?: number; scale?: number }; containment?: "none" | "footprint" }
export class PlaceInstance {
  readonly id: PlaceId; readonly definitionId: string; parentId: PlaceId | null;
  readonly layerDomains: Map<string, string>; readonly attachments: Map<string, PlaceAttachment>;
  placement: PlacePlacement | null; metadata: unknown;
  readonly portalOverrides: Map<string, Record<string, boolean>>;
  readonly boundaryOverrides: Map<string, Record<string, boolean>>;
  readonly spaceOverrides: Map<string, Record<string, boolean>>;
  readonly dynamicPortals: Map<string, any>;
}
export interface LocationContext {
  domainId: string; position: Vec2; places: readonly PlaceId[];
  spaces: readonly { placeId: PlaceId; spaceId: string; layerId: string; kind: string }[];
}
export class PlaceRegistry {
  constructor(options?: { bridge?: WorldCoreBridge; captureEvents?: boolean; eventQueueLimit?: number; eventOverflowPolicy?: "drop-newest" | "drop-oldest" | "throw" });
  readonly definitions: Map<string, CompiledPlaceDefinition>; readonly instances: Map<PlaceId, PlaceInstance>;
  readonly activeTravels: Map<EntityId, TravelState>; readonly pendingTravels: Array<{ entityId: EntityId; target: TravelTarget }>;
  readonly graphRevision: number; readonly bridge: WorldCoreBridge | null;
  attachBridge(bridge: WorldCoreBridge): this; registerDefinition(definition: CompiledPlaceDefinition): CompiledPlaceDefinition;
  getDefinition(id: string): CompiledPlaceDefinition | null; getPlace(id: PlaceId): PlaceInstance | null;
  createPlace(input: { id: PlaceId; definitionId: string; parentId?: PlaceId | null; layerDomains?: Record<string, string>; attachments?: Record<string, PlaceAttachment>; placement?: PlacePlacement | null; metadata?: unknown }): PlaceInstance;
  removePlace(id: PlaceId): boolean; getDomainBinding(domainId: string): { instanceId: PlaceId; layerId: string } | null;
  domainForLayer(instanceId: PlaceId, layerId: string): string | null;
  getSpace(instanceId: PlaceId, spaceId: string): any | null; getBoundary(instanceId: PlaceId, boundaryId: string): any | null;
  getPortal(instanceId: PlaceId, portalId: string): any | null; findAnchor(instanceId: PlaceId, anchorId: string): any | null;
  findAnchorsByTag(instanceId: PlaceId, tag: string): any[]; findNearestAnchor(instanceId: PlaceId, position: Vec2, options?: { tag?: string; layerId?: string }): any | null;
  setPortalState(instanceId: PlaceId, portalId: string, patch: Record<string, boolean>): any;
  setBoundaryState(instanceId: PlaceId, boundaryId: string, patch: { enabled?: boolean }): any;
  setSpaceState(instanceId: PlaceId, spaceId: string, patch: { enabled?: boolean }): any;
  setAttachment(instanceId: PlaceId, slot: string, value: PlaceAttachment): PlaceAttachment;
  setPlacement(instanceId: PlaceId, placement: PlacePlacement | null): PlacePlacement | null;
  setParent(instanceId: PlaceId, parentId: PlaceId | null): PlaceInstance;
  addInstancePortal(instanceId: PlaceId, spec: any): any; removeInstancePortal(instanceId: PlaceId, portalId: string): boolean;
  getPortalsForDomain(domainId: string): any[]; getPortalRecord(key: string): any | null;
  locate(domainId: string, position: Vec2): LocationContext; locateEntity(entity: { domainId?: string; position: Vec2 }): LocationContext;
  syncEntityOccupancy(entity: { id: EntityId; domainId?: string; position: Vec2 }): LocationContext;
  removeEntityOccupancy(entityId: EntityId): boolean; getEntityLocation(entityId: EntityId): LocationContext | null;
  entitiesInPlace(instanceId: PlaceId): Set<EntityId>; entitiesInSpace(instanceId: PlaceId, spaceId: string): Set<EntityId>;
  setEventCapture(enabled: boolean): void; drainEvents(target?: any[]): any[]; peekEvents(): any[];
  getEventQueueStats(): { size: number; limit: number; overflowPolicy: string; dropped: number };
  getDiagnostics(): Record<string, number>; assertInternalConsistency(): Record<string, number>;
}
export function isPortalTraversable(portal: any): boolean;

export class WorldCoreBridge {
  constructor(input: { world: any; navigation: any; startJourney: Function; stopJourney: Function; Navigation?: new (options?: any) => any });
  readonly world: any; readonly navigation: any;
  materializePlace(instance: PlaceInstance, definition: CompiledPlaceDefinition): void;
  unmaterializePlace(instance: PlaceInstance, definition: CompiledPlaceDefinition): void;
  planLocalRoute(input: any): any; startLocalJourney(entityId: EntityId, destinationNodeId: string, options?: any): boolean;
  stopLocalJourney(entityId: EntityId): void; transferEntity(entityId: EntityId, endpoint: any): any; getEntity(entityId: EntityId): any;
}

export type TravelTarget = { placeId: PlaceId; anchorId?: string; spaceId?: string };
export type TravelStep =
  | { type: "local-journey"; domainId: string; destinationNodeId: string; destinationPosition: Vec2; estimatedSeconds: number }
  | { type: "traverse-portal"; portalKey: string; placeId: PlaceId; portalId: string; fromDomainId: string; toDomainId: string; destinationPosition: Vec2; transitionCost: number };
export interface TravelPlan { entityId: EntityId; target: TravelTarget; resolvedTarget: any; graphRevision: number; startDomainId: string; steps: readonly TravelStep[]; estimatedSeconds: number }
export interface TravelState { entityId: EntityId; target: TravelTarget; plan: TravelPlan; stepIndex: number; localStarted: boolean; graphRevision: number; status: "active" | "complete" | "failed" | "cancelled"; failureReason: string | null }
export function findDomainPortalPath(registry: PlaceRegistry, startDomainId: string, targetDomainId: string, options?: { excludedPortalKeys?: Set<string> }): any[] | null;
export function resolveTravelTarget(registry: PlaceRegistry, target: TravelTarget): any;
export function planTravel(registry: PlaceRegistry, entityOrId: EntityId | any, target: TravelTarget, options?: any): TravelPlan | null;
export function startTravel(registry: PlaceRegistry, entityId: EntityId, target: TravelTarget, options?: any): TravelState | null;
export function stepTravel(registry: PlaceRegistry, entityId: EntityId, options?: any): TravelState | null;
export function stepPlaceSimulation(registry: PlaceRegistry, options?: any): number;
export function stopTravel(registry: PlaceRegistry, entityId: EntityId, options?: any): boolean;

export const PLACE_CORE_SNAPSHOT_VERSION: number;
export function serializePlaceCore(registry: PlaceRegistry): any;
export function validatePlaceCoreSnapshot(snapshot: unknown, options?: { expectedVersion?: number }): true;
export function deserializePlaceCore(snapshot: unknown, options: { definitions: Map<string, CompiledPlaceDefinition> | CompiledPlaceDefinition[] | Record<string, CompiledPlaceDefinition>; bridge?: WorldCoreBridge; restartTravels?: boolean }): PlaceRegistry;
export function computePlaceCoreStateHash(registry: PlaceRegistry): string;

export function geometryBounds(geometry: Geometry): { minX: number; minY: number; maxX: number; maxY: number };
export function pointInGeometry(point: Vec2, geometry: Geometry): boolean;
export function transformPoint(point: Vec2, transform?: any): Vec2;
export function inverseTransformPoint(point: Vec2, transform?: any): Vec2;
export function transformBounds(bounds: any, transform?: any): any;
export class StaticGeometryIndex { constructor(items: any[], options?: any); queryPoint(point: Vec2, predicate?: any, geometryOf?: any): any[]; readonly cellCount: number }
export class DynamicAabbIndex { constructor(cellSize?: number); set(id: PlaceId, bounds: any): void; delete(id: PlaceId): boolean; queryPoint(point: Vec2): PlaceId[]; readonly size: number; readonly cellCount: number }
