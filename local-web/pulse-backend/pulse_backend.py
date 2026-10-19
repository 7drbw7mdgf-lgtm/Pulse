#!/usr/bin/env python3
"""
Pulse Literature Mapping App - Current Desktop Backend Entrypoint
Application services are organized in the pulse_core module hierarchy.
Exports all legacy symbols for 100% backward compatibility.
"""
import sys
import os
from pathlib import Path

if getattr(sys, 'frozen', False):
    ca_bundle = Path(getattr(sys, '_MEIPASS', Path(sys.executable).parent)) / 'certifi' / 'cacert.pem'
    if ca_bundle.is_file(): os.environ.setdefault('SSL_CERT_FILE', str(ca_bundle))
    os.environ.setdefault('PULSE_WEB_ROOT', str(Path(sys.executable).parent))

import pulse_core

# Point sys.modules to pulse_core so patch.object(pulse_backend, ...)
# and pulse_core internal references share identical module state
sys.modules[__name__] = pulse_core

if __name__ == "__main__":
    try:
        if sys.argv[1:] == ['--self-test']:
            import json
            from pulse_core.runtime_diagnostics import run
            print(json.dumps(run()))
        else:
            pulse_core.main()
    except KeyboardInterrupt:
        pulse_core.cleanup_resources()
        sys.exit(0)
