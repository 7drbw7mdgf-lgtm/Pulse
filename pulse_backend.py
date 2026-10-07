#!/usr/bin/env python3
"""Native-launcher compatibility entry point; implementation lives in pulse/."""
from pathlib import Path
import sys
from pulse.context import create_context, set_context, ClientError

ROOT = Path(__file__).resolve().parent
if (ROOT / 'python').exists():
    sys.path.insert(0, str(ROOT / 'python'))
APP_CONTEXT = create_context(ROOT, 'full')
set_context(APP_CONTEXT)

from pulse.ai import (
    _gemini_embedding,
    _ollama_embedding,
    analyze_with_gemma,
    call_ai,
    call_gemini,
    call_gemma,
    chunk_paragraphs,
    clean_string_list,
    cosine,
    detect_sections,
    gemini_embedding,
    gemma_extraction_to_metadata,
    hashed_embedding,
    hybrid_semantic_embedding,
    module_available,
    nearest_chunk_context,
    ollama_embedding,
    ollama_status,
    ollama_tags,
    parse_json_object,
    preview_key,
    require_ai_model,
    require_ollama_model,
    resolve_ai_provider,
    resolve_cloud_model,
    resolve_embedding_model,
    resolve_gemini_api_key,
    resolve_gemma_model,
    resolve_ollama_chat_endpoint,
    resolve_ollama_embeddings_endpoint,
    resolve_ollama_tags_endpoint,
    string_or_existing,
    test_ai_settings,
    test_gemma_settings,
    workflow_capabilities
)
from pulse.discovery import (
    citation_network_triangulation,
    enrich_citations,
    fetch_citation_graph_branch,
    fetch_citation_network_branch,
    fetch_conceptual_search_branch,
    fetch_semantic_search_branch,
    find_missing_seminal_papers,
    iterative_citation_chase,
    merge_and_rank_pipeline_candidates,
    recommend_papers,
    run_discovery_pipeline,
    snowball_papers
)
from pulse.metadata import (
    balance_doi_brackets,
    clamp_float,
    clean_author_name,
    clean_crossref_text,
    clean_doi_candidate,
    clean_extracted_text,
    crossref_date,
    crossref_to_metadata,
    decode_pdf_streams,
    decode_pdf_text_bytes,
    dedupe_strings,
    doi_matches,
    doi_title_match,
    endpoint_with_api,
    first_list_value,
    html_escape,
    join_wrapped_dois,
    keyword_tokens,
    merge_metadata,
    merge_verified_doi_metadata,
    metadata_completeness_score,
    metadata_is_filled,
    normalize_doi,
    normalize_gemma_model,
    normalize_ollama_endpoint,
    normalize_title_key,
    normalized_title_text,
    openalex_to_metadata,
    openalex_work_id,
    prepare_doi_text,
    ranked_doi_candidates,
    re_search_doi,
    readable_text_score,
    reconstruct_openalex_abstract,
    s2_to_metadata,
    same_doi,
    scan_doi_candidates_from_bytes,
    scan_doi_from_bytes,
    short_text,
    time_iso,
    time_seconds,
    time_sleep,
    title_match_tokens,
    title_overlap_score,
    valid_doi_candidate,
    zlib_candidates
)
from pulse.providers import (
    crossref_recommendations,
    dimensions_auth_token,
    dimensions_recommendations,
    dsl_string,
    fetch_json,
    fetch_openalex_work_by_id,
    fetch_s2_json,
    lookup_doi_metadata,
    lookup_pmid_metadata,
    openalex_citing_ids,
    openalex_citing_works,
    openalex_recommendations,
    openalex_work_for_paper,
    post_s2_json,
    post_text_json,
    resolve_dimensions_api_key,
    resolve_semantic_scholar_api_key,
    s2_cache_get,
    s2_cache_set,
    s2_fetch_citations,
    s2_fetch_references,
    s2_paper_id_for_paper,
    s2_paper_identifier,
    s2_paper_search,
    s2_recommendations,
    s2_recommendations_for_search,
    s2_request_headers
)
from pulse.ranking import (
    clean_openalex_search_term,
    crossref_recommendation_item,
    dimensions_recommendation_item,
    merge_recommendations,
    openalex_and_terms,
    openalex_recommendation_item,
    recommendation_query_terms,
    recommendation_rank,
    recommendation_reason,
    recommendation_record,
    steering_match_score,
    steering_penalty,
    steering_terms
)
from pulse.runtime import (
    bundled_ollama_available,
    bundled_ollama_status,
    cleanup_resources,
    ensure_ollama_runtime,
    main,
    ollama_server_responds,
    signal_handler,
    start_ollama_runtime_background,
    start_parent_watchdog
)
from pulse.storage import (
    _save_library,
    load_library,
    load_settings,
    public_settings,
    save_library,
    save_settings,
    write_settings
)
from pulse.uploads import (
    _scan_file_for_metadata_local,
    extract_metadata_with_gemma,
    extract_text_from_upload,
    lookup_metadata_by_title,
    model_paper_excerpt,
    scan_file_for_metadata,
    title_from_text_or_name
)
from pulse.http import PulseHandler, IratxeHandler
from pulse.storage import encrypt_secret, decrypt_secret
from pulse.metadata import safe_decompress_flate


def __getattr__(name):
    # Read compatibility for native integrations; services use the context directly.
    fields = {'CONFIG_DIR': 'config_dir', 'CONFIG_PATH': 'config_path', 'LIBRARY_PATH': 'library_path',
              'API_TOKEN': 'api_token', 'APP_VERSION': 'version', 'BOUND_PORT': 'bound_port', 'MAX_PAPERS': 'max_papers'}
    if name in fields:
        return getattr(APP_CONTEXT, fields[name])
    raise AttributeError(name)


if __name__ == '__main__':
    try:
        main(APP_CONTEXT)
    except KeyboardInterrupt:
        cleanup_resources()
