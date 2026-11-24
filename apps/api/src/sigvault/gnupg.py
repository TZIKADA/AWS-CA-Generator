import os
import shutil
import tempfile
from contextlib import contextmanager

import gnupg

from .config import settings


@contextmanager
def _homedir():
    os.makedirs(settings.gnupghome, exist_ok=True)
    d = tempfile.mkdtemp(dir=settings.gnupghome)
    try:
        yield gnupg.GPG(gnupghome=d)
    finally:
        shutil.rmtree(d, ignore_errors=True)


def sign_detached(private_key_armored: bytes, data: bytes) -> bytes:
    with _homedir() as gpg:
        import_result = gpg.import_keys(private_key_armored)
        if not import_result.fingerprints:
            raise RuntimeError("failed to import signing key")
        signed = gpg.sign(data, keyid=import_result.fingerprints[0], detach=True)
        if not signed.data:
            raise RuntimeError(f"sign failed: {signed.status}")
        return signed.data
