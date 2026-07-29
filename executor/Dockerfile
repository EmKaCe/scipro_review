# =============================================================================
# Python Notebook Executor — Docker image
# =============================================================================
# FastAPI microservice that executes .ipynb files on demand,
# returning structured results and logs.
#
# Build:    docker build -t svelte-review-executor ./executor
# Run:      docker run -p 8766:8766 svelte-review-executor
# =============================================================================

FROM python:3.12-slim

# Prevent Python from writing .pyc files and buffering stdout/stderr
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app

# Install system dependencies (none currently — add here for numpy, scipy, etc.)
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Copy dependency file and install Python packages
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy the application code
COPY . .

# Create a non-root user for security
RUN addgroup --system --gid 1001 executor && \
    adduser --system --uid 1001 --ingroup executor executor && \
    chown -R executor:executor /app

USER executor

ENV PORT=8766 \
    EXECUTOR_LOG_LEVEL=info

EXPOSE 8766

HEALTHCHECK --interval=15s --timeout=5s --start-period=5s --retries=3 \
    CMD curl --fail http://localhost:8766/health || exit 1

CMD ["sh", "-c", "uvicorn app:app --host 0.0.0.0 --port ${PORT} --log-level ${EXECUTOR_LOG_LEVEL}"]
