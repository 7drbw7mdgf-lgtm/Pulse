import base64
import hashlib
import hmac
import re
import secrets
import zlib
from pulse_core.constants import CONFIG_DIR, ClientError

SENSITIVE_SETTING_KEYS = {"apiKey", "dimensionsApiKey", "semanticScholarApiKey", "geminiApiKey"}
MAX_DECOMPRESSED_STREAM_BYTES = 4 * 1024 * 1024  # 4 MB max per stream
MAX_TOTAL_DECOMPRESSED_BYTES = 24 * 1024 * 1024  # 24 MB max total per document

def get_encryption_key():
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    key_path = CONFIG_DIR / ".secrets.key"
    if key_path.exists():
        try:
            k = key_path.read_bytes()
            if len(k) == 32:
                return k
        except Exception:
            pass
    k = secrets.token_bytes(32)
    key_path.write_bytes(k)
    try:
        key_path.chmod(0o600)
    except OSError:
        pass
    return k

def encrypt_secret(plaintext):
    if not plaintext or not isinstance(plaintext, str):
        return ""
    if plaintext.startswith("enc:v1:"):
        return plaintext
    key = get_encryption_key()
    try:
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM
        aesgcm = AESGCM(key)
        nonce = secrets.token_bytes(12)
        ct = aesgcm.encrypt(nonce, plaintext.encode("utf-8"), None)
        return "enc:v1:" + base64.b64encode(nonce + ct).decode("utf-8")
    except Exception:
        nonce = secrets.token_bytes(16)
        raw = plaintext.encode("utf-8")
        stream_key = hashlib.sha256(key + nonce).digest()
        blocks = (hashlib.sha256(stream_key + i.to_bytes(4, "big")).digest() for i in range((len(raw) // 32) + 1))
        keystream = b"".join(blocks)[:len(raw)]
        encrypted = bytes(a ^ b for a, b in zip(raw, keystream))
        tag = hmac.new(key, nonce + encrypted, hashlib.sha256).digest()[:16]
        return "enc:v1:" + base64.b64encode(nonce + tag + encrypted).decode("utf-8")

def decrypt_secret(ciphertext):
    if not ciphertext or not isinstance(ciphertext, str):
        return ""
    if not ciphertext.startswith("enc:v1:"):
        return ciphertext
    payload_b64 = ciphertext[len("enc:v1:"):]
    try:
        raw = base64.b64decode(payload_b64)
    except Exception:
        return ""
    key = get_encryption_key()
    try:
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM
        nonce = raw[:12]
        ct = raw[12:]
        aesgcm = AESGCM(key)
        return aesgcm.decrypt(nonce, ct, None).decode("utf-8")
    except Exception:
        try:
            nonce = raw[:16]
            tag = raw[16:32]
            encrypted = raw[32:]
            expected_tag = hmac.new(key, nonce + encrypted, hashlib.sha256).digest()[:16]
            if not hmac.compare_digest(tag, expected_tag):
                return ""
            stream_key = hashlib.sha256(key + nonce).digest()
            blocks = (hashlib.sha256(stream_key + i.to_bytes(4, "big")).digest() for i in range((len(encrypted) // 32) + 1))
            keystream = b"".join(blocks)[:len(encrypted)]
            decrypted = bytes(a ^ b for a, b in zip(encrypted, keystream))
            return decrypted.decode("utf-8")
        except Exception:
            return ""

def safe_decompress_flate(candidate, max_bytes=MAX_DECOMPRESSED_STREAM_BYTES):
    try:
        return zlib.decompress(candidate, max_length=max_bytes)
    except TypeError:
        try:
            d = zlib.decompressobj()
            return d.decompress(candidate, max_bytes)
        except Exception:
            return None
    except (zlib.error, MemoryError):
        return None

def decode_pdf_streams(raw):
    decoded = []
    total_decompressed = 0
    stream_count = 0
    for match in re.finditer(rb"<<(?P<dict>[\s\S]{0,2000}?/FlateDecode[\s\S]{0,2000}?)>>\s*stream\r?\n(?P<body>[\s\S]*?)\r?\nendstream", raw):
        dict_part = match.group("dict")
        # Skip pure raster image streams which consume memory without containing text
        if b"/Subtype/Image" in dict_part or b"/Subtype /Image" in dict_part or b"/DCTDecode" in dict_part:
            continue
        stream_count += 1
        if stream_count > 350 or total_decompressed >= MAX_TOTAL_DECOMPRESSED_BYTES:
            break
        body = match.group("body").strip(b"\r\n")
        if len(body) > 6 * 1024 * 1024:
            continue
        for candidate in zlib_candidates(body):
            remaining = MAX_TOTAL_DECOMPRESSED_BYTES - total_decompressed
            allowed = min(MAX_DECOMPRESSED_STREAM_BYTES, max(0, remaining))
            if allowed <= 0:
                break
            inflated = safe_decompress_flate(candidate, max_bytes=allowed)
            if inflated:
                total_decompressed += len(inflated)
                decoded.extend(decode_pdf_text_bytes(inflated))
                break
    return decoded

def zlib_candidates(body):
    yield body
    if body.startswith(b"\r\n") or body.startswith(b"\n"):
        yield body.lstrip(b"\r\n")
    for index in range(min(len(body), 12)):
        yield body[index:]

def decode_pdf_text_bytes(data):
    if not data:
        return []
    if len(data) > MAX_DECOMPRESSED_STREAM_BYTES:
        data = data[:MAX_DECOMPRESSED_STREAM_BYTES]
    chunks = []
    for encoding in ("utf-8", "latin-1", "utf-16be", "utf-16le"):
        chunks.append(data.decode(encoding, errors="ignore")[:60000])
    for array in re.findall(rb"\[([^\]]+)\]\s*TJ", data):
        parts = re.findall(rb"\(([^\)]*)\)", array)
        if parts:
            chunks.append("".join(p.decode("latin-1", errors="ignore") for p in parts))
    tj_matches = re.findall(rb"\(([^\)]*)\)\s*Tj", data)
    if tj_matches:
        chunks.append(" ".join(m.decode("latin-1", errors="ignore") for m in tj_matches if len(m) > 1))
    for uri in re.findall(rb"/URI\s*\(([^\)]+)\)", data):
        chunks.append(uri.decode("latin-1", errors="ignore"))
    strings = re.findall(rb"[\x20-\x7E]{4,}", data)
    chunks.extend(item.decode("latin-1", errors="ignore") for item in strings[:2000])
    return chunks
