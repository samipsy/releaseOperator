export function parseAffectedServices(raw: string): string[] {
  return raw
    .split(/[,;\n]/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

export function isJsmServiceAri(value: string): boolean {
  return value.startsWith("ari:cloud:graph::service/");
}

export interface JsmServiceHit {
  id: string;
  name?: string;
}

export async function resolveAffectedServiceAris(
  queries: string[],
  search?: (query: string) => Promise<JsmServiceHit[]>
): Promise<string[]> {
  const ids: string[] = [];
  for (const query of queries) {
    if (isJsmServiceAri(query)) {
      ids.push(query);
      continue;
    }
    if (!search) {
      throw new Error(
        `Affected service "${query}" is not a JSM service ARI, and Jira service lookup is not available.`
      );
    }
    const hits = await search(query);
    const wanted = query.toLowerCase();
    const exact = hits.find((hit) => hit.name?.toLowerCase() === wanted);
    const pick = exact ?? hits[0];
    if (!pick?.id) {
      throw new Error(`No Jira affected service matched "${query}".`);
    }
    ids.push(pick.id);
  }
  return ids;
}

export function parseServiceRegistryHits(body: unknown): JsmServiceHit[] {
  const rows = serviceRegistryRows(body);
  const hits: JsmServiceHit[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const rec = row as Record<string, unknown>;
    const id = typeof rec.id === "string" ? rec.id : undefined;
    if (!id) continue;
    const name = typeof rec.name === "string" ? rec.name : undefined;
    hits.push(name ? { id, name } : { id });
  }
  return hits;
}

function serviceRegistryRows(body: unknown): unknown[] {
  if (Array.isArray(body)) return body;
  if (!body || typeof body !== "object") return [];
  const rec = body as Record<string, unknown>;
  for (const key of ["values", "services", "data", "results"]) {
    const nested = rec[key];
    if (Array.isArray(nested)) return nested;
  }
  return [];
}
