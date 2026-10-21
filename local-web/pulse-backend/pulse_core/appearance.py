"""Device-local appearance preferences, independent of backend credentials."""
import json
import os
from pathlib import Path
import tempfile

from pulse_core.constants import ClientError
from pulse_core.platform_support import config_directory

THEMES = ('system', 'light', 'dark', 'sepia', 'contrast')


def load_theme(directory=None):
    try:
        value = json.loads((Path(directory or config_directory()) / 'appearance.json').read_text('utf-8')).get('theme')
        return value if value in THEMES else None
    except (OSError, ValueError, AttributeError):
        return None


def save_appearance(payload, directory=None):
    theme = payload.get('theme')
    if theme not in THEMES:
        raise ClientError(400, 'Choose System, Light, Dark, Sepia or High Contrast.')
    root = Path(directory or config_directory())
    root.mkdir(parents=True, exist_ok=True)
    descriptor, name = tempfile.mkstemp(prefix='.appearance-', dir=root)
    try:
        with os.fdopen(descriptor, 'w', encoding='utf-8') as output:
            json.dump({'theme': theme}, output)
            output.flush()
            os.fsync(output.fileno())
        os.replace(name, root / 'appearance.json')
    finally:
        if os.path.exists(name):
            os.unlink(name)
    return {'theme': theme}
