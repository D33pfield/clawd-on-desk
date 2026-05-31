const SESSION_ID_PREFIX = "opencode:";

export const DEFAULT_SESSION_ID = `${SESSION_ID_PREFIX}default`;

function normalizeSessionText(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function normalizeOpencodeSessionId(value) {
  const raw = normalizeSessionText(value);
  if (!raw) return null;
  return raw.startsWith(SESSION_ID_PREFIX) ? raw : `${SESSION_ID_PREFIX}${raw}`;
}

export function getEventSessionId(event) {
  if (!event || typeof event !== "object") return null;
  const props = event.properties && typeof event.properties === "object"
    ? event.properties
    : {};
  return normalizeSessionText(props.sessionID) || normalizeSessionText(event.sessionID);
}

export function resolveOpencodeSessionId(current, fallback) {
  return normalizeOpencodeSessionId(current)
    || normalizeOpencodeSessionId(fallback)
    || DEFAULT_SESSION_ID;
}

export function shouldDropMappedEventWithoutSessionId(event, mapped) {
  return mapped
    && mapped.event === "SessionEnd"
    && !getEventSessionId(event);
}
