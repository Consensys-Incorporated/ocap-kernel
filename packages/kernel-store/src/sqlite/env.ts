/// <reference types="vite/client" />

/**
 * Get the DB folder from environment variables.
 *
 * @returns The configured DB folder or an empty string
 */
export function getDBFolder(): string {
  return import.meta.env?.VITE_DB_FOLDER ?? '';
}
