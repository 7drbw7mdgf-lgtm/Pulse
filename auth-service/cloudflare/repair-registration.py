#!/usr/bin/env python3
"""Owner-only repair of the existing Pulse Mendeley application's two secrets.

Python 3.10+, standard library only. Run interactively, without arguments.
No application secret is accepted in arguments, environment variables or files.
Mendeley documents the validation response at:
https://dev.mendeley.com/reference/topics/authorization_auth_code.html
"""

import base64
import getpass
import hashlib
import json
import os
import re
import secrets
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import warnings


SERVICE_URL = "https://pulse-mendeley.7drbw7mdgf.workers.dev"
REDIRECT_URI = SERVICE_URL + "/callback"
TOKEN_URL = "https://api.mendeley.com/oauth/token"
AUTHORIZE_URL = "https://api.mendeley.com/oauth/authorize"
WORKER_NAME = "pulse-mendeley"
DEFAULT_APPLICATION_ID = "26261"
USER_AGENT = "Pulse-registration-repair/1 (Mendeley sign-in)"
MAX_RESPONSE_BYTES = 65536


class RepairError(Exception):
    """A deliberately sanitized error safe to display to the owner."""


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        # Never forward the Basic credential, including to a different HTTPS host.
        return None


def request_json(url, payload, headers=None):
    """POST only to the fixed official provider/shared-service endpoints."""
    if url not in (TOKEN_URL, SERVICE_URL + "/start", SERVICE_URL + "/token"):
        raise RepairError("Refusing an unexpected service address.")
    request_headers = {"Accept": "application/json", "User-Agent": USER_AGENT}
    request_headers.update(headers or {})
    if url == TOKEN_URL:
        data = urllib.parse.urlencode(payload).encode("utf-8")
        request_headers["Content-Type"] = "application/x-www-form-urlencoded"
    else:
        data = json.dumps(payload).encode("utf-8")
        request_headers["Content-Type"] = "application/json"
    request = urllib.request.Request(url, data=data, headers=request_headers, method="POST")
    try:
        response = urllib.request.build_opener(NoRedirect()).open(request, timeout=30)
    except urllib.error.HTTPError as error:
        response = error
    except (OSError, urllib.error.URLError):
        raise RepairError("Could not reach the sign-in servers securely. Check your internet connection and retry.") from None
    try:
        with response:
            status = response.code
            raw = response.read(MAX_RESPONSE_BYTES + 1)
        if len(raw) > MAX_RESPONSE_BYTES:
            raise RepairError("The sign-in server returned an unexpected response.")
        body = json.loads(raw)
        return status, body if isinstance(body, dict) else {}
    except (ValueError, UnicodeError):
        return status, {}
    except OSError:
        raise RepairError("The sign-in server response could not be read. Retry when your connection is stable.") from None


def invalid_access_code(value):
    return isinstance(value, str) and value.strip().lower() == "invalid access code"


def validate_registration(application_id, application_secret, request=request_json):
    credential = base64.b64encode((application_id + ":" + application_secret).encode("utf-8")).decode("ascii")
    status, body = request(TOKEN_URL, {
        "grant_type": "authorization_code",
        "code": "pulse-deliberately-invalid-" + secrets.token_urlsafe(32),
        "redirect_uri": REDIRECT_URI,
    }, {"Authorization": "Basic " + credential})
    if status == 400 and body.get("error") == "invalid_grant" and invalid_access_code(body.get("error_description")):
        return
    if status == 401:
        raise RepairError("Mendeley rejected this application ID or secret (HTTP 401). Nothing was changed in Cloudflare. Copy the current secret from your own Mendeley application and run this helper again.")
    raise RepairError("Mendeley did not confirm the application credentials (HTTP %s). Nothing was changed in Cloudflare. Check that your application uses the exact redirect URL shown above." % status)


