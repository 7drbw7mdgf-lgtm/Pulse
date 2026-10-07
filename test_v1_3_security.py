#!/usr/bin/env python3
"""
Test suite verifying security remediations for Pulse v1.3:
1. Session security & Origin / Referer / CSP / token isolation.
2. Credential encryption at rest and header-based API key dispatch.
3. PDF parser decompression limits (Zip bomb protection).
4. Performance features & version verification.
"""

import sys
import os
import json
import zlib
import tempfile
import urllib.request
import urllib.parse
from pathlib import Path

# Add repo root to sys.path
sys.path.insert(0, str(Path(__file__).resolve().parent))

os.environ.setdefault('PULSE_CONFIG_DIR', tempfile.mkdtemp(prefix='pulse-security-test-'))
import pulse_backend

def test_version():
    print("[*] Testing version bump to 1.3.1...")
    assert pulse_backend.APP_VERSION == "1.3.1", f"Expected 1.3.1, got {pulse_backend.APP_VERSION}"
    package_json = json.loads((Path(__file__).resolve().parent / "package.json").read_text("utf-8"))
    assert package_json.get("version") == "1.3.1", f"package.json version is {package_json.get('version')}"
    print("    [+] Version 1.3.1 verified.")

def test_credential_encryption():
    print("[*] Testing credential encryption at rest...")
    plain_key = "AIzaSyTestSecretKeyForGemini12345"
    encrypted = pulse_backend.encrypt_secret(plain_key)
    assert encrypted.startswith("enc:v1:"), f"Expected enc:v1: prefix, got {encrypted}"
    assert plain_key not in encrypted, "Plaintext key leaked in encrypted string!"
    
    decrypted = pulse_backend.decrypt_secret(encrypted)
    assert decrypted == plain_key, f"Decryption mismatch: {decrypted} != {plain_key}"
    
    # Test settings persistence encryption
    test_settings = {
        "aiProvider": "cloud",
        "apiKey": plain_key,
        "dimensionsApiKey": "dim_secret_key_999",
        "semanticScholarApiKey": "s2_secret_key_888"
    }
    pulse_backend.write_settings(test_settings)
    raw_saved = json.loads(pulse_backend.CONFIG_PATH.read_text("utf-8"))
    assert raw_saved["apiKey"].startswith("enc:v1:"), "apiKey stored in plaintext on disk!"
    assert raw_saved["dimensionsApiKey"].startswith("enc:v1:"), "dimensionsApiKey stored in plaintext on disk!"
    assert plain_key not in json.dumps(raw_saved), "Raw plain key found in saved settings.json file!"
    
    # Test transparent in-memory loading
    loaded = pulse_backend.load_settings()
    assert loaded["apiKey"] == plain_key, "Failed to transparently decrypt apiKey in memory"
    assert loaded["dimensionsApiKey"] == "dim_secret_key_999", "Failed to transparently decrypt dimensionsApiKey"
    print("    [+] Credential encryption and transparent loading verified.")

def test_gemini_url_and_headers():
    print("[*] Testing Gemini API key header-based transmission...")
    import inspect
    src = inspect.getsource(pulse_backend.call_gemini)
    assert "?key=" not in src, "Found query parameter ?key= in call_gemini!"
    assert '"x-goog-api-key": api_key' in src, "Missing x-goog-api-key header in call_gemini!"
    
    src_emb = inspect.getsource(pulse_backend._gemini_embedding if hasattr(pulse_backend, '_gemini_embedding') else pulse_backend.gemini_embedding)
    assert "?key=" not in src_emb, "Found query parameter ?key= in gemini_embedding!"
    assert '"x-goog-api-key": api_key' in src_emb, "Missing x-goog-api-key header in gemini_embedding!"
    print("    [+] Header-based API key transmission verified.")

def test_pdf_decompression_bomb_protection():
    print("[*] Testing PDF flate decompression bomb mitigation...")
    # Generate a synthetic zip bomb: 50MB of repeated bytes compressed into a few KB
    huge_data = b"A" * (25 * 1024 * 1024) # 25 MB
    bomb_flate = zlib.compress(huge_data)
    
    # Safe decompressor should cap output at max_bytes (2 MB default) without crashing
    decompressed = pulse_backend.safe_decompress_flate(bomb_flate, max_bytes=2 * 1024 * 1024)
    assert decompressed is not None, "Decompression failed completely"
    assert len(decompressed) <= 2 * 1024 * 1024, f"Decompressed size exceeded cap: {len(decompressed)}"
    
    # Test decode_pdf_streams with a stream containing compressed data
    fake_pdf = b"<< /Filter /FlateDecode >> stream\r\n" + bomb_flate + b"\r\nendstream"
    streams = pulse_backend.decode_pdf_streams(fake_pdf)
    total_len = sum(len(s) for s in streams)
    assert total_len <= 8 * 1024 * 1024, f"Total stream length exceeded limit: {total_len}"
    print("    [+] PDF flate decompression bomb protection verified.")

