import json
import urllib.error
import urllib.parse
import urllib.request
from pulse_core.constants import ClientError
from pulse_performance import request_json

def fetch_json(url):
    request = urllib.request.Request(
        url,
        headers={"User-Agent": "Pulse/1.3 (mailto:pulse@example.org)", "Accept": "application/json"},
        method="GET",
    )
    try:
        return request_json(request, timeout=12)
    except urllib.error.HTTPError as error:
        details = error.read().decode("utf-8", errors="replace")
        raise ClientError(error.code, f"DOI lookup failed: {details[:500]}")
    except Exception as error:
        raise ClientError(502, f"DOI lookup failed: {error}")

def post_text_json(url, text, headers=None, timeout=18, error_label="API"):
    head = {"User-Agent": "Pulse/1.3", "Content-Type": "text/plain"}
    if headers:
        head.update(headers)
    req = urllib.request.Request(url, data=text.encode("utf-8"), headers=head, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as err:
        body = err.read().decode("utf-8", errors="replace")
        raise ClientError(err.code, f"{error_label} request failed: {body[:400]}")
    except Exception as err:
        raise ClientError(502, f"{error_label} connection failed: {err}")

def dimensions_auth_token(api_key):
    payload = {"key": api_key}
    req = urllib.request.Request(
        "https://app.dimensions.ai/api/auth.json",
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=12) as response:
            data = json.loads(response.read().decode("utf-8"))
            return data.get("token") or ""
    except Exception as err:
        raise ClientError(401, f"Dimensions authentication failed: {err}")

def dsl_string(value):
    return json.dumps(str(value or ""))
