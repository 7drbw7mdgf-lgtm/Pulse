"""Compatibility import for performance helpers, now scoped to AppContext."""
import sys
from pulse import performance
sys.modules[__name__] = performance
