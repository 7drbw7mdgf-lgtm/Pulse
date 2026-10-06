#!/usr/bin/env python3
"""Backward-compatibility bridge for Pulse launcher binary and tests."""
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

import pulse_backend
from pulse_backend import *  # noqa: F401, F403

# Also point sys.modules to pulse_backend if imported normally
sys.modules[__name__] = pulse_backend

if __name__ == "__main__":
    pulse_backend.main()
