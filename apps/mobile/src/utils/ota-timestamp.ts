import * as SecureStore from 'expo-secure-store';

const OTA_TIMESTAMP_KEY = 'ota_gateway_last_updated';
const MS_PER_DAY = 86_400_000;

/** Persist the current time as the last-confirmed-update timestamp. */
export async function saveOtaTimestamp(): Promise<void> {
  try {
    await SecureStore.setItemAsync(OTA_TIMESTAMP_KEY, String(Date.now()));
  } catch {
    // Storage failure is non-fatal -- the worst case is an extra OTA check.
  }
}

/** Read the stored timestamp (epoch ms) or null if never saved. */
export async function getLastOtaTimestamp(): Promise<number | null> {
  try {
    const raw = await SecureStore.getItemAsync(OTA_TIMESTAMP_KEY);
    if (raw == null) return null;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Returns true if no timestamp exists or if the stored timestamp is older
 * than `maxAgeDays` days from `now`.
 */
export function isOtaStale(
  lastTimestamp: number | null,
  maxAgeDays: number,
  now: number = Date.now(),
): boolean {
  if (lastTimestamp == null) return true;
  return now - lastTimestamp > maxAgeDays * MS_PER_DAY;
}
