function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function getOtaAppVersion(manifest: unknown): string | null {
  if (!isRecord(manifest) || !isRecord(manifest.extra)) {
    return null;
  }

  const value = manifest.extra.otaAppVersion;
  return typeof value === 'string' && value.length > 0 ? value : null;
}
