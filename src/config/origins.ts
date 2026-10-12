/** Where each API key or URL came from (env var name -> e.g. ".env"), so a rejected key can say where to fix it. */
const origins = new Map<string, string>();

export function noteOrigin(names: Iterable<string>, origin: string) {
  for (const name of names) origins.set(name, origin);
}

/** Where a setting came from, or undefined if it isn't set. */
export function originOf(name: string): string | undefined {
  if (!process.env[name]) return undefined;
  return origins.get(name) ?? "your environment";
}

/** Whether it was set outside Nou (your shell or .env), where it wins over a key saved in Nou on the next start. */
export const setOutsideNou = (name: string) => ["your environment", ".env"].includes(originOf(name) ?? "");
