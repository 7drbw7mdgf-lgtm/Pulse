# Resilience to OpenAlex Rate Limits (Pulse 1.9)

## 1. Overview
OpenAlex enforces daily free-tier credit limits that return HTTP 429 errors with multi-hour retry windows. Prior to Pulse 1.9, when OpenAlex became rate-limited or unavailable, citation graph traversal halted or stalled on single unhedged fallbacks.

Section 2 of Pulse 1.9 implements comprehensive resilience:
1. **Extended TTL for Stable Data**: 7-day cache TTL for single-work lookups, citation queries (`cites:`, `cited_by:`), and reference lists, while preserving 15-minute TTL for volatile free-text search queries.
2. **Multi-Source Keyless Citation Fallbacks**: Automatic fallback cascade when OpenAlex enters cooldown or is unavailable:
   - **Europe PMC**: Queries `https://www.ebi.ac.uk/europepmc/webservices/rest/MED/{pmid}/citations` and `/references` after resolving DOIs to PMIDs via batched/cached lookups.
   - **NIH iCite**: Queries `/api/pubs?pmids=` for `cited_by`, `references`, and relative citation ratio (RCR) in batches $\le 1000$.
   - **OpenCitations**: Queries `/citations/doi:` and `/references/doi:`.
   - Adheres to NCBI etiquette ($\le 3$ req/s without key, `tool` and `email` parameters).
   - Provider tags are tracked in `retrievalEvidence` (`'Europe PMC'`, `'iCite'`, `'OpenCitations'`).
3. **Optional OpenAlex API Key & Polite-Pool Email**:
   - `openAlexApiKey` added to `SENSITIVE_SETTING_KEYS` and stored securely.
   - Sent as the `api_key` query parameter, as OpenAlex expects. `api_key` and `mailto` are stripped from disk-cache keys and from the URL stored in `http-cache.sqlite3`, so the key never reaches the cache.
   - `mailto` parameter added for polite-pool access whenever `contactEmail` is configured (with or without a key).
4. **Visible Limit Banner in UI**:
   - When OpenAlex enters cooldown, the discovery workspace displays:
     *"OpenAlex limit reached — citation results may be incomplete until HH:MM (local time). Other sources continue."*
   - Searches continue without stalling.

---

## 2. Validation & Simulated Outage

Tested under `local-web/tests/test_openalex_resilience.py`:
- `test_disk_http_cache_ttl_rules`: Verifies 7-day TTL (604,800 s) for `/works/W...`, `cites:`, `cited_by:`, and 15-minute TTL (900 s) for general search.
- `test_openalex_api_key_redaction_from_cache_keys_and_logs`: Verifies API key is not present in cache keys or logs.
- `test_fetch_json_sends_openalex_api_key_as_query_parameter`: Verifies the key travels as a query parameter and is absent from the cache key and stored URL.
- `test_fetch_json_injects_polite_pool_email_when_no_key`: Verifies `mailto` query parameter injection.
- `test_europepmc_pmid_resolution_and_citations`: Verifies DOI $\to$ PMID resolution and citation retrieval.
- `test_icite_citations_fallback`: Verifies NIH iCite citation and reference retrieval.
- `test_citation_graph_cascade_to_europepmc_when_openalex_in_cooldown`: Simulates OpenAlex HTTP 429; confirms successful retrieval of citation and reference papers via Europe PMC with `provider: "Europe PMC"`.
- `test_citation_graph_cascade_to_icite_when_europepmc_empty`: Simulates OpenAlex cooldown and Europe PMC empty; confirms successful retrieval via NIH iCite with `provider: "iCite"`.
- `test_openalex_cooldown_banner_formatting`: Confirms UI banner formatting with localized retry timestamp.
