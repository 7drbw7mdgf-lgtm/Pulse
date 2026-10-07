"""Types for normalized records; provider payloads remain open JSON dictionaries."""
from __future__ import annotations
from typing import Any, Dict, List, TypedDict, Union

JSONDict = Dict[str, Any]


class Metadata(TypedDict, total=False):
    title: str
    authors: List[str]
    year: str
    date: str
    journal: str
    doi: str
    pmid: str
    abstract: str
    paperKeywords: List[str]
    metadataSource: str
    openAlexId: str
    openAlexUrl: str
    s2PaperId: str
    url: str
    citedByCount: int
    influentialCitationCount: int
    referenceIds: List[str]
    citedByIds: List[str]
    keyFindings: List[str]
    organisms: List[str]
    techniques: List[str]
    discoveryTerms: List[str]
    doiCandidates: List[str]


class Paper(Metadata, total=False):
    id: str
    text: str
    x: float
    y: float
    pinnedPosition: bool
    selected: bool
    tags: List[str]
    sources: List[str]
    reason: str
    score: float
    branch: str
    subType: str
    hop: int
    chaseViaTitle: str
    citedByLoadedCount: int


class MetadataResult(TypedDict, total=False):
    ok: bool
    metadata: Metadata
    doi: str
    pmid: str
    source: str
    found: bool
    name: str
    text: str
    candidates: List[str]
    error: str


class Library(TypedDict, total=False):
    papers: List[Paper]
    format: str
    version: str
    edition: str
    paperLimit: int
    savedAt: str
    reset: bool
    explicitLinks: List[JSONDict]
    _saveSession: str
    _saveRevision: int
