# Pulse local parser and metadata lookup

The local backend now resolves paper records through DOI lookup first. If a DOI is absent, invalid, or resolves to a different title, it searches the recovered bibliographic metadata.

PDF extraction uses PyMuPDF to read document text, metadata, XMP identifiers, and embedded links. Image-only PDFs with no readable text still need OCR or manually supplied metadata. Bibliography DOIs are excluded from primary-article extraction.

Fallback queries use Crossref's bibliographic search, with OpenAlex as another provider when needed. Matching checks title, authors, year, journal, volume, issue, pages, ISSN, abstract, and keywords when available. Ambiguous or weak matches keep the original extracted details. Service errors also preserve imported metadata.

The frontend supports nested and inline BibTeX fields, multiple RIS authors, wrapped fields, DOI URLs in imported records, and encoded or wrapped DOI strings. The inspector shows the DOI and lookup outcome and has a Look up details button for existing records.

Verification: 15 backend regression checks; frontend parsing checks; live encoded-DOI, metadata-only, compressed-PDF, and pasted-citation checks. Tests used public example records and a separate test library.

To run a copy, install ../requirements.txt with your Python environment, set PULSE_WEB_ROOT to the sibling pulse-frontend folder, and run pulse_backend.py. PULSE_PORT defaults to 8000. PULSE_CONFIG_DIR can point to an isolated library; by default Pulse uses its existing macOS library and settings.

API references:
- https://github.com/Crossref/rest-api-doc
- https://github.com/CrossRef/rest-api-doc/blob/master/api_tips.md
- https://github.com/ourresearch/openalex-docs/blob/main/api-entities/works/search-works.md
