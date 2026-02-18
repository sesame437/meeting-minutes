"""
Whisper ASR HTTP server based on faster-whisper.

Usage:
    python workers/whisper-server.py

Endpoints:
    GET  /health  - Health check
    POST /asr     - Transcribe audio file (multipart/form-data, field: "file")
"""

import io
import logging
import tempfile
import os

from flask import Flask, request, jsonify
from faster_whisper import WhisperModel

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger(__name__)

app = Flask(__name__)

# --------------- Model Initialization ---------------

MODEL_SIZE = os.environ.get("WHISPER_MODEL", "large-v3-turbo")
DEVICE = os.environ.get("WHISPER_DEVICE", "auto")  # "cuda", "cpu", or "auto"

logger.info(f"Loading Whisper model: {MODEL_SIZE} on device: {DEVICE}")

if DEVICE == "auto":
    try:
        import torch
        device = "cuda" if torch.cuda.is_available() else "cpu"
    except ImportError:
        device = "cpu"
else:
    device = DEVICE

compute_type = "float16" if device == "cuda" else "int8"
model = WhisperModel(MODEL_SIZE, device=device, compute_type=compute_type)
logger.info(f"Model loaded: {MODEL_SIZE} on {device} ({compute_type})")

# --------------- Routes ---------------


@app.route("/health", methods=["GET"])
def health():
    return jsonify({"status": "ok", "model": MODEL_SIZE, "device": device})


@app.route("/asr", methods=["POST"])
def asr():
    if "file" not in request.files:
        return jsonify({"error": "No file provided, use multipart field 'file'"}), 400

    audio_file = request.files["file"]
    logger.info(f"Received file: {audio_file.filename}, size: {audio_file.content_length}")

    # Save to temporary file for faster-whisper
    with tempfile.NamedTemporaryFile(suffix=os.path.splitext(audio_file.filename or ".wav")[1], delete=False) as tmp:
        audio_file.save(tmp)
        tmp_path = tmp.name

    try:
        segments_iter, info = model.transcribe(tmp_path, beam_size=5)

        segments = []
        full_text_parts = []
        for seg in segments_iter:
            segments.append({
                "start": round(seg.start, 3),
                "end": round(seg.end, 3),
                "text": seg.text.strip(),
            })
            full_text_parts.append(seg.text.strip())

        full_text = " ".join(full_text_parts)
        logger.info(f"Transcription done: language={info.language}, segments={len(segments)}")

        return jsonify({
            "text": full_text,
            "segments": segments,
            "language": info.language,
        })
    except Exception as e:
        logger.error(f"Transcription error: {e}")
        return jsonify({"error": str(e)}), 500
    finally:
        os.unlink(tmp_path)


# --------------- Entry Point ---------------

if __name__ == "__main__":
    port = int(os.environ.get("WHISPER_PORT", 9000))
    logger.info(f"Starting Whisper server on port {port}")
    app.run(host="0.0.0.0", port=port)
