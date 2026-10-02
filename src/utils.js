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

export function compareStrings(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
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

export function encodeIdSegment(value) {
  const text = String(value);

  try {
    return encodeURIComponent(text);
  } catch (error) {
    if (!(error instanceof URIError)) {
      throw error;
    }

    let encoded = "";
    for (let i = 0; i < text.length; i += 1) {
      encoded +=
        `%u${text
          .charCodeAt(i)
          .toString(16)
          .toUpperCase()
          .padStart(4, "0")}`;
    }
    return encoded;
  }
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

function jsonPathChild(parent, segment) {
  return { parent, segment };
}

function formatJsonPath(path) {
  const segments = [];
  let cursor = path;
  while (cursor?.parent != null) {
    segments.push(cursor.segment);
    cursor = cursor.parent;
  }
  segments.reverse();
  return "value" + segments.join("");
}

function inspectJsonValue(value, path, mode) {
  if (value === null) {
    return { container: false, value: null };
  }

  switch (typeof value) {
    case "string":
    case "boolean":
      return { container: false, value };
    case "number":
      if (!Number.isFinite(value)) {
        throw new TypeError(
          mode === "canonical"
            ? "non-finite number cannot be canonicalized"
            : `${formatJsonPath(path)} contains a non-finite number`
        );
      }
      return { container: false, value };
    case "undefined":
      throw new TypeError(
        mode === "canonical"
          ? "undefined array entry cannot be canonicalized"
          : `${formatJsonPath(path)} contains undefined, which is not JSON-safe`
      );
    case "bigint":
    case "function":
    case "symbol":
      throw new TypeError(
        mode === "canonical"
          ? `non-JSON value of type ${typeof value} cannot be canonicalized`
          : `${formatJsonPath(path)} contains non-JSON value of type ${typeof value}`
      );
    case "object":
      break;
    default:
      throw new TypeError(
        mode === "canonical"
          ? "unsupported value cannot be canonicalized"
          : `${formatJsonPath(path)} contains unsupported value`
      );
  }

  if (!Array.isArray(value) && !isPlainObject(value)) {
    const typeName =
      value?.constructor?.name ?? "object";
    throw new TypeError(
      mode === "canonical"
        ? `non-JSON object ${typeName} cannot be canonicalized`
        : `${formatJsonPath(path)} contains non-JSON object ${typeName}`
    );
  }

  return {
    container: true,
    array: Array.isArray(value)
  };
}

function copyJsonIterative(value, mode) {
  if (value === undefined) return undefined;

  const rootPath = {
    parent: null,
    segment: ""
  };
  const rootInfo =
    inspectJsonValue(value, rootPath, mode);
  if (!rootInfo.container) {
    return rootInfo.value;
  }

  const root = rootInfo.array
    ? new Array(value.length)
    : {};
  const active = new Set([value]);
  const stack = [{
    source: value,
    target: root,
    path: rootPath,
    array: rootInfo.array,
    index: 0,
    keys: rootInfo.array
      ? null
      : (
          mode === "canonical"
            ? Object.keys(value).sort(compareStrings)
            : Object.keys(value)
        )
  }];

  while (stack.length > 0) {
    const frame = stack[stack.length - 1];

    if (frame.array) {
      if (frame.index >= frame.source.length) {
        active.delete(frame.source);
        stack.pop();
        continue;
      }

      const index = frame.index;
      frame.index += 1;

      // Preserve sparse array holes. JSON serialization
      // later represents them as null, matching JSON.stringify.
      if (!(index in frame.source)) continue;

      const item = frame.source[index];
      const path = jsonPathChild(
        frame.path,
        `[${index}]`
      );
      const info = inspectJsonValue(
        item,
        path,
        mode
      );

      if (!info.container) {
        frame.target[index] = info.value;
        continue;
      }

      if (active.has(item)) {
        throw new TypeError(
          mode === "canonical"
            ? "circular JSON structure cannot be canonicalized"
            : `${formatJsonPath(path)} contains a circular JSON structure`
        );
      }

      const child = info.array
        ? new Array(item.length)
        : {};
      frame.target[index] = child;
      active.add(item);
      stack.push({
        source: item,
        target: child,
        path,
        array: info.array,
        index: 0,
        keys: info.array
          ? null
          : (
              mode === "canonical"
                ? Object.keys(item).sort(compareStrings)
                : Object.keys(item)
            )
      });
      continue;
    }

    if (frame.index >= frame.keys.length) {
      active.delete(frame.source);
      stack.pop();
      continue;
    }

    const key = frame.keys[frame.index];
    frame.index += 1;
    const item = frame.source[key];

    if (item === undefined && mode === "canonical") {
      continue;
    }

    const path = jsonPathChild(
      frame.path,
      `.${key}`
    );
    const info = inspectJsonValue(
      item,
      path,
      mode
    );

    if (!info.container) {
      defineOwnJsonProperty(
        frame.target,
        key,
        info.value
      );
      continue;
    }

    if (active.has(item)) {
      throw new TypeError(
        mode === "canonical"
          ? "circular JSON structure cannot be canonicalized"
          : `${formatJsonPath(path)} contains a circular JSON structure`
      );
    }

    const child = info.array
      ? new Array(item.length)
      : {};
    defineOwnJsonProperty(
      frame.target,
      key,
      child
    );
    active.add(item);
    stack.push({
      source: item,
      target: child,
      path,
      array: info.array,
      index: 0,
      keys: info.array
        ? null
        : (
            mode === "canonical"
              ? Object.keys(item).sort(compareStrings)
              : Object.keys(item)
          )
    });
  }

  return root;
}

function stringifyJsonIterative(value) {
  const scalar = (item) => {
    if (item === null) return "null";
    switch (typeof item) {
      case "string":
      case "boolean":
      case "number":
        return JSON.stringify(item);
      default:
        return null;
    }
  };

  const direct = scalar(value);
  if (direct != null) return direct;

  const chunks = [];
  const stack = [];

  const pushContainer = (container) => {
    const array = Array.isArray(container);
    chunks.push(array ? "[" : "{");
    stack.push({
      value: container,
      array,
      index: 0,
      keys: array
        ? null
        : Object.keys(container)
    });
  };

  pushContainer(value);

  while (stack.length > 0) {
    const frame = stack[stack.length - 1];

    if (frame.array) {
      if (frame.index >= frame.value.length) {
        chunks.push("]");
        stack.pop();
        continue;
      }

      if (frame.index > 0) chunks.push(",");
      const index = frame.index;
      frame.index += 1;

      if (!(index in frame.value)) {
        chunks.push("null");
        continue;
      }

      const item = frame.value[index];
      const serialized = scalar(item);
      if (serialized != null) {
        chunks.push(serialized);
      } else {
        pushContainer(item);
      }
      continue;
    }

    if (frame.index >= frame.keys.length) {
      chunks.push("}");
      stack.pop();
      continue;
    }

    if (frame.index > 0) chunks.push(",");
    const key = frame.keys[frame.index];
    frame.index += 1;
    chunks.push(
      JSON.stringify(key),
      ":"
    );

    const item = frame.value[key];
    const serialized = scalar(item);
    if (serialized != null) {
      chunks.push(serialized);
    } else {
      pushContainer(item);
    }
  }

  return chunks.join("");
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
  result.sort(compareStrings);
  return Object.freeze(result);
}

export function cloneJson(value) {
  return copyJsonIterative(
    value,
    "clone"
  );
}

export function deepFreeze(value, seen = new Set()) {
  if (!value || typeof value !== "object") {
    return value;
  }

  const stack = [{
    value,
    expanded: false
  }];

  while (stack.length > 0) {
    const frame = stack.pop();
    const current = frame.value;

    if (!current ||
        typeof current !== "object") {
      continue;
    }

    if (frame.expanded) {
      Object.freeze(current);
      continue;
    }

    if (seen.has(current)) continue;
    seen.add(current);

    stack.push({
      value: current,
      expanded: true
    });

    if (Array.isArray(current)) {
      for (
        let i = current.length - 1;
        i >= 0;
        i -= 1
      ) {
        if (i in current) {
          stack.push({
            value: current[i],
            expanded: false
          });
        }
      }
    } else {
      const keys = Object.keys(current);
      for (
        let i = keys.length - 1;
        i >= 0;
        i -= 1
      ) {
        stack.push({
          value: current[keys[i]],
          expanded: false
        });
      }
    }
  }

  return value;
}

export function canonicalize(value) {
  return copyJsonIterative(
    value,
    "canonical"
  );
}

export function canonicalStringify(value) {
  const canonical = canonicalize(value);
  if (canonical === undefined) {
    throw new TypeError(
      "value cannot be serialized canonically"
    );
  }
  return stringifyJsonIterative(canonical);
}

export function sha256(value) {
  const serialized = typeof value === "string"
    ? value
    : canonicalStringify(value);
  return createHash("sha256")
    .update(serialized)
    .digest("hex");
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
