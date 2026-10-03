// Socrata Discovery API — finds civic datasets on a known open-data portal.
// Queries api.us.socrata.com/api/catalog/v1 scoped to the portal's domain,
// scores each result for civic relevance, and maps column names to a
// ready-to-run CivicAdapterMeta.
//
// No LLM involved: the "proposals" here come from Socrata's own catalog (a
// structured API over real datasets), and verification is the pattern match
// plus column mapping against the catalog's actual column metadata — so
// ctx.generate is unused and optional. Cross-run idempotency (has this
// dataset already been provisioned?) is the caller's job; this function only
// dedupes within its own result set.
import type {
  Locality,
  SocrataMeta,
  DiscoveryContext,
  DiscoveredSource,
} from "../types.js";
import { ctxFetch, ctxUserAgent } from "../internal.js";
import { localityCityName } from "./candidates.js";

const CATALOG_URL = "https://api.us.socrata.com/api/catalog/v1";
const MIN_SCORE = 12;
const MAX_SOURCES = 12;

// Socrata civic record types we auto-discover. Ordered by priority so that
// a dataset matching multiple patterns gets the most specific type.
const PATTERNS = [
  {
    recordType: "police_blotter" as const,
    nameKeywords: ["police", "incident", "crime", "blotter", "arrest", "offense", "calls for service", "dispatch"],
    catTags: ["public safety", "police", "crime", "law enforcement"],
    dateFields: ["date", "incident_date", "occurred_date", "date_occurred", "dispatch_date", "date_reported", "reported_date", "occurrence_date", "call_date"],
    caseFields: ["report_number", "case_number", "incident_number", "case_no", "report_no", "incident_id"],
    titleFields: ["offense_type", "crime_type", "call_type", "offense", "incident_type", "type_of_crime", "crime_description"],
    summaryFields: ["description", "narrative", "notes", "location_description"],
  },
  {
    recordType: "permit" as const,
    nameKeywords: ["permit", "building permit", "construction permit", "zoning", "variance"],
    catTags: ["housing", "development", "building", "construction", "permits"],
    dateFields: ["issued_date", "permit_date", "application_date", "date_issued", "approval_date", "issue_date", "issuance_date"],
    caseFields: ["permit_number", "permit_no", "application_number", "permit_id", "permitno"],
    titleFields: ["permit_type", "work_type", "description", "type", "permit_description", "project_description"],
    summaryFields: ["description", "project_description", "applicant_name", "contractor_name", "address"],
  },
  {
    recordType: "inspection" as const,
    nameKeywords: ["inspection", "restaurant inspection", "food inspection", "health inspection", "food safety", "sanitary"],
    catTags: ["health", "food", "inspection", "restaurants"],
    dateFields: ["inspection_date", "date_inspected", "date", "visit_date", "insp_date"],
    caseFields: ["inspection_id", "license_number", "facility_id", "license_no"],
    titleFields: ["facility_name", "restaurant_name", "business_name", "establishment_name", "dba_name", "name"],
    summaryFields: ["inspection_type", "result", "score", "grade", "risk", "address"],
  },
  {
    recordType: "violation" as const,
    nameKeywords: ["violation", "code enforcement", "citation", "nuisance", "blight", "property maintenance"],
    catTags: ["code enforcement", "housing", "violations", "citations"],
    dateFields: ["violation_date", "date_issued", "date", "issue_date", "open_date"],
    caseFields: ["violation_number", "case_number", "citation_number", "violation_id", "case_no"],
    titleFields: ["violation_type", "violation_description", "code_section", "description", "type"],
    summaryFields: ["description", "address", "status", "property_owner", "location"],
  },
  {
    recordType: "contract" as const,
    nameKeywords: ["contract", "procurement", "vendor", "bid", "purchase order", "award", "spending"],
    catTags: ["finance", "budget", "procurement", "contracts", "spending"],
    dateFields: ["award_date", "contract_date", "date", "start_date", "executed_date"],
    caseFields: ["contract_number", "po_number", "contract_id", "award_id", "purchase_order"],
    titleFields: ["vendor_name", "supplier_name", "contractor_name", "company_name", "description"],
    summaryFields: ["description", "department", "fund", "purpose", "scope_of_work"],
  },
] as const;

interface CatalogResource {
  id: string;
  name: string;
  description: string | null;
  type: string;
  columns_name: string[];
  columns_field_name: string[];
  columns_datatype: string[];
  updatedAt: string | null;
}

interface CatalogResult {
  resource: CatalogResource;
  link: string;
  metadata: { domain: string };
  classification: { categories: string[]; tags: string[] };
}

interface CatalogResponse {
  results: CatalogResult[];
  resultSetSize: number;
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9 ]/g, " ");
}

function scoreResult(result: CatalogResult): { score: number; patternIndex: number } {
  const name = normalize(result.resource.name);
  const desc = normalize(result.resource.description ?? "");
  const cats = result.classification.categories.map(normalize).join(" ");
  const tags = result.classification.tags.map(normalize).join(" ");

  let best = { score: 0, patternIndex: -1 };

  for (let i = 0; i < PATTERNS.length; i++) {
    const p = PATTERNS[i]!;
    let score = 0;

    for (const kw of p.nameKeywords) {
      if (name.includes(kw)) score += 10;
      if (desc.includes(kw)) score += 4;
    }
    for (const kw of p.catTags) {
      if (cats.includes(kw)) score += 8;
      if (tags.includes(kw)) score += 5;
    }

    if (score > best.score) best = { score, patternIndex: i };
  }

  return best;
}

