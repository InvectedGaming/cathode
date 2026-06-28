/**
 * NordVPN location helpers.
 *
 * All NordVPN servers share the same CA / tls-auth / credentials — a config only
 * differs by its `remote <hostname>` and the matching `verify-x509-name CN=...`
 * (the cert CN is per-host). So "change location" is just: ask Nord's API for a
 * recommended OpenVPN-TCP server in the chosen country/city, then rewrite those
 * two lines. We tag the config with a `# phospharr-location:` comment so the UI
 * can show where a tunnel currently exits (OpenVPN ignores comment lines).
 */

export type NordCountry = { id: number; name: string; code: string; cities: { id: number; name: string }[] };

const API = "https://api.nordvpn.com/v1";
let countriesCache: { at: number; data: NordCountry[] } | null = null;

/** Is this an OpenVPN config pointed at NordVPN? */
export function isNordConfig(config: string): boolean {
  return /nordvpn\.com/i.test(config);
}

/** Countries (with their cities), sorted by name. Cached 6h. */
export async function nordCountries(): Promise<NordCountry[]> {
  if (countriesCache && Date.now() - countriesCache.at < 6 * 3600_000) return countriesCache.data;
  const raw = (await (await fetch(`${API}/servers/countries`, { signal: AbortSignal.timeout(12_000) })).json()) as Array<{ id: number; name: string; code: string; cities?: Array<{ id: number; name: string }> }>;
  const data = raw
    .map((c) => ({ id: c.id, name: c.name, code: c.code, cities: (c.cities ?? []).map((x) => ({ id: x.id, name: x.name })).sort((a, b) => a.name.localeCompare(b.name)) }))
    .sort((a, b) => a.name.localeCompare(b.name));
  countriesCache = { at: Date.now(), data };
  return data;
}

/** A recommended (lowest-load) OpenVPN-TCP server for a country, optionally a city. */
export async function nordRecommend(countryId: number, cityId?: number): Promise<{ hostname: string; label: string } | null> {
  let url = `${API}/servers/recommendations?filters[country_id]=${countryId}&filters[servers_technologies][identifier]=openvpn_tcp&limit=1`;
  if (cityId) url += `&filters[country_city_id]=${cityId}`;
  const recs = (await (await fetch(url, { signal: AbortSignal.timeout(12_000) })).json()) as Array<{ hostname?: string; locations?: Array<{ country?: { name?: string; city?: { name?: string } } }> }>;
  const s = recs[0];
  if (!s?.hostname) return null;
  const loc = s.locations?.[0]?.country;
  const label = loc?.name ? `${loc.city?.name ? loc.city.name + ", " : ""}${loc.name}` : s.hostname;
  return { hostname: s.hostname, label };
}

/** Rewrite an OpenVPN config to point at `hostname` over TCP 443, fixing the
 *  per-host cert name. Collapses multiple `remote` lines to the one we set. */
export function setNordServer(config: string, hostname: string): string {
  let sawRemote = false, sawVerify = false;
  const out = config.split(/\r?\n/)
    .map((ln): string | null => {
      if (/^\s*remote\s+\S+/i.test(ln)) { if (sawRemote) return null; sawRemote = true; return `remote ${hostname} 443`; }
      if (/^\s*verify-x509-name\s+/i.test(ln)) { sawVerify = true; return `verify-x509-name CN=${hostname}`; }
      if (/^\s*proto\s+/i.test(ln)) return "proto tcp";
      return ln;
    })
    .filter((l): l is string => l !== null);
  if (!sawRemote) out.unshift(`remote ${hostname} 443`);
  if (!sawVerify) out.push(`verify-x509-name CN=${hostname}`);
  return out.join("\n");
}

/** Upsert the `# phospharr-location:` display tag. */
export function setLocationComment(config: string, label: string): string {
  const lines = config.split(/\r?\n/).filter((l) => !/^#\s*phospharr-location:/i.test(l));
  lines.push(`# phospharr-location: ${label}`);
  return lines.join("\n");
}

/** What a stored Nord config currently points at, for the UI. */
export function parseNordInfo(config: string): { nord: boolean; server: string | null; location: string | null } {
  if (!isNordConfig(config)) return { nord: false, server: null, location: null };
  const server = config.match(/^\s*remote\s+(\S+)/im)?.[1] ?? null;
  const location = config.match(/^#\s*phospharr-location:\s*(.+)$/im)?.[1]?.trim() ?? null;
  return { nord: true, server, location };
}
