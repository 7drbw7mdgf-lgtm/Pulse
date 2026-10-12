"""DBEF content ranking adapted from the user-supplied dbef_content.py.

The supplied equations, tokenizer and legacy defaults are retained. The calibrated
path fits TF-IDF and similarity anchors on seed/reference texts only. Sparse Python vectors replace numpy/scikit-learn to keep the
packaged backend compatible with its existing Python 3.10+ requirement.
"""
from __future__ import annotations
import collections
import heapq
import itertools
import math
import re
import statistics
import unicodedata
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Sequence, Tuple
Text = Tuple[str, str]

@dataclass
class SeedPaper:
    paper_id: str
    title: str
    abstract: str
    references: List[str]
    original_index: int = 0
    reference_count: Optional[int] = None

@dataclass
class CandidatePaper:
    paper_id: str
    title: str
    abstract: str
    references: List[str]
    recent_velocity: Optional[float]
    reference_count: Optional[int] = None

@dataclass
class ScoredPaper:
    paper: CandidatePaper
    score: float
    overlap: float          # sum of content-adjusted weights of shared refs
    saturation: float       # (n_c + kappa) ** -0.5
    velocity_factor: float  # 1 + beta * ln(1 + max(v, 0))
    content_sim: float      # sigma(c), raw cosine before calibration
    content_factor: float   # lam + (1 - lam) * sigma_hat(c)
    shared_refs: List[str] = field(default_factory=list)

STOP_WORDS = {
    "a", "about", "above", "after", "again", "against", "all", "am", "an", "and",
    "any", "are", "aren't", "as", "at", "be", "because", "been", "before", "being",
    "below", "between", "both", "but", "by", "can't", "cannot", "could", "did", "do",
    "does", "doing", "down", "during", "each", "few", "for", "from", "further", "had",
    "has", "have", "having", "he", "her", "here", "hers", "herself", "him", "himself",
    "his", "how", "i", "if", "in", "into", "is", "it", "its", "itself", "me", "more",
    "most", "my", "myself", "no", "nor", "not", "of", "off", "on", "once", "only",
    "or", "other", "ought", "our", "ours", "ourselves", "out", "over", "own", "same",
    "she", "should", "so", "some", "such", "than", "that", "the", "their", "theirs",
    "them", "themselves", "then", "there", "these", "they", "this", "those", "through",
    "to", "too", "under", "until", "up", "very", "was", "we", "were", "what", "when",
    "where", "which", "while", "who", "whom", "why", "with", "would", "you", "your",
    "yours", "yourself", "yourselves", "study", "results", "using", "based",
    "analysis", "paper", "show", "shows", "shown", "here", "also", "use", "used",
}

_GREEK = str.maketrans({
    "α": "a", "β": "b", "γ": "g", "δ": "d", "ε": "e", "κ": "k",
    "λ": "l", "μ": "u", "ν": "n", "τ": "t", "ω": "w",
})

_TOKEN_RE = re.compile(r"[a-z0-9]+(?:[-/][a-z0-9]+)*")

_SPLIT_RE = re.compile(r"[-/]")

def _light_stem(tok: str) -> str:
    """Strip a plural 's' from alphabetic words ('networks' -> 'network')."""
    if len(tok) > 4 and tok.isalpha() and tok.endswith("s") and not tok.endswith(("ss", "us", "is")):
        return tok[:-1]
    return tok

def bio_tokenise(text: str) -> List[str]:
    """Tokenise while keeping gene, cytokine and cell-line names intact.

    'TLR4', 'IL-8', 'NF-κB' and 'Caco-2' survive as tokens. Hyphenated words
    also emit their alphabetic parts, so 'jejuni-infected' gives
    'jejuni-infected', 'jejuni' and 'infected'.
    """
    text = unicodedata.normalize("NFKD", text.translate(_GREEK).lower())
    text = "".join(ch for ch in text if not unicodedata.combining(ch))
    out: List[str] = []
    for raw in _TOKEN_RE.findall(text):
        if not any(ch.isalpha() for ch in raw):
            continue  # pure numbers
        if "-" in raw or "/" in raw:
            parts = [p for p in _SPLIT_RE.split(raw) if p]
            if all(p in STOP_WORDS for p in parts):
                continue
            out.append(raw)
            out.extend(
                _light_stem(p) for p in parts
                if p.isalpha() and len(p) >= 3 and p not in STOP_WORDS
            )
        elif (len(raw) >= 3 or any(ch.isdigit() for ch in raw)) and raw not in STOP_WORDS:
            out.append(_light_stem(raw))
    return out

def _has_text(t: Text) -> bool:
    return bool((t[0] or "").strip() or (t[1] or "").strip())

def specificity_weight(count: float, n_corpus: float) -> float:
    """ln(1 + N / (C + 1)). N should be the size of the relevant field, not all of science."""
    return math.log1p(n_corpus / (max(float(count), 0.0) + 1.0))


