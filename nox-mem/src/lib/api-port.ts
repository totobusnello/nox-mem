/**
 * api-port.ts — the HTTP API port, in one place.
 *
 * Default 18802. The code used to default to the port just below it while every
 * document said 18802, and that lower port is squatted by Chrome on many desktops.
 * NOX_API_PORT overrides; an empty or non-numeric value falls back to the default
 * rather than handing `listen()` a NaN.
 */

export const DEFAULT_API_PORT = 18802;

export function resolveApiPort(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.NOX_API_PORT?.trim();
  if (!raw) return DEFAULT_API_PORT;
  const n = Number.parseInt(raw, 10);
  return Number.isInteger(n) && n >= 0 && n <= 65535 ? n : DEFAULT_API_PORT;
}
