import { join } from "node:path";

export function contextUsageDirectory(loomHome: string): string {
  return join(loomHome, "state", "context-usage");
}

export function legacyContextUsageDirectory(loomHome: string): string {
  return join(loomHome, "context");
}

export function providerUsageDirectory(loomHome: string): string {
  return join(loomHome, "state", "provider-usage");
}

export function legacyProviderUsageDirectory(loomHome: string): string {
  return join(loomHome, "provider-usage");
}

export function telemetrySidecarFilename(sessionName: string): string {
  return `${sessionName.replace(/[^a-zA-Z0-9@._-]/g, "_")}.json`;
}

export function telemetrySidecarPath(directory: string, sessionName: string): string {
  return join(directory, telemetrySidecarFilename(sessionName));
}