// Pick the best matching column from a dataset's field names.
function pickColumn(candidates: readonly string[], fieldNames: string[]): string | null {
  const lower = fieldNames.map((f) => f.toLowerCase());
  for (const c of candidates) {
    const idx = lower.indexOf(c.toLowerCase());
    if (idx !== -1) return fieldNames[idx]!;
  }
  // Partial match fallback
  for (const c of candidates) {
    const idx = lower.findIndex((f) => f.includes(c.toLowerCase()) || c.toLowerCase().includes(f));
    if (idx !== -1) return fieldNames[idx]!;
  }
  return null;
}

function pickColumns(candidates: readonly string[], fieldNames: string[]): string[] {
  const result: string[] = [];
  for (const c of candidates) {
    const col = pickColumn([c], fieldNames);
    if (col && !result.includes(col)) result.push(col);
    if (result.length >= 2) break;
  }
  return result;
}

function buildMeta(result: CatalogResult, pattern: (typeof PATTERNS)[number]): SocrataMeta {
  const fields = result.resource.columns_field_name;

  const dateField = pickColumn(pattern.dateFields, fields);
  const caseField = pickColumn(pattern.caseFields, fields);
  const titleFields = pickColumns(pattern.titleFields, fields);
  const summaryFields = pickColumns(pattern.summaryFields, fields);

  return {
    provider: "socrata",
    url: `https://${result.metadata.domain}`,
    resourceId: result.resource.id,
    recordType: pattern.recordType,
    ...(dateField && { dateField }),
    ...(caseField && { caseField }),
    ...(titleFields.length && { titleFields }),
    ...(summaryFields.length && { summaryFields }),
  };
}

/** Accepts "data.example.gov" or "https://data.example.gov/browse". */
function portalDomain(portalUrl: string): string {
  try {
    return new URL(portalUrl.includes("://") ? portalUrl : `https://${portalUrl}`).hostname;
  } catch {
    return portalUrl;
  }
}

/**
 * Search a Socrata portal's catalog for civic datasets and return scored,
 * column-mapped source proposals. Purely deterministic — no LLM — so
 * ctx.generate is optional and ignored.
 */
export async function searchSocrataCatalog(
  locality: Locality,
  portalUrl: string,
  ctx: Omit<DiscoveryContext, "generate"> & { generate?: DiscoveryContext["generate"] }
): Promise<DiscoveredSource[]> {
  const domain = portalDomain(portalUrl);
  const cityName = localityCityName(locality);

  let offset = 0;
  const pageSize = 50;
  let totalResults = Infinity;
  const candidates: Array<{ result: CatalogResult; score: number; patternIndex: number }> = [];

  while (offset < totalResults && candidates.length < 200) {
    const params = new URLSearchParams({
      domains: domain,
      only: "datasets",
      limit: String(pageSize),
      offset: String(offset),
    });

    let page: CatalogResponse;
    try {
      const res = await ctxFetch(ctx)(`${CATALOG_URL}?${params}`, {
        headers: { "User-Agent": ctxUserAgent(ctx), Accept: "application/json" },
      });
      if (!res.ok) {
        await ctx.logger?.log(
          `[${locality.name}] socrata catalog: HTTP ${res.status} from catalog API for ${domain}`,
          "warn"
        );
        break;
      }
      page = (await res.json()) as CatalogResponse;
    } catch (err) {
      await ctx.logger?.log(`[${locality.name}] socrata catalog: fetch error — ${err}`, "warn");
      break;
    }

    totalResults = page.resultSetSize;
    for (const result of page.results) {
      if (result.resource.type !== "dataset") continue;
      const { score, patternIndex } = scoreResult(result);
      if (score >= MIN_SCORE) candidates.push({ result, score, patternIndex });
    }

    offset += pageSize;
    if (page.results.length < pageSize) break;
    await new Promise((r) => setTimeout(r, 250));
  }

  // Sort by score descending, cap to avoid flooding a locality.
  candidates.sort((a, b) => b.score - a.score);

  const discovered: DiscoveredSource[] = [];
  const seen = new Set<string>();

  for (const { result, score, patternIndex } of candidates) {
    if (discovered.length >= MAX_SOURCES) break;
    const pattern = PATTERNS[patternIndex]!;
    const apiUrl = `https://${result.metadata.domain}/resource/${result.resource.id}.json`;
    if (seen.has(apiUrl)) continue;
    seen.add(apiUrl);

    const meta = buildMeta(result, pattern);
    const mapped = [
      meta.dateField && `date→${meta.dateField}`,
      meta.caseField && `case→${meta.caseField}`,
      meta.titleFields?.length && `title→${meta.titleFields.join("/")}`,
    ].filter(Boolean);

    discovered.push({
      provider: "socrata",
      name: result.resource.name,
      url: apiUrl,
      meta,
      evidence:
        `Socrata catalog on ${domain} lists dataset ${result.resource.id} ` +
        `("${result.resource.name}") matching ${pattern.recordType} with score ${score}` +
        (mapped.length ? `; mapped columns ${mapped.join(", ")}` : ""),
    });
  }

  await ctx.logger?.log(
    `[${locality.name}] socrata catalog (${cityName} @ ${domain}): ${discovered.length} dataset(s) matched of ${candidates.length} candidate(s)`
  );
  return discovered;
}
