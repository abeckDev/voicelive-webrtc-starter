# Dockerfile
# ----------
# Multi-stage-friendly single-stage build for the voicelive-webrtc-starter.
#
# The image:
#   1. Installs Python dependencies from backend/requirements.txt
#   2. Copies the backend and frontend source trees
#   3. Starts the FastAPI server on port 8000
#
# The FastAPI app automatically serves the frontend from /app/frontend
# when that directory exists (see backend/app.py).
#
# Build & run:
#   docker build -t voicelive-webrtc-starter .
#   docker run -p 8000:8000 --env-file .env voicelive-webrtc-starter

FROM python:3.11-slim

WORKDIR /app

# Install Python dependencies first so this layer is cached between code changes.
COPY backend/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy application source
COPY backend/ ./backend/
COPY frontend/ ./frontend/

WORKDIR /app/backend

# Expose the API port
EXPOSE 8000

CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000"]
