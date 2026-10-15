"""Offline regression tests: no provider requests or Cloudflare commands run."""

import base64
import contextlib
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import unittest
import urllib.error
import urllib.parse
import urllib.request
from unittest import mock


SOURCE = Path(__file__).resolve().parents[1] / "repair-registration.py"
SPEC = importlib.util.spec_from_file_location("repair_registration", SOURCE)
repair = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(repair)
TEST_SECRET = "test-only-secret-DO-NOT-DISCLOSE"
TEST_ACCOUNT_ID = "123456789abcdef0123456789abcdef0"
SIGNED_IN = "You are logged in with an OAuth Token\nAccount Name | Account ID\nPulse service owner | " + TEST_ACCOUNT_ID


def completed(returncode=0, stdout="", stderr=""):
    return subprocess.CompletedProcess([], returncode, stdout, stderr)


def service_start(application_id="26261"):
    state = "synthetic-state"
    return 200, {
        "state": state, "protocol": "exchange-1",
        "authorizationUrl": repair.AUTHORIZE_URL + "?" + urllib.parse.urlencode({
            "client_id": application_id, "redirect_uri": repair.REDIRECT_URI,
            "response_type": "code", "scope": "all", "state": state,
        }),
    }


def service_invalid_code():
    return 400, {"error": "Invalid access code", "providerStatus": 400,
                 "code": "mendeley_token_exchange_failed", "stage": "token_exchange"}


class RegistrationTests(unittest.TestCase):
    def test_direct_check_uses_basic_auth_and_registered_redirect(self):
        request = mock.Mock(return_value=(400, {
            "error": "invalid_grant", "error_description": "Invalid access code"}))
        repair.validate_registration("26261", TEST_SECRET, request)
        url, payload, headers = request.call_args.args
        self.assertEqual(url, repair.TOKEN_URL)
        self.assertEqual(payload["grant_type"], "authorization_code")
        self.assertEqual(payload["redirect_uri"], repair.REDIRECT_URI)
        self.assertTrue(payload["code"].startswith("pulse-deliberately-invalid-"))
        self.assertEqual(headers["Authorization"], "Basic " + base64.b64encode(("26261:" + TEST_SECRET).encode()).decode())
        self.assertNotIn(TEST_SECRET, json.dumps(payload))

    def test_only_documented_invalid_access_code_is_accepted(self):
        for status, body in (
            (401, {"error": "Credentials required", "detail": TEST_SECRET}),
            (400, {"error": "invalid_request", "error_description": "Invalid access code"}),
            (400, {"error": "invalid_grant", "error_description": "Wrong redirect"}),
            (200, {"access_token": TEST_SECRET}),
            (302, {}), (403, {}), (500, {}),
        ):
            with self.subTest(status=status, body=body):
                with self.assertRaises(repair.RepairError) as caught:
                    repair.validate_registration("26261", TEST_SECRET, mock.Mock(return_value=(status, body)))
                self.assertNotIn(TEST_SECRET, str(caught.exception))
                self.assertIn("Nothing was changed", str(caught.exception))

    def test_transport_sets_honest_user_agent_and_blocks_redirects(self):
        response = mock.MagicMock()
        response.code = 400
        response.read.return_value = b'{"error":"invalid_grant","error_description":"Invalid access code"}'
        opener = mock.Mock()
        opener.open.return_value = response
        with mock.patch.object(repair.urllib.request, "build_opener", return_value=opener) as build:
            repair.validate_registration("26261", TEST_SECRET)
        handler = build.call_args.args[0]
        self.assertIsInstance(handler, repair.NoRedirect)
        self.assertIsNone(handler.redirect_request(None, None, 302, "", {}, "https://other.example/token"))
        request = opener.open.call_args.args[0]
        self.assertEqual(request.get_header("User-agent"), repair.USER_AGENT)
        self.assertEqual(request.get_header("Content-type"), "application/x-www-form-urlencoded")
        self.assertEqual(request.get_method(), "POST")

    def test_transport_does_not_expose_network_exception(self):
        with mock.patch.object(repair.urllib.request, "build_opener") as build:
            build.return_value.open.side_effect = urllib.error.URLError(TEST_SECRET)
            with self.assertRaises(repair.RepairError) as caught:
                repair.request_json(repair.TOKEN_URL, {})
        self.assertNotIn(TEST_SECRET, str(caught.exception))

    def test_transport_rejects_any_other_endpoint_before_request(self):
        with mock.patch.object(repair.urllib.request, "build_opener") as build:
            with self.assertRaises(repair.RepairError):
                repair.request_json("https://other.example/token", {}, {"Authorization": TEST_SECRET})
        build.assert_not_called()


