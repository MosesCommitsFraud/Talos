# dictation sidecar. Not part of the default compose stack — run it next to
# the other GPU services and point DICTATION_WS_URL at it. PortAudio is needed
# at import time by RealtimeSTT even though the mic is never used (audio comes
# in over the websocket).
FROM python:3.12-slim

# gcc + portaudio19-dev: PyAudio (pulled in by RealtimeSTT) ships no wheel for
# aarch64 and gets compiled from source during pip install.
RUN apt-get update \
    && apt-get install -y --no-install-recommends libportaudio2 portaudio19-dev gcc libc6-dev ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY app.py .

EXPOSE 8004
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8004"]