class TfidfEmbedder:
    """The supplied TF-IDF model expressed as sparse normalized dictionaries."""
    def __init__(self, sublinear_tf=True, max_df=.9, check=None):
        self.sublinear_tf, self.max_df, self.check = sublinear_tf, max_df, check
        self._idf = None

    @staticmethod
    def format(text):
        return f'{text[0] or ""} {text[1] or ""}'.strip()

    def fit(self, texts):
        docs = [text for text in texts if _has_text(text)]
        if not docs: raise ValueError('No non-empty texts for DBEF content ranking')
        df = collections.Counter()
        for index, text in enumerate(docs):
            if self.check and index % 32 == 0: self.check()
            df.update(set(bio_tokenise(self.format(text))))
        maximum = (self.max_df if len(docs) >= 10 else 1) * len(docs)
        self._idf = {word: math.log((1+len(docs))/(1+count))+1 for word, count in df.items() if count <= maximum}
        return self

    def encode(self, texts):
        if self._idf is None: raise RuntimeError('Fit the embedder before encoding')
        vectors = []
        for index, text in enumerate(texts):
            if self.check and index % 32 == 0: self.check()
            counts = collections.Counter(bio_tokenise(self.format(text)))
            vector = {word: (1+math.log(count) if self.sublinear_tf else count)*self._idf[word]
                      for word, count in counts.items() if word in self._idf}
            length = math.sqrt(sum(value*value for value in vector.values()))
            vectors.append({word: value/length for word, value in vector.items()} if length else {})
        return vectors


def cosine_matrix(embedder, rows, cols):
    matrix = [[float('nan')]*len(cols) for _ in rows]
    ri, ci = [i for i,t in enumerate(rows) if _has_text(t)], [j for j,t in enumerate(cols) if _has_text(t)]
    if ri and ci:
        row_vectors, col_vectors = embedder.encode([rows[i] for i in ri]), embedder.encode([cols[j] for j in ci])
        for i, row in zip(ri, row_vectors):
            for j, col in zip(ci, col_vectors):
                small, large = (row, col) if len(row) <= len(col) else (col, row)
                matrix[i][j] = max(-1, min(1, sum(value*large.get(word,0) for word,value in small.items())))
    return matrix


def reduce_rows(matrix, agg='max'):
    if agg not in ('max', 'mean'): raise ValueError('DBEF aggregation must be max or mean')
    result = []
    for row in matrix:
        known = [value for value in row if math.isfinite(value)]
        result.append((max(known) if agg == 'max' else sum(known)/len(known)) if known else float('nan'))
    return result


def percentile(values, percentage):
    values = sorted(values)
    position = (len(values)-1)*percentage/100
    left, right = math.floor(position), math.ceil(position)
    return values[left]+(values[right]-values[left])*(position-left)


def calibrate(values, mode='pool', lo_pct=5, hi_pct=95):
    known = [value for value in values if math.isfinite(value)]
    if mode not in ('pool','none'): raise ValueError('DBEF calibration must be pool or none')
    if not known: return [1.0]*len(values)
    lo, hi = percentile(known, lo_pct), percentile(known, hi_pct)
    def scaled(value):
        return max(0,min(1,value)) if mode == 'none' else 1 if hi-lo < 1e-12 else max(0,min(1,(value-lo)/(hi-lo)))
    median = percentile([scaled(value) for value in known],50)
    return [scaled(value) if math.isfinite(value) else median for value in values]


def seed_scale(seeds, weights, kappa=15, lam=.3):
    """Fixed saturation anchor: one median seed reference maps to 0.15."""
    known=[value for value in weights.values() if math.isfinite(value) and value>0]
    lengths=[max(len(set(seed.references)),seed.reference_count or 0) for seed in seeds]
    lengths=[length for length in lengths if length>0]
    w_med=statistics.median(known) if known else 1.
    length=statistics.median(lengths) if lengths else 40
    content=lam+(1-lam)*.5
    s1=w_med/math.sqrt(length+kappa)*content
    return {'S0':s1*(1/.15-1),'s1':s1,'inputs':{'medianSeedReferenceWeight':w_med,
            'typicalSeedReferenceCount':length,'kappa':kappa,'lambda':lam,
            'velocityFactor':1,'midContentFactor':content,'available':bool(known)}}


def saturate_score(score, scale):
    return max(0,score)/(max(0,score)+scale['S0'])


def compute_seed_reference_weights(seeds, ref_texts, citation_counts, embedder, *, n_corpus=1e7,
                                   unknown_count=1, rho=.2, agg='max', calibration='pool'):
    ref_ids = list(dict.fromkeys(r for seed in seeds for r in seed.references))
    matrix = cosine_matrix(embedder, [ref_texts.get(r, ('','')) for r in ref_ids], [(s.title,s.abstract) for s in seeds])
    tau = reduce_rows(matrix, agg)
    adjusted = calibrate(tau, calibration)
    specificity = {r: specificity_weight(citation_counts.get(r,unknown_count),n_corpus) for r in ref_ids}
    weights = {r: specificity[r]*(rho+(1-rho)*value) for r,value in zip(ref_ids,adjusted)}
    return weights, {'ref_ids':ref_ids,'A':matrix,'tau':tau,'tau_hat':adjusted,'specificity':specificity}


