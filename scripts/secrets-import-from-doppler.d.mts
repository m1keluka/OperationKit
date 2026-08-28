// Type declaration for the pure transform exported by the Doppler importer
// (obj-2353 / W3), so the unit test can import it under tsc strict.
export function dopplerJsonToImportList(
  json: Record<string, { computed?: string; raw?: string }> | null | undefined,
): { key: string }[]