class Wrangler:
    def __init__(self, npx, directory):
        self.command = [npx, "--yes", "wrangler@4.20.0"]
        self.directory = directory
        self.account_id = None

    def run(self, arguments, value=None, interactive=False):
        environment = os.environ.copy()
        environment["WRANGLER_SEND_METRICS"] = "false"
        environment["WRANGLER_LOG_SANITIZE"] = "true"
        # main creates this symlink to /dev/null: Wrangler's automatic debug log
        # must never persist request bodies, even if a future error echoes one.
        environment["WRANGLER_LOG_PATH"] = os.path.join(self.directory, "wrangler.log")
        environment["WRANGLER_LOG"] = "log"
        if self.account_id:
            environment["CLOUDFLARE_ACCOUNT_ID"] = self.account_id
        # Secret commands must not inherit verbose debug logging preferences.
        if value is not None:
            environment["WRANGLER_LOG"] = "error"
        try:
            return subprocess.run(
                self.command + arguments, input=value, text=True, cwd=self.directory,
                env=environment, check=False,
                stdout=None if interactive else subprocess.PIPE,
                stderr=None if interactive else subprocess.PIPE,
                timeout=None if interactive else 180,
            )
        except (OSError, subprocess.SubprocessError):
            # Subprocess exception strings/output can include sensitive data.
            raise RepairError("The Cloudflare command could not finish. Check Node.js, internet access and your Cloudflare sign-in, then retry.") from None

    def ensure_existing_worker(self):
        result = self.run(["whoami"])
        if result.returncode != 0 or "You are logged in" not in (result.stdout or ""):
            print("Sign in to the Cloudflare account that owns the existing Pulse service. A browser may open.")
            if self.run(["login"], interactive=True).returncode != 0:
                raise RepairError("Cloudflare sign-in did not complete. Nothing was changed.")
            result = self.run(["whoami"])
            if result.returncode != 0 or "You are logged in" not in (result.stdout or ""):
                raise RepairError("Cloudflare sign-in could not be confirmed. Nothing was changed.")
        # whoami in pinned Wrangler 4.20.0 shows account names/IDs and email,
        # never token values. Show this before collecting the Mendeley secret.
        details = re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]", "", result.stdout or "")
        account_ids = list(dict.fromkeys(re.findall(r"\b[0-9a-f]{32}\b", details)))
        if not account_ids:
            raise RepairError("Cloudflare did not list an account ID. Nothing was changed. Check the service owner's Cloudflare sign-in.")
        print(details.strip())
        print("Choose the account that owns " + SERVICE_URL + ".")
        default_account = account_ids[0] if len(account_ids) == 1 else ""
        prompt = "Cloudflare account ID" + (" [" + default_account + "]" if default_account else "") + ": "
        account_id = input(prompt).strip() or default_account
        if account_id not in account_ids:
            raise RepairError("Choose a Cloudflare account ID listed above. Nothing was changed.")
        self.account_id = account_id
        result = self.run(["secret", "list", "--name", WORKER_NAME])
        try:
            bindings = json.loads(result.stdout or "")
            names = {item.get("name") for item in bindings if isinstance(item, dict)}
        except (ValueError, TypeError):
            names = set()
        if result.returncode != 0 or not {"MENDELEY_CLIENT_ID", "MENDELEY_CLIENT_SECRET", "STATE_KEY"}.issubset(names):
            raise RepairError("The existing Pulse service and its three secret bindings could not be confirmed in this Cloudflare account. Nothing was changed. Sign in to the service owner's account and retry.")

    def put(self, name, value):
        if name not in ("MENDELEY_CLIENT_ID", "MENDELEY_CLIENT_SECRET"):
            raise RepairError("Refusing to change an unexpected service binding.")
        result = self.run(["secret", "put", name, "--name", WORKER_NAME], value=value)
        if result.returncode != 0:
            raise RepairError("Cloudflare could not finish updating %s. The service may be only partly updated; run this helper again with the same verified credentials. Command output was hidden to protect the secret." % name)


def verify_shared_registration(application_id, request=request_json):
    verifier = secrets.token_urlsafe(64)
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode("ascii")).digest()).rstrip(b"=").decode("ascii")
    status, body = request(SERVICE_URL + "/start", {"challenge": challenge, "port": 8765})
    state = body.get("state")
    authorization_url = body.get("authorizationUrl")
    if status != 200 or not isinstance(state, str) or not state or not isinstance(authorization_url, str) or body.get("protocol") != "exchange-1":
        raise RepairError("The shared service could not start a fresh credential check.")
    parsed = urllib.parse.urlsplit(authorization_url)
    query = urllib.parse.parse_qs(parsed.query)
    if (parsed._replace(query="").geturl() != AUTHORIZE_URL or
            query.get("client_id") != [application_id] or query.get("redirect_uri") != [REDIRECT_URI] or
            query.get("state") != [state] or query.get("response_type") != ["code"]):
        raise RepairError("The shared service is not using the expected application and registered redirect URL yet.")
    status, body = request(SERVICE_URL + "/token", {
        "code": "pulse-deliberately-invalid-" + secrets.token_urlsafe(32),
        "state": state, "verifier": verifier,
    })
    if (status == 400 and body.get("providerStatus") == 400 and
            body.get("code") == "mendeley_token_exchange_failed" and
            body.get("stage") == "token_exchange" and invalid_access_code(body.get("error"))):
        return
    if status == 401 or body.get("providerStatus") == 401:
        raise RepairError("The shared service still reports that Mendeley rejected its application credentials.")
    raise RepairError("The shared service did not return the expected invalid-code response. A working connection has not been confirmed.")


