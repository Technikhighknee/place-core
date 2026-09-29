import { createHash } from "node:crypto";

export function assertId(id, label = "id") {
  const validString = typeof id === "string" && id.length > 0;
  const validNumber = typeof id === "number" && Number.isFinite(id);
  if (!validString && !validNumber) {
    throw new TypeError(`${label} must be a non-empty string or finite number`);
  }
  return id;
}

export function assertStringId(id, label = "id") {
  if (typeof id !== "string" || id.length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return id;
}

export function tupleKey(...parts) {
  let key = "";
  for (const part of parts) {
    const type = typeof part;
    const value = String(part);
    key += `${type.length}:${type}${value.length}:${value}`;
  }
  return key;
}

function isPlainObject(value) {
  if (!value || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function defineOwnJsonProperty(target, key, value) {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true
  });
}

function cloneJsonValue(value, path, ancestors) {
  if (value === null) return null;

  switch (typeof value) {
    case "string":
    case "boolean":
      return value;
    case "number":
      if (!Number.isFinite(value)) {
        throw new TypeError(`${path} contains a non-finite number`);
      }
      return value;
    case "undefined":
      throw new TypeError(`${path} contains undefined, which is not JSON-safe`);
    case "bigint":
    case "function":
    case "symbol":
      throw new TypeError(`${path} contains non-JSON value of type ${typeof value}`);
    case "object":
      break;
    default:
      throw new TypeError(`${path} contains unsupported value`);
  }

  if (ancestors.has(value)) {
    throw new TypeError(`${path} contains a circular JSON structure`);
  }

  if (Array.isArray(value)) {
    ancestors.add(value);
    try {
      return value.map((item, index) =>
        cloneJsonValue(item, `${path}[${index}]`, ancestors)
      );
    } finally {
      ancestors.delete(value);
    }
  }

  if (!isPlainObject(value)) {
    const typeName = value?.constructor?.name ?? "object";
    throw new TypeError(
      `${path} contains non-JSON object ${typeName}`
    );
  }

  const result = {};
  ancestors.add(value);
  try {
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined) {
        throw new TypeError(
          `${path}.${key} contains undefined, which is not JSON-safe`
        );
      }
      defineOwnJsonProperty(
        result,
        key,
        cloneJsonValue(item, `${path}.${key}`, ancestors)
      );
    }
  } finally {
    ancestors.delete(value);
  }
  return result;
}

export function normalizeBoolean(
  value,
  label = "value",
  { defaultValue = undefined } = {}
) {
  if (value === undefined) return defaultValue;
  if (typeof value !== "boolean") {
    throw new TypeError(`${label} must be a boolean`);
  }
  return value;
}

export function normalizeStringList(
  value,
  label = "value",
  { allowNull = false, defaultValue = undefined } = {}
) {
  if (value === undefined) {
    if (defaultValue === undefined) return undefined;
    value = defaultValue;
  }
  if (value === null) {
    if (allowNull) return null;
    throw new TypeError(`${label} must be an array of non-empty strings`);
  }
  if (!Array.isArray(value)) {
    throw new TypeError(`${label} must be an array of non-empty strings`);
  }

  const result = [];
  const seen = new Set();
  for (let i = 0; i < value.length; i += 1) {
    const item = value[i];
    assertStringId(item, `${label}[${i}]`);
    if (seen.has(item)) continue;
    seen.add(item);
    result.push(item);
  }
  return Object.freeze(result);
}

export function cloneJson(value) {
  if (value === undefined) return undefined;
  return cloneJsonValue(value, "value", new Set());
}

export function deepFreeze(value, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) deepFreeze(item, seen);
  } else {
    for (const key of Object.keys(value)) deepFreeze(value[key], seen);
  }
  return Object.freeze(value);
}

export function canonicalize(value, ancestors = new Set()) {
  if (value === null) return null;

  switch (typeof value) {
    case "string":
    case "boolean":
      return value;
    case "number":
      if (!Number.isFinite(value)) {
        throw new TypeError("non-finite number cannot be canonicalized");
      }
      return value;
    case "undefined":
      return undefined;
    case "bigint":
    case "function":
    case "symbol":
      throw new TypeError(
        `non-JSON value of type ${typeof value} cannot be canonicalized`
      );
    case "object":
      break;
    default:
      throw new TypeError("unsupported value cannot be canonicalized");
  }

  if (ancestors.has(value)) {
    throw new TypeError("circular JSON structure cannot be canonicalized");
  }

  if (Array.isArray(value)) {
    ancestors.add(value);
    try {
      return value.map((item, index) => {
        if (item === undefined) {
          throw new TypeError(
            `undefined array entry at index ${index} cannot be canonicalized`
          );
        }
        return canonicalize(item, ancestors);
      });
    } finally {
      ancestors.delete(value);
    }
  }

  if (!isPlainObject(value)) {
    const typeName = value?.constructor?.name ?? "object";
    throw new TypeError(
      `non-JSON object ${typeName} cannot be canonicalized`
    );
  }

  const result = {};
  ancestors.add(value);
  try {
    for (const key of Object.keys(value).sort()) {
      const item = value[key];
      if (item === undefined) continue;
      defineOwnJsonProperty(
        result,
        key,
        canonicalize(item, ancestors)
      );
    }
  } finally {
    ancestors.delete(value);
  }
  return result;
}

export function canonicalStringify(value) {
  const canonical = canonicalize(value);
  const serialized = JSON.stringify(canonical);
  if (serialized === undefined) {
    throw new TypeError("value cannot be serialized canonically");
  }
  return serialized;
}

export function sha256(value) {
  const serialized = typeof value === "string"
    ? value
    : canonicalStringify(value);
  return createHash("sha256").update(serialized).digest("hex");
}

export class BoundedEventQueue {
  #items = [];
  #limit;
  #overflowPolicy;
  #dropped = 0;

  constructor({ limit = 10_000, overflowPolicy = "drop-newest" } = {}) {
    this.configure({ limit, overflowPolicy });
  }

  configure({ limit = this.#limit, overflowPolicy = this.#overflowPolicy } = {}) {
    if (!Number.isInteger(limit) || limit < 0) throw new RangeError("event queue limit must be a non-negative integer");
    if (!["drop-newest", "drop-oldest"].includes(overflowPolicy)) {
      throw new TypeError(
        'event overflow policy must be "drop-newest" or "drop-oldest"'
      );
    }
    this.#limit = limit;
    this.#overflowPolicy = overflowPolicy;
    if (this.#items.length > limit) {
      const removed = this.#items.length - limit;
      if (overflowPolicy === "drop-newest") this.#items.length = limit;
      else this.#items.splice(0, removed);
      this.#dropped += removed;
    }
  }

  push(event) {
    if (this.#limit === 0 || this.#items.length >= this.#limit) {
      if (this.#overflowPolicy === "drop-oldest" && this.#limit > 0) {
        this.#items.shift();
        this.#items.push(event);
      }
      this.#dropped += 1;
      return false;
    }
    this.#items.push(event);
    return true;
  }

  drain(target = []) {
    target.push(...this.#items);
    this.#items.length = 0;
    return target;
  }

  peek() { return [...this.#items]; }
  clear() { this.#items.length = 0; }
  resetDropped() { const v = this.#dropped; this.#dropped = 0; return v; }
  get size() { return this.#items.length; }
  get limit() { return this.#limit; }
  get overflowPolicy() { return this.#overflowPolicy; }
  get dropped() { return this.#dropped; }
}