def test_http_server_security():
    print("[*] Testing HTTP server security & session protections...")
    import threading
    from pulse.http import PulseServer
    
    # Reset bootstrap state
    pulse_backend.APP_CONTEXT.bootstrap_consumed = False
    test_port = 0
    server = PulseServer(("127.0.0.1", test_port), pulse_backend.APP_CONTEXT)
    test_port = server.server_address[1]
    server_thread = threading.Thread(target=server.serve_forever, daemon=True)
    server_thread.start()
    
    base_url = f"http://127.0.0.1:{test_port}"
    token = pulse_backend.API_TOKEN
    
    # 1. Test CSP and security headers on GET /
    req = urllib.request.Request(f"{base_url}/")
    with urllib.request.urlopen(req) as resp:
        headers = dict(resp.headers)
        assert "Content-Security-Policy" in headers, "Missing Content-Security-Policy header!"
        assert "X-Frame-Options" in headers and headers["X-Frame-Options"] == "DENY", "Missing X-Frame-Options: DENY"
        assert "X-Content-Type-Options" in headers and headers["X-Content-Type-Options"] == "nosniff", "Missing X-Content-Type-Options"
        # First load consumed bootstrap
        body = resp.read().decode("utf-8")
        assert token in body, "Initial bootstrap did not receive token"
    
    # 2. Subsequent unauthenticated request to /index.html must NOT contain token
    req_unauth = urllib.request.Request(f"{base_url}/index.html")
    with urllib.request.urlopen(req_unauth) as resp2:
        body2 = resp2.read().decode("utf-8")
        assert f"window.__PULSE_API_TOKEN__ = \"{token}\"" not in body2, "Unauthenticated request received session token!"
        assert "__PULSE_API_TOKEN__" not in body2, "Token script present in unauthenticated request!"
    
    # 3. Authenticated request using cookie gets session
    req_auth_cookie = urllib.request.Request(f"{base_url}/index.html", headers={"Cookie": f"pulse_session={token}"})
    with urllib.request.urlopen(req_auth_cookie) as resp3:
        body3 = resp3.read().decode("utf-8")
        assert token in body3, "Authenticated cookie request should receive session token"

    # 4. Block untrusted Origin
    try:
        req_bad_origin = urllib.request.Request(f"{base_url}/api/health", headers={"Origin": "https://evil-attacker.com"})
        urllib.request.urlopen(req_bad_origin)
        assert False, "Failed to block external Origin!"
    except urllib.error.HTTPError as e:
        assert e.code == 403, f"Expected 403 for bad origin, got {e.code}"

    # 5. Block Sec-Fetch-Site: cross-site
    try:
        req_cross_site = urllib.request.Request(f"{base_url}/api/health", headers={"Sec-Fetch-Site": "cross-site"})
        urllib.request.urlopen(req_cross_site)
        assert False, "Failed to block Sec-Fetch-Site: cross-site!"
    except urllib.error.HTTPError as e:
        assert e.code == 403, f"Expected 403 for cross-site fetch, got {e.code}"

    # 6. Unauthenticated API request blocked
    try:
        req_no_auth = urllib.request.Request(f"{base_url}/api/settings")
        urllib.request.urlopen(req_no_auth)
        assert False, "Failed to block unauthenticated /api/settings!"
    except urllib.error.HTTPError as e:
        assert e.code == 403, f"Expected 403 for unauthenticated API, got {e.code}"

    # 7. Authenticated API request with cookie succeeds
    req_cookie_api = urllib.request.Request(f"{base_url}/api/settings", headers={"Cookie": f"pulse_session={token}"})
    with urllib.request.urlopen(req_cookie_api) as resp_api:
        assert resp_api.status == 200, f"Expected 200 with session cookie, got {resp_api.status}"

    # 8. Authenticated API request with header succeeds
    req_header_api = urllib.request.Request(f"{base_url}/api/settings", headers={"X-Pulse-Token": token})
    with urllib.request.urlopen(req_header_api) as resp_api2:
        assert resp_api2.status == 200, f"Expected 200 with X-Pulse-Token, got {resp_api2.status}"

    server.shutdown()
    print("    [+] HTTP server security, CSP, Origin checks, and session protection verified.")

if __name__ == "__main__":
    test_version()
    test_credential_encryption()
    test_gemini_url_and_headers()
    test_pdf_decompression_bomb_protection()
    test_http_server_security()
    print("\n[ALL SECURITY TESTS PASSED SUCCESSFULLY!]")
