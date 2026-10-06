#!/usr/bin/env python3
"""
Pulse Literature Mapping App - Backend Entrypoint (v1.3.0)
Refactored into pulse_core module hierarchy (all files <= 400 lines).
Exports all legacy symbols for 100% backward compatibility.
"""
import sys
import urllib.request
import pulse_core
from pulse_core import *

if __name__ == "__main__":
    try:
        pulse_core.main()
    except KeyboardInterrupt:
        pulse_core.cleanup_resources()
        sys.exit(0)

_save_library = pulse_core.storage._save_library
_ollama_embedding = pulse_core.embeddings._ollama_embedding
_gemini_embedding = pulse_core.embeddings._gemini_embedding
