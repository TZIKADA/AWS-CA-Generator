FROM python:3.12-slim AS base
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 PIP_NO_CACHE_DIR=1
RUN apt-get update \
    && apt-get install -y --no-install-recommends gnupg gpg-agent ca-certificates \
    && rm -rf /var/lib/apt/lists/*

FROM base AS builder
WORKDIR /build
RUN python -m venv /venv
ENV PATH="/venv/bin:$PATH"
COPY pyproject.toml ./
COPY src ./src
RUN pip install --upgrade pip build && pip install .

FROM base AS runtime
COPY --from=builder /venv /venv
ENV PATH="/venv/bin:$PATH"
WORKDIR /app
COPY alembic.ini ./
RUN useradd --system --uid 10001 --home /tmp --shell /usr/sbin/nologin app \
    && chown -R app:app /app
USER 10001
ENV GNUPGHOME=/tmp/gnupg
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8080/api/health')"
CMD ["uvicorn", "sigvault.main:app", "--host", "0.0.0.0", "--port", "8080", "--proxy-headers"]
