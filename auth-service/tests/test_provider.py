"""Requests the live Mendeley API accepts (checked against api.mendeley.com, October 2026)."""
from pathlib import Path
import sys
import unittest
from unittest.mock import MagicMock, patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import provider
from provider import Failure, validate_path


class ProviderRequestTests(unittest.TestCase):
    def test_requests_carry_a_named_user_agent(self):
        # Cloudflare in front of Mendeley rejects Python's default user agent with HTTP 403 (error 1010).
        response=MagicMock();response.read.return_value=b'{}';response.headers={}
        opener=MagicMock();opener.open.return_value.__enter__.return_value=response
        with patch.object(provider.urllib.request,'build_opener',return_value=opener):provider.call('/documents?view=all&limit=1')
        sent=opener.open.call_args.args[0]
        self.assertTrue(sent.get_header('User-agent','').startswith('Pulse'))
        self.assertEqual(sent.get_header('Accept'),'application/vnd.mendeley-document.1+json')

    def test_next_page_links_with_reverse_are_accepted(self):
        path='/documents?view=all&marker=next&limit=100&reverse=false&order=asc'
        self.assertEqual(validate_path(path),path)
        for bad in ['reverse=maybe','reverse=true&reverse=false']:
            with self.subTest(bad=bad), self.assertRaises(Failure):validate_path('/documents?view=all&limit=100&'+bad)

    def test_profile_uses_the_current_endpoint(self):
        self.assertEqual(validate_path('/profiles/me'),'/profiles/me')
        with self.assertRaises(Failure):validate_path('/profiles/v2/me')


if __name__=='__main__':
    unittest.main()