class WranglerTests(unittest.TestCase):
    def setUp(self):
        self.wrangler = repair.Wrangler("/test/npx", "/test/temporary-directory")

    def test_secret_is_stdin_only_and_named_existing_worker(self):
        with mock.patch.object(repair.subprocess, "run", return_value=completed()) as run:
            self.wrangler.put("MENDELEY_CLIENT_SECRET", TEST_SECRET)
        args, kwargs = run.call_args
        self.assertEqual(args[0], ["/test/npx", "--yes", "wrangler@4.20.0", "secret", "put", "MENDELEY_CLIENT_SECRET", "--name", "pulse-mendeley"])
        self.assertEqual(kwargs["input"], TEST_SECRET)
        self.assertNotIn(TEST_SECRET, repr(args))
        self.assertNotIn(TEST_SECRET, repr(kwargs["env"]))
        self.assertEqual(kwargs["env"]["WRANGLER_LOG"], "error")
        self.assertEqual(kwargs["env"]["WRANGLER_LOG_SANITIZE"], "true")
        self.assertEqual(kwargs["env"]["WRANGLER_LOG_PATH"], "/test/temporary-directory/wrangler.log")
        self.assertEqual(kwargs["stdout"], subprocess.PIPE)
        self.assertEqual(kwargs["stderr"], subprocess.PIPE)

    def test_cloudflare_error_output_is_never_repeated(self):
        with mock.patch.object(repair.subprocess, "run", return_value=completed(1, TEST_SECRET, TEST_SECRET)):
            with self.assertRaises(repair.RepairError) as caught:
                self.wrangler.put("MENDELEY_CLIENT_SECRET", TEST_SECRET)
        self.assertNotIn(TEST_SECRET, str(caught.exception))
        self.assertIn("partly updated", str(caught.exception))

    def test_signed_out_whoami_exit_zero_still_requires_interactive_login(self):
        bindings = json.dumps([{"name": value} for value in ("MENDELEY_CLIENT_ID", "MENDELEY_CLIENT_SECRET", "STATE_KEY")])
        with mock.patch.object(self.wrangler, "run", side_effect=[
            completed(0, "You are not authenticated"), completed(),
            completed(0, SIGNED_IN), completed(0, bindings),
        ]) as run, mock.patch("builtins.input", return_value=""), contextlib.redirect_stdout(io.StringIO()):
            self.wrangler.ensure_existing_worker()
        self.assertEqual(self.wrangler.account_id, TEST_ACCOUNT_ID)
        self.assertEqual(run.call_args_list[1], mock.call(["login"], interactive=True))
        self.assertEqual(run.call_args_list[-1], mock.call(["secret", "list", "--name", "pulse-mendeley"]))

    def test_unavailable_or_different_worker_prevents_writes(self):
        with mock.patch.object(self.wrangler, "run", side_effect=[
            completed(0, SIGNED_IN), completed(0, '[{"name":"OTHER_SECRET"}]'),
        ]) as run, mock.patch("builtins.input", return_value=""), contextlib.redirect_stdout(io.StringIO()):
            with self.assertRaises(repair.RepairError):
                self.wrangler.ensure_existing_worker()
        self.assertFalse(any("put" in call.args[0] for call in run.call_args_list))

    def test_owner_chosen_account_is_pinned_for_all_subsequent_commands(self):
        self.wrangler.account_id = TEST_ACCOUNT_ID
        with mock.patch.object(repair.subprocess, "run", return_value=completed()) as run:
            self.wrangler.put("MENDELEY_CLIENT_ID", "26261")
        self.assertEqual(run.call_args.kwargs["env"]["CLOUDFLARE_ACCOUNT_ID"], TEST_ACCOUNT_ID)

    def test_an_unlisted_account_is_refused_before_worker_access(self):
        with mock.patch.object(self.wrangler, "run", return_value=completed(0, SIGNED_IN)) as run, \
                mock.patch("builtins.input", return_value="ffffffffffffffffffffffffffffffff"), \
                contextlib.redirect_stdout(io.StringIO()):
            with self.assertRaises(repair.RepairError):
                self.wrangler.ensure_existing_worker()
        run.assert_called_once_with(["whoami"])

    def test_state_key_cannot_be_overwritten(self):
        with mock.patch.object(self.wrangler, "run") as run:
            with self.assertRaises(repair.RepairError):
                self.wrangler.put("STATE_KEY", TEST_SECRET)
        run.assert_not_called()


