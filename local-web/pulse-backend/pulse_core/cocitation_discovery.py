"""Separate, bounded co-citation retrieval: works cited alongside a seed."""
import collections
import time
import urllib.parse
import pulse_core as core
from .dbef_discovery import work_id,references
from .metadata_utils import openalex_to_metadata
from .search_limits import SearchResults,discovery_limit
from pulse_performance import REQUEST_CONTEXT,DiscoveryCancelled,DiscoveryBudgetExceeded,check_cancelled,publish_partial


def fetch_cocitation_branch(seed_papers,api_key=None,limit=500,seed_works=None):
    result=SearchResults();votes=collections.Counter();paths=collections.defaultdict(set);seed_ids=set();warnings=[];seen_pairs=set();metadata={}
    prior=getattr(REQUEST_CONTEXT,'deadline',None)
    REQUEST_CONTEXT.deadline=min(prior,time.monotonic()+8) if prior else time.monotonic()+8
    def emit():
        ids=sorted(set(votes)-seed_ids,key=lambda ident:(-votes[ident],ident))[:discovery_limit(limit)]
        unknown=[ident for ident in ids if ident not in metadata]
        for start in range(0,len(unknown),100):
            check_cancelled()
            works=core.fetch_openalex_works_batch(unknown[start:start+100])
            if getattr(works,'warning',''): warnings.append(works.warning)
            metadata.update({work_id(work.get('id')):work for work in works})
            update_result(ids)
        update_result(ids)

    def update_result(ids):
        rows=[]
        for ident in ids:
            if ident not in metadata:continue
            paper=openalex_to_metadata(metadata[ident]);count=votes[ident]
            paper.update(branch='citationCoCitation',subType='Co-citation',coCitationCount=count,
                coCitationSimilarity=count/(count+4),reason=f'Co-cited with your seed by {count} indexed citing papers.',
                retrievalEvidence=[{'channel':'citationCoCitation','provider':'OpenAlex','rank':len(rows)+1,
                    'subType':'Co-citation','seedIndices':sorted(paths[ident])}])
            rows.append(paper)
        result[:]=rows;publish_partial(result)
    try:
        for index,paper in enumerate(seed_papers[:24]):
            check_cancelled()
            try:
                seed=seed_works[index] if seed_works is not None and index < len(seed_works) else core.openalex_work_for_paper(paper)
                ident=work_id((seed or {}).get('id'))
                if not ident:continue
                seed_ids.add(ident)
                from .discovery import citation_neighborhood_limit
                for work in core.openalex_citing_works(ident,limit=citation_neighborhood_limit(limit,len(seed_papers))):
                    citer=work_id(work.get('id'))
                    if not citer or ident not in references(work):continue
                    for ref in set(references(work))-{ident}:
                        if (ref,citer) not in seen_pairs:votes[ref]+=1;seen_pairs.add((ref,citer))
                        paths[ref].add(index)
                # Resolve and publish each seed's accumulated evidence before
                # continuing, so later seed budgets cannot discard early results.
                emit()
            except (DiscoveryCancelled,DiscoveryBudgetExceeded):raise
            except Exception as error:warnings.append(str(error))
    except DiscoveryBudgetExceeded:
        result.notices.append({'code':'cocitation-limit','message':'Co-citation reached its time limit; collected results are retained.'})
    finally:REQUEST_CONTEXT.deadline=prior
    result.warning=' · '.join(dict.fromkeys(warnings))
    return result
