import { cloneJson, deepFreeze } from "../utils.js";
import {
  PLACE_INSTANCE_MUTATION_TOKEN,
  ReadonlyMapView,
  membershipKey
} from "./support.js";

export class PlaceInstance {
  #id;
  #definitionId;
  #parentId;
  #layerDomains;
  #attachments;
  #placement;
  #metadata;

  #portalOverrides = new Map();
  #boundaryOverrides = new Map();
  #spaceOverrides = new Map();
  #dynamicPortals = new Map();
  #memberships = new Map();

  #layerDomainsView;
  #attachmentsView;
  #portalOverridesView;
  #boundaryOverridesView;
  #spaceOverridesView;
  #dynamicPortalsView;

  constructor(data) {
    this.#id = data.id;
    this.#definitionId = data.definitionId;
    this.#parentId = data.parentId ?? null;
    this.#layerDomains = new Map(data.layerDomains);
    this.#attachments = new Map(data.attachments);
    this.#placement = data.placement;
    this.#metadata = deepFreeze(
      cloneJson(data.metadata ?? null)
    );

    this.#layerDomainsView =
      new ReadonlyMapView(this.#layerDomains);
    this.#attachmentsView =
      new ReadonlyMapView(this.#attachments);
    this.#portalOverridesView =
      new ReadonlyMapView(this.#portalOverrides);
    this.#boundaryOverridesView =
      new ReadonlyMapView(this.#boundaryOverrides);
    this.#spaceOverridesView =
      new ReadonlyMapView(this.#spaceOverrides);
    this.#dynamicPortalsView =
      new ReadonlyMapView(this.#dynamicPortals);

    for (const membership of data.memberships ?? []) {
      this.#memberships.set(
        membershipKey(
          membership.parentPlaceId,
          membership.kind
        ),
        membership
      );
    }

    Object.preventExtensions(this);
  }

  get id() { return this.#id; }
  get definitionId() { return this.#definitionId; }
  get parentId() { return this.#parentId; }
  get layerDomains() { return this.#layerDomainsView; }
  get attachments() { return this.#attachmentsView; }
  get placement() { return this.#placement; }
  get metadata() { return this.#metadata; }
  get portalOverrides() { return this.#portalOverridesView; }
  get boundaryOverrides() { return this.#boundaryOverridesView; }
  get spaceOverrides() { return this.#spaceOverridesView; }
  get dynamicPortals() { return this.#dynamicPortalsView; }

  #assertMutationToken(token) {
    if (token !== PLACE_INSTANCE_MUTATION_TOKEN) {
      throw new Error(
        "PlaceInstance structural state is registry-managed"
      );
    }
  }

  setParentId(parentId, token) {
    this.#assertMutationToken(token);
    this.#parentId = parentId;
  }

  setPlacement(placement, token) {
    this.#assertMutationToken(token);
    this.#placement = placement;
  }

  setAttachment(slot, attachment, token) {
    this.#assertMutationToken(token);
    this.#attachments.set(slot, attachment);
  }

  deleteAttachment(slot, token) {
    this.#assertMutationToken(token);
    return this.#attachments.delete(slot);
  }

  getPortalOverride(portalId) {
    return this.#portalOverrides.get(portalId) ?? null;
  }

  setPortalOverride(portalId, override, token) {
    this.#assertMutationToken(token);
    if (override == null ||
        Object.keys(override).length === 0) {
      this.#portalOverrides.delete(portalId);
    } else {
      this.#portalOverrides.set(
        portalId,
        deepFreeze({ ...override })
      );
    }
  }

  getBoundaryOverride(boundaryId) {
    return this.#boundaryOverrides.get(boundaryId) ?? null;
  }

  setBoundaryOverride(boundaryId, override, token) {
    this.#assertMutationToken(token);
    if (override == null ||
        Object.keys(override).length === 0) {
      this.#boundaryOverrides.delete(boundaryId);
    } else {
      this.#boundaryOverrides.set(
        boundaryId,
        deepFreeze({ ...override })
      );
    }
  }

  getSpaceOverride(spaceId) {
    return this.#spaceOverrides.get(spaceId) ?? null;
  }

  setSpaceOverride(spaceId, override, token) {
    this.#assertMutationToken(token);
    if (override == null ||
        Object.keys(override).length === 0) {
      this.#spaceOverrides.delete(spaceId);
    } else {
      this.#spaceOverrides.set(
        spaceId,
        deepFreeze({ ...override })
      );
    }
  }

  addDynamicPortal(portal, token) {
    this.#assertMutationToken(token);
    this.#dynamicPortals.set(
      portal.id,
      deepFreeze(portal)
    );
  }

  replaceDynamicPortal(portalId, portal, token) {
    this.#assertMutationToken(token);
    if (!this.#dynamicPortals.has(portalId)) {
      throw new Error(
        `unknown dynamic portal: ${portalId}`
      );
    }
    this.#dynamicPortals.set(
      portalId,
      deepFreeze(portal)
    );
  }

  removeDynamicPortal(portalId, token) {
    this.#assertMutationToken(token);
    return this.#dynamicPortals.delete(portalId);
  }

  getMembership(parentPlaceId, kind = "member-of") {
    return this.#memberships.get(
      membershipKey(parentPlaceId, kind)
    ) ?? null;
  }

  getMemberships() {
    return [...this.#memberships.values()];
  }

  addMembership(membership, token) {
    this.#assertMutationToken(token);

    const key = membershipKey(
      membership.parentPlaceId,
      membership.kind
    );
    if (this.#memberships.has(key)) return false;
    this.#memberships.set(key, membership);
    return true;
  }

  removeMembership(
    parentPlaceId,
    kind = "member-of",
    token
  ) {
    this.#assertMutationToken(token);
    return this.#memberships.delete(
      membershipKey(parentPlaceId, kind)
    );
  }
}
