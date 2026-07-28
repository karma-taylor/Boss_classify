// Configure this public ingestion token only in a release build. Keep it empty
// in source so an opt-in checkbox can never activate telemetry by accident.
const POSTHOG_PROJECT_API_KEY = "";
export const TELEMETRY_ENDPOINT = "https://us.i.posthog.com/i/v0/e/";

const ALLOWED_EVENT_NAMES = new Set(["app_launched", "task_completed", "error_triggered"]);
const TASK_TYPES = new Set(["history_sync", "boss_search"]);
const ERROR_TYPES = new Set(["dom_mismatch", "login_redirect", "captcha_blocked", "timeout"]);
const ERROR_SOURCES = new Set(["content_script"]);

export async function trackEvent(eventName, properties = {}) {
  if (!ALLOWED_EVENT_NAMES.has(eventName) || !(await isTelemetryEnabled())) return false;

  const safeProperties = pickAllowedProperties(eventName, properties);
  if (!safeProperties) return false;

  try {
    const response = await fetch(TELEMETRY_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: POSTHOG_PROJECT_API_KEY,
        event: eventName,
        distinct_id: await getOrCreateDeviceId(),
        properties: safeProperties
      }),
      keepalive: true
    });
    return response.ok;
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

  const tracked = await trackEvent("app_launched", {
    extension_version: chrome.runtime.getManifest().version
  });
  if (tracked) await chrome.storage.local.set({ telemetry_last_launch_date: today });
  return tracked;
}

async function isTelemetryEnabled() {
  const { telemetry_enabled: enabled } = await chrome.storage.local.get("telemetry_enabled");
  return enabled === true && isPosthogConfigured();
}

function isPosthogConfigured() {
  return POSTHOG_PROJECT_API_KEY.length > 0 && !POSTHOG_PROJECT_API_KEY.startsWith("YOUR_");
}

async function getOrCreateDeviceId() {
  const { telemetry_device_id: deviceId } = await chrome.storage.local.get("telemetry_device_id");
  if (deviceId) return deviceId;

  const nextDeviceId = crypto.randomUUID();
  await chrome.storage.local.set({ telemetry_device_id: nextDeviceId });
  return nextDeviceId;
}

function pickAllowedProperties(eventName, properties) {
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) return null;

  // This object is intentionally built field-by-field. Never spread caller
  // data into telemetry payloads: unrecognized properties are discarded.
  if (eventName === "app_launched") {
    const extensionVersion = String(properties.extension_version || "");
    if (!/^\d+(\.\d+){1,3}$/.test(extensionVersion)) return null;
    return {
      $process_person_profile: false,
      extension_version: extensionVersion
    };
  }

  if (eventName === "task_completed") {
    const requestedCount = toSafeCount(properties.requested_count);
    const successCount = toSafeCount(properties.success_count);
    const skippedCount = toSafeCount(properties.skipped_count);
    if (requestedCount === null || successCount === null || skippedCount === null || !TASK_TYPES.has(properties.type)) return null;
    return {
      $process_person_profile: false,
      requested_count: requestedCount,
      success_count: successCount,
      skipped_count: skippedCount,
      type: properties.type
    };
  }

  if (eventName === "error_triggered") {
    if (!ERROR_TYPES.has(properties.error_type) || !ERROR_SOURCES.has(properties.source)) return null;
    return {
      $process_person_profile: false,
      error_type: properties.error_type,
      source: properties.source
    };
  }

  return null;
}

function toSafeCount(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.max(0, Math.floor(value));
}
