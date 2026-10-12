"""Shared discovery limits and partial results from paginated providers."""

DEFAULT_DISCOVERY_LIMIT = 500
MAX_DISCOVERY_LIMIT = 2000


def discovery_limit(value, default=DEFAULT_DISCOVERY_LIMIT):
    try:
        requested = int(value) if value is not None else default
    except (ValueError, TypeError, OverflowError):
        requested = default
    return max(1, min(requested, MAX_DISCOVERY_LIMIT))


class SearchResults(list):
    def __init__(self, *args):
        super().__init__(*args)
        self.warning = ""
        self.notices = []

    def keep_partial(self, error):
        if not self:
            raise error
        self.warning = f"Returned {len(self)} papers; additional results could not be loaded. {error}"
        return self


MAX_CANDIDATE_POOL = 6000


def candidate_limit(display_limit, branches=1):
    """A retrieval budget independent of the final result count."""
    return min(3000, max(300, discovery_limit(display_limit) * 3))
