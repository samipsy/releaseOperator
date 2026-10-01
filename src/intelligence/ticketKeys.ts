const JIRA_KEY = /\b[A-Z][A-Z0-9]{1,9}-\d+\b/g;

/** Jira issue keys (e.g. PCM-123) found in free text such as commit messages. */
export function ticketKeysFromText(text: string): string[] {
  const found = text.match(JIRA_KEY) ?? [];
  return uniqueTicketKeys(found);
}

export function uniqueTicketKeys(keys: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of keys) {
    const key = raw.trim().toUpperCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}
