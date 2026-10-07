#!/usr/bin/env python3
"""
Pulse Literature Mapping App - Backend Entrypoint (v1.3.0)
Refactored into pulse_core module hierarchy (all files <= 400 lines).
Exports all legacy symbols for 100% backward compatibility.
"""
import sys
import pulse_core

# Point sys.modules to pulse_core so patch.object(pulse_backend, ...)
# and pulse_core internal references share identical module state
sys.modules[__name__] = pulse_core

if __name__ == "__main__":
    try:
        pulse_core.main()
    except KeyboardInterrupt:
        pulse_core.cleanup_resources()
        sys.exit(0)
