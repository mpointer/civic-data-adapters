export * from "./types.js";
export { runAdapter, sanitizeCivicDate } from "./registry.js";
export { isAllowedByRobots } from "./robots.js";
export type { RobotsCheckOptions, Rule } from "./robots.js";
export { ingestLegistar, verifyLegistarClient, extractPdfText } from "./adapters/legistar.js";
export { ingestHtmlMinutes } from "./adapters/html-minutes.js";
export { ingestSocrataRecords, ingestSocrataBlotter } from "./adapters/blotter-socrata.js";
export {
  ingestHtmlBlotter,
  parseBlotterHtml,
  parseHtmlTables,
  extractRowsFromTable,
} from "./adapters/blotter-html.js";
export { ingestPdfBlotter, extractIncidents } from "./adapters/blotter-pdf.js";
export {
  ingestCrimewatchBlotter,
  fetchCrimewatchIncidents,
  isCrimewatchUrl,
} from "./adapters/blotter-crimewatch.js";
export type { CrimewatchIncident, CrimewatchFetchOptions } from "./adapters/blotter-crimewatch.js";
export { ingestUSASpending } from "./adapters/usaspending.js";
export { ingestNonprofitExplorer } from "./adapters/nonprofit.js";
export {
  discover,
  discoverBlotter,
  discoverMeetingPortal,
  searchSocrataCatalog,
  parseCandidateJson,
} from "./discovery/index.js";