class PublicServiceTests(unittest.TestCase):
    def test_fresh_start_and_matching_s256_verifier_reach_provider(self):
        request = mock.Mock(side_effect=[service_start(), service_invalid_code()])
        repair.verify_shared_registration("26261", request)
        first_url, first_payload = request.call_args_list[0].args
        second_url, second_payload = request.call_args_list[1].args
        self.assertEqual(first_url, repair.SERVICE_URL + "/start")
        self.assertEqual(second_url, repair.SERVICE_URL + "/token")
        challenge = base64.urlsafe_b64encode(hashlib.sha256(second_payload["verifier"].encode()).digest()).rstrip(b"=").decode()
        self.assertEqual(first_payload["challenge"], challenge)
        self.assertEqual(second_payload["state"], "synthetic-state")
        self.assertTrue(second_payload["code"].startswith("pulse-deliberately-invalid-"))
        self.assertTrue(43 <= len(second_payload["verifier"]) <= 128)

    def test_stale_application_or_redirect_prevents_token_check(self):
        for reply in (service_start("99999"), (200, {**service_start()[1], "authorizationUrl": "https://other.example/?state=synthetic-state"})):
            request = mock.Mock(return_value=reply)
            with self.assertRaises(repair.RepairError):
                repair.verify_shared_registration("26261", request)
            self.assertEqual(request.call_count, 1)

    def test_authentication_or_local_validation_error_is_not_success(self):
        for result in ((401, {"error": "Credentials required"}),
                       (400, {"error": "Invalid access code"}),
                       (400, {"error": "Bad verifier", "providerStatus": 400}),
                       (200, {"access_token": TEST_SECRET})):
            with self.subTest(result=result):
                request = mock.Mock(side_effect=[service_start(), result])
                with self.assertRaises(repair.RepairError) as caught:
                    repair.verify_shared_registration("26261", request)
                self.assertNotIn(TEST_SECRET, str(caught.exception))


class MainTests(unittest.TestCase):
    def run_main(self, validation_error=None, second_write_error=None, verify_error=None):
        output = io.StringIO()
        events = []
        def validate(*args):
            events.append("validate")
            if validation_error:
                raise repair.RepairError(validation_error)
        def put(name, value):
            events.append(name)
            if name == "MENDELEY_CLIENT_SECRET" and second_write_error:
                raise repair.RepairError(second_write_error)
        with mock.patch.object(repair.sys, "argv", [str(SOURCE)]), \
                mock.patch.object(repair.sys.stdin, "isatty", return_value=True), \
                mock.patch("builtins.input", side_effect=["REPAIR", ""]), \
                mock.patch.object(repair.shutil, "which", return_value="/test/npx"), \
                mock.patch.object(repair.getpass, "getpass", return_value=TEST_SECRET), \
                mock.patch.object(repair.Wrangler, "ensure_existing_worker"), \
                mock.patch.object(repair.Wrangler, "put", side_effect=put) as write, \
                mock.patch.object(repair, "validate_registration", side_effect=validate), \
                mock.patch.object(repair, "verify_shared_registration", side_effect=verify_error) as verify, \
                mock.patch.object(repair.time, "sleep"), \
                contextlib.redirect_stdout(output), contextlib.redirect_stderr(output):
            result = repair.main()
        self.assertNotIn(TEST_SECRET, output.getvalue())
        return result, events, write, verify, output.getvalue()

    def test_failed_validation_performs_zero_secret_writes(self):
        result, events, write, verify, output = self.run_main(validation_error="HTTP 401. Nothing was changed.")
        self.assertEqual(result, 1)
        self.assertEqual(events, ["validate"])
        write.assert_not_called()
        verify.assert_not_called()
        self.assertNotIn("Verified:", output)

    def test_success_updates_only_two_settings_after_validation(self):
        result, events, write, verify, output = self.run_main()
        self.assertEqual(result, 0)
        self.assertEqual(events, ["validate", "MENDELEY_CLIENT_ID", "MENDELEY_CLIENT_SECRET"])
        self.assertEqual(write.call_args_list, [mock.call("MENDELEY_CLIENT_ID", "26261"), mock.call("MENDELEY_CLIENT_SECRET", TEST_SECRET)])
        verify.assert_called_once_with("26261")
        self.assertIn("Verified:", output)

    def test_partial_write_or_failed_public_check_is_not_success(self):
        for options in ({"second_write_error": "partly updated; rerun"}, {"verify_error": repair.RepairError("Credentials required")}):
            result, events, write, verify, output = self.run_main(**options)
            self.assertEqual(result, 1)
            self.assertNotIn("Verified:", output)

    def test_noninteractive_or_argument_secret_is_refused_without_prompt(self):
        for arguments, terminal in (([str(SOURCE)], False), ([str(SOURCE), TEST_SECRET], True)):
            with mock.patch.object(repair.sys, "argv", arguments), \
                    mock.patch.object(repair.sys.stdin, "isatty", return_value=terminal), \
                    mock.patch.object(repair.getpass, "getpass") as prompt, \
                    contextlib.redirect_stderr(io.StringIO()) as output:
                self.assertEqual(repair.main(), 1)
            prompt.assert_not_called()
            self.assertNotIn(TEST_SECRET, output.getvalue())


if __name__ == "__main__":
    unittest.main()