def score_and_rank_candidates(candidates, seeds, citation_counts, ref_texts, embedder=None, *, top_k=200,
                              stage1_k=1000, kappa=15, beta=.5, lam=.3, rho=.2, n_corpus=1e7,
                              unknown_count=1, agg='max', calibration='pool', fit_corpus=None, check=None,
                              stable_seed_calibration=False):
    if top_k < 1 or kappa <= 0 or beta < 0 or n_corpus <= 0 or not 0 <= lam <= 1 or not 0 <= rho <= 1:
        raise ValueError('Invalid DBEF parameters')
    # A seed-only corpus intentionally shares topic words. Filtering those as
    # ubiquitous would erase the very topic whose overlap is being assessed.
    embedder = embedder or TfidfEmbedder(max_df=1 if stable_seed_calibration else .9,check=check)
    seed_ids = {s.paper_id for s in seeds}
    seed_texts = [(s.title,s.abstract) for s in seeds]
    seed_refs=sorted({ref for seed in seeds for ref in seed.references})
    corpus = fit_corpus if fit_corpus is not None else ([*seed_texts,*(ref_texts.get(ref,('','')) for ref in seed_refs)]
              if stable_seed_calibration else [*seed_texts,*ref_texts.values(),*((c.title,c.abstract) for c in candidates)])
    if not any(_has_text(t) for t in corpus): corpus = [('neutral','')]
    embedder.fit(corpus)
    weights, ref_diag = compute_seed_reference_weights(seeds,ref_texts,citation_counts,embedder,
        n_corpus=n_corpus,unknown_count=unknown_count,rho=rho,agg=agg,calibration=calibration)
    prefix = [0,*itertools.accumulate(sorted(weights.values(),reverse=True))]
    stage1_k, heap, tie, pruned, eligible = max(stage1_k,top_k), [], itertools.count(), 0, 0
    statuses={'assessed_overlap':[],'assessed_zero':[],'unassessed':[]}
    for index,candidate in enumerate(candidates):
        if check and index % 32 == 0: check()
        if candidate.paper_id in seed_ids: continue
        refs = set(candidate.references)
        length = max(len(refs),candidate.reference_count or 0)
        shared = sorted(refs.intersection(weights))
        status='unassessed' if not weights or not length else 'assessed_overlap' if shared else 'assessed_zero'
        statuses[status].append(candidate.paper_id)
        if not shared:continue
        saturation = 1/math.sqrt(length+kappa)
        velocity = candidate.recent_velocity
        velocity = 0 if velocity is None or not math.isfinite(velocity) else max(0,velocity)
        factor = 1+beta*math.log1p(velocity)
        if len(heap) >= stage1_k and prefix[min(length,len(weights))]*saturation*factor <= heap[0][0]:
            pruned += 1; continue
        eligible += 1
        overlap = sum(weights[r] for r in shared)
        payload = (candidate,overlap,saturation,factor,shared)
        entry = (overlap*saturation*factor,next(tie),payload)
        if len(heap) < stage1_k: heapq.heappush(heap,entry)
        elif entry[0] > heap[0][0]: heapq.heapreplace(heap,entry)
    full = len(heap) >= stage1_k
    cutoff = heap[0][0] if full else 0
    pool = [row[2] for row in sorted(heap,reverse=True)]
    matrix = cosine_matrix(embedder,[(row[0].title,row[0].abstract) for row in pool],seed_texts)
    sigma = reduce_rows(matrix,agg)
    if stable_seed_calibration and calibration=='pool':
        anchors=[value for value in ref_diag['tau'] if math.isfinite(value)]
        lo,hi=(percentile(anchors,5),percentile(anchors,95)) if anchors else (0.,1.)
        # Seed-side anchors, including the vocabulary fit, are independent of
        # the candidate batch. A degenerate anchor uses absolute cosine.
        adjusted=[.5 if not math.isfinite(value) else max(0,min(1,value if hi-lo<1e-12 else (value-lo)/(hi-lo))) for value in sigma]
    else:adjusted = calibrate(sigma,calibration)
    results = []
    for (candidate,overlap,saturation,velocity,shared),sim,content in zip(pool,sigma,adjusted):
        content_factor = lam+(1-lam)*content
        results.append(ScoredPaper(candidate,overlap*saturation*velocity*content_factor,
            overlap,saturation,velocity,sim,content_factor,shared))
    results.sort(key=lambda row:(-row.score,row.paper.paper_id))
    top = results[:top_k]
    exact = (not full or (not pruned and eligible == len(pool))
             or bool(len(top) == top_k and top[-1].score >= cutoff))
    return top, {**ref_diag,'weights':weights,'pool_ids':[row[0].paper_id for row in pool],
        'B':matrix,'sigma':sigma,'sigma_hat':adjusted,'n_pruned':pruned,'stage1_cutoff':cutoff,'exact':exact,
        'network_status_ids':statuses,'scored_rows':results,'scale':seed_scale(seeds,weights,kappa,lam)}
