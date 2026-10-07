"""Application configuration and mutable state, scoped explicitly to each instance."""
from __future__ import annotations
from collections import OrderedDict
from contextlib import contextmanager
from contextvars import ContextVar, copy_context
from dataclasses import dataclass, field
import logging
import os
from pathlib import Path
import secrets
import shutil
import threading
from typing import Any, Iterator, Optional

logger = logging.getLogger(__name__)
LOCAL_BACKEND_DEFAULTS = {
    'aiProvider': 'local', 'cloudProvider': 'not-configured',
    'ollamaChatEndpoint': 'http://127.0.0.1:11434/api/chat',
    'ollamaTagsEndpoint': 'http://127.0.0.1:11434/api/tags',
    'ollamaEmbeddingsEndpoint': 'http://127.0.0.1:11434/api/embeddings',
    'chatModel': 'gemma3:4b', 'embeddingModel': 'nomic-embed-text',
    'emergencyEmbeddingFallback': 'hashed-local-fallback', 'autoGemmaExtraction': True,
}
DEFAULT_GEMMA_MODEL = LOCAL_BACKEND_DEFAULTS['chatModel']
LOOPBACK_HOSTS = {'127.0.0.1', 'localhost', '::1', '[::1]'}
DIMENSIONS_API_ROOT = 'https://app.dimensions.ai'
SEMANTIC_SCHOLAR_API_ROOT = 'https://api.semanticscholar.org'


class ClientError(Exception):
    """An expected failure with a safe message for the local API client."""
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status


@dataclass
class AppContext:
    root: Path
    config_dir: Path
    edition: str = 'full'
    version: str = '1.3.1'
    api_token: str = field(default_factory=lambda: secrets.token_urlsafe(32), repr=False)
    contact_email: str = ''
    bound_port: int = 8000
    max_papers: Optional[int] = None
    ollama_models_dir: Optional[Path] = None
    ollama_process: Any = None
    ollama_boot_status: dict = field(default_factory=lambda: {'started': False, 'reason': 'not-started'})
    bootstrap_consumed: bool = False
    bootstrap_lock: Any = field(default_factory=threading.Lock)
    credential_lock: Any = field(default_factory=threading.Lock)
    server: Any = None
    discovery_jobs: Any = None
    save_revisions: dict = field(default_factory=dict)
    s2_cache: dict = field(default_factory=dict)
    library_write_lock: Any = field(default_factory=threading.RLock)
    cache_lock: Any = field(default_factory=threading.Lock)
    json_cache: OrderedDict = field(default_factory=OrderedDict)
    provider_gates: dict = field(default_factory=dict)
    embedding_locks: list = field(default_factory=lambda: [threading.Lock() for _ in range(16)])
    request_context: Any = field(default_factory=threading.local)

    @property
    def config_path(self) -> Path:
        return self.config_dir / 'settings.json'

    @property
    def library_path(self) -> Path:
        return self.config_dir / 'library.json'

    @property
    def bundled_ollama(self) -> Path:
        return self.root / 'bin' / 'ollama'


_current: ContextVar[Optional[AppContext]] = ContextVar('pulse_app_context', default=None)


def get_context() -> AppContext:
    context = _current.get()
    if context is None:
        raise RuntimeError('Pulse service called without an application context.')
    return context


@contextmanager
def use_context(context: AppContext) -> Iterator[AppContext]:
    token = _current.set(context)
    try:
        yield context
    finally:
        _current.reset(token)


def set_context(context: AppContext) -> None:
    """Bind the CLI/import bridge; request and worker scopes use use_context."""
    _current.set(context)


def contextual(target):
    """Capture a fresh context for one thread/executor task, never share Context.run."""
    captured = copy_context()
    return lambda *args, **kwargs: captured.run(target, *args, **kwargs)


def create_context(root: Path, edition: str = 'full') -> AppContext:
    env = os.environ
    lite = edition == 'lite'
    override = env.get('PULSE_LITE_CONFIG_DIR') if lite else (env.get('PULSE_CONFIG_DIR') or env.get('IRATXE_CONFIG_DIR'))
    config = Path(override) if override else Path.home() / 'Library' / 'Application Support' / ('pulse-lite' if lite else 'pulse')
    if not lite and not override and not config.exists():
        legacy = config.parent / 'iratxe'
        if legacy.exists():
            try:
                shutil.copytree(legacy, config, dirs_exist_ok=True)
            except OSError as error:
                logger.warning('Legacy library migration failed (%s, errno=%s)', type(error).__name__, error.errno)
    context = AppContext(
        root=Path(env.get("PULSE_RESOURCE_ROOT") or root), config_dir=config, edition=edition,
        version=env.get('PULSE_APP_VERSION') or env.get('IRATXE_APP_VERSION') or ('1.1.0' if lite else '1.3.1'),
        api_token=(env.get('PULSE_API_TOKEN') or env.get('IRATXE_API_TOKEN') or '').strip() or secrets.token_urlsafe(32),
        contact_email=(env.get('PULSE_CONTACT_EMAIL') or env.get('IRATXE_CONTACT_EMAIL') or '').strip(),
        bound_port=int(env.get('PULSE_PORT') or env.get('IRATXE_PORT') or '8000'),
        max_papers=15 if lite else None,
        ollama_models_dir=Path(env.get('PULSE_OLLAMA_MODELS') or env.get('IRATXE_OLLAMA_MODELS') or config / 'models'),
    )
    from .performance import DiscoveryJobs
    context.discovery_jobs = DiscoveryJobs()
    return context
