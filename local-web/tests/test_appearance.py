"""Durable appearance preferences use their own small, validated file."""
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'pulse-backend'))
from pulse_core import appearance
from pulse_core.constants import ClientError


class AppearancePreferences(unittest.TestCase):
    def test_themes_round_trip_without_changing_credentials(self):
        with tempfile.TemporaryDirectory() as directory:
            settings=Path(directory)/'settings.json';settings.write_text('{"fixture":"unchanged"}')
            for theme in appearance.THEMES:
                appearance.save_appearance({'theme':theme},directory)
                self.assertEqual(appearance.load_theme(directory),theme)
            self.assertEqual(settings.read_text(),'{"fixture":"unchanged"}')
            if os.name!='nt':self.assertEqual((Path(directory)/'appearance.json').stat().st_mode&0o777,0o600)

    def test_invalid_or_corrupted_preferences_do_not_enter_bootstrap_html(self):
        with tempfile.TemporaryDirectory() as directory:
            self.assertIsNone(appearance.load_theme(directory))
            path=Path(directory)/'appearance.json'
            for data in ['invalid',json.dumps({'theme':'</script><script>unsafe</script>'}),'[]','null']:
                path.write_text(data);self.assertIsNone(appearance.load_theme(directory))
            for theme in [None,{},[],12,'unknown']:
                with self.assertRaises(ClientError):appearance.save_appearance({'theme':theme},directory)

    def test_failed_replace_preserves_old_preference_and_cleans_temporary_file(self):
        with tempfile.TemporaryDirectory() as directory:
            appearance.save_appearance({'theme':'sepia'},directory)
            with patch.object(appearance.os,'replace',side_effect=OSError('Synthetic failure')):
                with self.assertRaises(OSError):appearance.save_appearance({'theme':'dark'},directory)
            self.assertEqual(appearance.load_theme(directory),'sepia')
            self.assertEqual([p.name for p in Path(directory).iterdir()],['appearance.json'])


if __name__=='__main__':unittest.main()
