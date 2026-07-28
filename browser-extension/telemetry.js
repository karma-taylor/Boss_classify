// Keep this empty in release builds. Telemetry cannot send until a real HTTPS
// endpoint is intentionally configured and the user enables it.
export const TELEMETRY_ENDPOINT = "";

const EVENT_PROPERTIES = {
  app_launched: ["extension_version"],
  task_completed: ["requested_count", "success_count", "skipped_count", "type"],
  error_triggered: ["error_type", "source"]
};

const ENUM_VALUES = {
  type: new Set(["history_sync", "boss_search"]),
  error_type: new Set(["dom_mismatch", "login_redirect", "captcha_blocked", "timeout"]),
  source: new Set(["content_script"])
};

export async function trackEvent(eventName, properties = {}) {
  const allowedProperties = EVENT_PROPERTIES[eventName];
  if (!allowedProperties || !(await isTelemetryEnabled())) return false;

  const safeProperties = sanitizeProperties(allowedProperties, properties);
  if (safeProperties === null) return false;

  try {
    await fetch(TELEMETRY_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        event: eventName,
        device_id: await getDeviceId(),
        properties: safeProperties
      })
    });
    return true;
  } catch {
    return false;
  }
}

export async function trackDailyLaunch() {
  if (!(await isTelemetryEnabled())) return false;
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const { telemetry_last_launch_date: lastLaunchDate } = await chrome.storage.local.get("telemetry_last_launch_date");
  if (lastLaunchDate === today) return false;

  await chrome.storage.local.set({ telemetry_last_launch_date: today });
  return trackEvent("app_launched", { extension_version: chrome.runtime.getManifest().version });
}

async function isTelemetryEnabled() {
  const { telemetry_enabled: enabled } = await chrome.storage.local.get("telemetry_enabled");
  return enabled === true && isValidTelemetryEndpoint(TELEMETRY_ENDPOINT);
}

function isValidTelemetryEndpoint(value) {
  try {
    const endpoint = new URL(value);
    return endpoint.protocol === "https:" && Boolean(endpoint.hostname);
  } catch {
    return false;
  }
}

async function getDeviceId() {
  const { telemetry_device_id: deviceId } = await chrome.storage.local.get("telemetry_device_id");
  if (deviceId) return deviceId;

  const nextDeviceId = crypto.randomUUID();
  await chrome.storage.local.set({ telemetry_device_id: nextDeviceId });
  return nextDeviceId;
}

function sanitizeProperties(allowedProperties, properties) {
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) return null;
  const keys = Object.keys(properties);
  if (keys.some((key) => !allowedProperties.includes(key))) return null;

  const sanitized = {};
  for (const key of allowedProperties) {
    const value = properties[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      sanitized[key] = Math.max(0, Math.floor(value));
    } else if (typeof value === "boolean") {
      sanitized[key] = value;
    } else if (ENUM_VALUES[key]?.has(value) || (key === "extension_version" && /^\d+\.\d+\.\d+$/.test(value))) {
      sanitized[key] = value;
    } else {
      return null;
    }
  }
  return sanitized;
}
