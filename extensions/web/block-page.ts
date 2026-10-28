/**
 * Is this body a firewall's block page rather than the API's answer? A Palo
 * Alto App-ID filter, for one, answers blocked hosts with a 503 and an HTML
 * page titled "... Security Policy Violation - Web Application Blocked
 * (Restricted App-ID)". Matched on wording firewall templates use (Palo Alto,
 * Zscaler, Fortinet) and only on HTML, so an API's own JSON error that says
 * "blocked" doesn't count. Returns the page title (or a stand-in) when it is.
 *
 * Shared by the search chain and the fetch ladder's paid tiers, so both bench
 * a blocked backend the same way and /web can say why.
 */
export function policyBlockTitle(body: string): string | undefined {
  if (!/<html|<title/i.test(body)) return undefined;
  const title = body.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]?.replace(/\s+/g, " ").trim() ?? "";
  const pattern =
    /security policy violation|web (application|page|site) blocked|restricted app-?id|url filtering|access (denied|blocked) by (your )?(organization|administrator)|zscaler|fortiguard/i;
  if (pattern.test(title)) return title;
  if (pattern.test(body.slice(0, 4000))) return title || "network policy block page";
  return undefined;
}