def main():
    if len(sys.argv) != 1:
        print("Run this helper without arguments. Enter the application secret only at its hidden prompt.", file=sys.stderr)
        return 1
    if sys.version_info < (3, 10):
        print("Python 3.10 or newer is required.", file=sys.stderr)
        return 1
    if not sys.stdin.isatty():
        print("Open this helper in Terminal. It requires an interactive hidden secret prompt.", file=sys.stderr)
        return 1
    print("Repair the existing Pulse Mendeley sign-in service\n")
    print("Only the owner of both the Mendeley application and this Cloudflare Worker should continue.")
    print("Have the current application secret ready from https://dev.mendeley.com/myapps.html.")
    print("You need Python 3.10+, Node.js/npm (npx), internet access and the Cloudflare owner's sign-in.")
    print("The registered redirect URL must be exactly:\n  " + REDIRECT_URI)
    print("This checks the credentials with Mendeley first, then replaces only MENDELEY_CLIENT_ID and")
    print("MENDELEY_CLIENT_SECRET on the existing Worker pulse-mendeley. STATE_KEY stays as it is.")
    print("Your secret is hidden and sent only to Mendeley for validation and to Cloudflare through stdin.")
    print("This helper does not obtain access to a user's library.\n")
    try:
        if input("Type REPAIR to confirm you own this existing service and want these two settings updated: ").strip() != "REPAIR":
            print("Cancelled. Nothing was changed.")
            return 0
        npx = shutil.which("npx")
        if not npx:
            raise RepairError("Node.js/npm (npx) is required. Install it and run this helper again. Nothing was changed.")
        with tempfile.TemporaryDirectory(prefix="pulse-mendeley-repair-") as directory:
            os.symlink(os.devnull, os.path.join(directory, "wrangler.log"))
            wrangler = Wrangler(npx, directory)
            print("Checking access to the existing Cloudflare Worker…")
            wrangler.ensure_existing_worker()
            application_id = input("Mendeley application ID [26261]: ").strip() or DEFAULT_APPLICATION_ID
            if not re.fullmatch(r"[0-9]{1,20}", application_id):
                raise RepairError("The application ID must be the number shown in your Mendeley application settings. Nothing was changed.")
            with warnings.catch_warnings():
                warnings.simplefilter("error", getpass.GetPassWarning)
                application_secret = getpass.getpass("Current Mendeley application secret (hidden): ")
            if not application_secret or any(ord(character) < 32 or ord(character) == 127 for character in application_secret):
                raise RepairError("A nonempty application secret without control characters is required. Nothing was changed.")
            print("Checking these application credentials directly with Mendeley…")
            validate_registration(application_id, application_secret)
            print("Mendeley accepted application authentication. Updating the two existing Cloudflare settings…")
            wrangler.put("MENDELEY_CLIENT_ID", application_id)
            wrangler.put("MENDELEY_CLIENT_SECRET", application_secret)
            application_secret = None
            print("Checking the public service with a fresh synthetic sign-in request…")
            last_error = None
            for attempt in range(4):
                try:
                    verify_shared_registration(application_id)
                    print("\nVerified: the shared Pulse service now authenticates successfully with Mendeley.")
                    print("Return to Pulse, choose Use Pulse sign-in if shown, and connect Mendeley again.")
                    print("A real browser sign-in and library sync still need to complete in Pulse.")
                    return 0
                except RepairError as error:
                    last_error = error
                    if attempt < 3:
                        time.sleep(3)
            raise RepairError("The two Cloudflare updates completed, but the public service check did not pass: " + str(last_error) + " Retry this helper or check the service owner's Cloudflare account.")
    except (EOFError, KeyboardInterrupt):
        print("\nStopped. If an update had already started, rerun this helper to finish both settings.", file=sys.stderr)
        return 1
    except getpass.GetPassWarning:
        print("A hidden secret prompt is unavailable. Run this helper directly in Terminal. Nothing was changed.", file=sys.stderr)
        return 1
    except RepairError as error:
        print("\n" + str(error), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
