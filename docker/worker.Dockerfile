# syntax=docker/dockerfile:1
# BAHITH document worker (Python): extraction, OCR (Tesseract ara+eng), chunking.
FROM python:3.14-slim-bookworm
# Debian over HTTPS. An extra CA (e.g. a corporate proxy) can be supplied for the build
# only as the optional "extra_ca" secret; it is not kept in the image.
RUN --mount=type=secret,id=extra_ca,required=false \
    sed -i 's#http://deb.debian.org#https://deb.debian.org#g' /etc/apt/sources.list.d/debian.sources \
 && if [ -s /run/secrets/extra_ca ]; then \
      install -m 0644 /run/secrets/extra_ca /tmp/extra-ca.crt \
      && echo 'Acquire::https::CAInfo "/tmp/extra-ca.crt";' > /etc/apt/apt.conf.d/99extra-ca; fi \
 && apt-get update -qq && apt-get install -y -qq --no-install-recommends \
      tesseract-ocr tesseract-ocr-ara tesseract-ocr-eng ca-certificates \
 && rm -rf /var/lib/apt/lists/* /etc/apt/apt.conf.d/99extra-ca /tmp/extra-ca.crt
# Arabic OCR model: tessdata_best (Apache-2.0), pinned to a commit and verified by SHA-256.
# Clearly fewer misread words than the distribution's model on scanned Arabic pages (see
# docs/reports/ocr-arabic.md); the model fingerprint is part of each extraction's version.
ARG TESSDATA_BEST_COMMIT=e12c65a915945e4c28e237a9b52bc4a8f39a0cec
ARG ARA_BEST_SHA256=ab9d157d8e38ca00e7e39c7d5363a5239e053f5b0dbdb3167dde9d8124335896
RUN --mount=type=secret,id=extra_ca,required=false \
    SSL_CERT_FILE=$([ -s /run/secrets/extra_ca ] && echo /run/secrets/extra_ca || echo /etc/ssl/certs/ca-certificates.crt) \
    python -c "import hashlib,os,urllib.request as u; \
d=u.urlopen('https://raw.githubusercontent.com/tesseract-ocr/tessdata_best/${TESSDATA_BEST_COMMIT}/ara.traineddata',timeout=120).read(); \
assert hashlib.sha256(d).hexdigest()=='${ARA_BEST_SHA256}', 'ara.traineddata checksum mismatch'; \
p=[x for x in ('/usr/share/tesseract-ocr/5/tessdata','/usr/share/tesseract-ocr/4.00/tessdata') if os.path.isdir(x)][0]; \
open(os.path.join(p,'ara.traineddata'),'wb').write(d)"
RUN --mount=type=secret,id=extra_ca,required=false \
    PIP_CERT=$([ -s /run/secrets/extra_ca ] && echo /run/secrets/extra_ca) pip install --no-cache-dir uv==0.9.7
WORKDIR /app
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy UV_PROJECT_ENVIRONMENT=/app/.venv PATH=/app/.venv/bin:$PATH
COPY apps/worker/pyproject.toml apps/worker/uv.lock ./
RUN --mount=type=secret,id=extra_ca,required=false \
    SSL_CERT_FILE=$([ -s /run/secrets/extra_ca ] && echo /run/secrets/extra_ca) uv sync --frozen --no-dev --no-install-project
COPY apps/worker/ ./
RUN --mount=type=secret,id=extra_ca,required=false \
    SSL_CERT_FILE=$([ -s /run/secrets/extra_ca ] && echo /run/secrets/extra_ca) uv sync --frozen --no-dev && useradd --system --uid 10001 worker
USER worker
CMD ["/app/.venv/bin/python", "-m", "bahith_worker"]
