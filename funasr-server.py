"""
FunASR ASR HTTP server based on Paraformer-SPK (speaker diarization).

Designed to run on EC2 GPU instance at /home/ubuntu/funasr-server.py

Endpoints:
    GET  /health  - Health check
    POST /asr     - Transcribe audio (S3 key or direct upload)
"""

import hashlib
import logging
import os
import tempfile
import threading
import time

import boto3
from flask import Flask, jsonify, request

# --------------- Logging ---------------

logging.basicConfig(
    level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s"
)
logger = logging.getLogger(__name__)

# --------------- Constants ---------------

PORT = int(os.environ.get("FUNASR_PORT", 9002))
REGION = os.environ.get("AWS_REGION", "us-east-1")
DEFAULT_BUCKET = os.environ.get("S3_BUCKET", "yc-projects-012289836917")
CACHE_DIR = "/opt/dlami/nvme/funasr-cache"
CACHE_TTL_SECONDS = 24 * 3600  # 24 hours
IDLE_TIMEOUT_SECONDS = 30 * 60  # 30 minutes
MODEL_PATH = "/opt/funasr-models/damo/speech_paraformer-large-vad-punc-spk_asr_nat-zh-cn"

# --------------- Global State ---------------

os.makedirs(CACHE_DIR, exist_ok=True)

_last_activity = time.time()
_activity_lock = threading.Lock()


def touch_activity():
    global _last_activity
    with _activity_lock:
        _last_activity = time.time()


# --------------- Model Initialization ---------------

logger.info(f"Loading FunASR model from: {MODEL_PATH}")
from funasr import AutoModel  # noqa: E402 (import after logging setup)

model = AutoModel(
    model=MODEL_PATH,
    device="cuda",
    disable_update=True,
)
logger.info("FunASR model loaded successfully.")

# --------------- Flask App ---------------

app = Flask(__name__)

# --------------- Cache Cleanup Thread ---------------


def cleanup_old_files():
    """Background thread: remove cached files older than CACHE_TTL_SECONDS."""
    while True:
        time.sleep(3600)  # run every hour
        now = time.time()
        try:
            for fname in os.listdir(CACHE_DIR):
                fpath = os.path.join(CACHE_DIR, fname)
                if os.path.isfile(fpath):
                    age = now - os.path.getmtime(fpath)
                    if age > CACHE_TTL_SECONDS:
                        os.remove(fpath)
                        logger.info(f"Cache evicted (TTL): {fname}")
        except Exception as e:
            logger.warning(f"Cache cleanup error: {e}")


cleanup_thread = threading.Thread(target=cleanup_old_files, daemon=True)
cleanup_thread.start()

# --------------- Idle Shutdown Thread ---------------


def idle_shutdown():
    """Background thread: shutdown the instance after IDLE_TIMEOUT_SECONDS of inactivity."""
    while True:
        time.sleep(60)
        with _activity_lock:
            idle_secs = time.time() - _last_activity
        if idle_secs > IDLE_TIMEOUT_SECONDS:
            logger.warning(
                f"No activity for {idle_secs:.0f}s (>{IDLE_TIMEOUT_SECONDS}s), shutting down."
            )
            os.system("sudo shutdown -h now")


idle_thread = threading.Thread(target=idle_shutdown, daemon=True)
idle_thread.start()

# --------------- S3 Download with Cache ---------------


def _cache_path(s3_bucket: str, s3_key: str) -> str:
    key_hash = hashlib.sha256(f"{s3_bucket}/{s3_key}".encode()).hexdigest()[:16]
    ext = os.path.splitext(s3_key)[-1] or ".audio"
    return os.path.join(CACHE_DIR, f"{key_hash}{ext}")


def download_from_s3(s3_bucket: str, s3_key: str) -> tuple[str, bool]:
    """
    Download file from S3, using local cache if available.
    Returns (local_path, was_cached).
    """
    local_path = _cache_path(s3_bucket, s3_key)
    if os.path.exists(local_path):
        logger.info(f"Cache hit: {s3_key}")
        # Refresh mtime to extend TTL
        os.utime(local_path, None)
        return local_path, True

    logger.info(f"Downloading s3://{s3_bucket}/{s3_key} -> {local_path}")
    s3 = boto3.client("s3", region_name=REGION)
    s3.download_file(s3_bucket, s3_key, local_path)
    logger.info(f"Download complete: {os.path.getsize(local_path)} bytes")
    return local_path, False


# --------------- Result Parsing ---------------


def parse_funasr_result(res: list) -> dict:
    """
    Parse FunASR model.generate() output into segments + metadata.

    Each element in res may have:
      - text: str  (full text for the segment/chunk)
      - timestamp: list of [start_ms, end_ms] per character/word
      - spk_id: str  (speaker label, e.g. "SPEAKER_0")
      - spk: str  (alternative speaker field name)
    """
    segments = []
    speakers_seen = []

    for item in res:
        raw_text = (item.get("text") or "").strip()
        if not raw_text:
            continue

        # Speaker label: try spk_id first, then spk
        spk_raw = item.get("spk_id") or item.get("spk") or "SPEAKER_0"
        # Normalise to SPEAKER_N format
        if isinstance(spk_raw, int):
            speaker = f"SPEAKER_{spk_raw}"
        else:
            speaker = str(spk_raw)

        # Timestamps: FunASR returns [[start_ms, end_ms], ...] per token
        timestamps = item.get("timestamp") or []
        if timestamps:
            start_sec = round(timestamps[0][0] / 1000.0, 3)
            end_sec = round(timestamps[-1][1] / 1000.0, 3)
        else:
            start_sec = 0.0
            end_sec = 0.0

        segments.append(
            {
                "start": start_sec,
                "end": end_sec,
                "text": raw_text,
                "speaker": speaker,
            }
        )

        if speaker not in speakers_seen:
            speakers_seen.append(speaker)

    full_text = "".join(seg["text"] for seg in segments)
    return {
        "segments": segments,
        "text": full_text,
        "speakers": speakers_seen,
        "speaker_count": len(speakers_seen),
    }


# --------------- Routes ---------------


@app.route("/health", methods=["GET"])
def health():
    return jsonify(
        {
            "status": "ok",
            "model": "paraformer-spk",
            "cache_dir": CACHE_DIR,
        }
    )


@app.route("/asr", methods=["POST"])
def asr():
    touch_activity()

    s3_key = request.form.get("s3_key", "").strip()
    s3_bucket = request.form.get("s3_bucket", DEFAULT_BUCKET).strip()
    language = request.form.get("language", "auto").strip()
    uploaded_file = request.files.get("file")

    tmp_path = None
    cached = False

    try:
        # --- Resolve audio file path ---
        if s3_key:
            audio_path, cached = download_from_s3(s3_bucket, s3_key)
        elif uploaded_file and uploaded_file.filename:
            suffix = os.path.splitext(uploaded_file.filename)[-1] or ".audio"
            with tempfile.NamedTemporaryFile(
                suffix=suffix, delete=False, dir=CACHE_DIR
            ) as tmp:
                uploaded_file.save(tmp)
                tmp_path = tmp.name
            audio_path = tmp_path
            logger.info(
                f"Received uploaded file: {uploaded_file.filename} -> {tmp_path}"
            )
        else:
            return (
                jsonify(
                    {"error": "Provide 's3_key' or upload a file via 'file' field."}
                ),
                400,
            )

        # --- Transcribe ---
        logger.info(f"Transcribing: {audio_path} (language={language})")
        generate_kwargs = dict(
            input=audio_path,
            batch_size_s=300,
            hotword="",
        )
        # FunASR AutoModel may accept a language hint; pass only when not 'auto'
        if language and language != "auto":
            generate_kwargs["language"] = language

        res = model.generate(**generate_kwargs)
        logger.info(f"Raw FunASR output: {len(res)} chunk(s)")

        # --- Parse result ---
        parsed = parse_funasr_result(res)

        # --- Detect language from result (FunASR may include it) ---
        detected_lang = language
        if res and isinstance(res[0], dict):
            detected_lang = res[0].get("lang") or res[0].get("language") or language

        response_body = {
            "text": parsed["text"],
            "segments": parsed["segments"],
            "language": detected_lang,
            "speakers": parsed["speakers"],
            "speaker_count": parsed["speaker_count"],
            "cached": cached,
        }
        logger.info(
            f"Done: {len(parsed['segments'])} segments, "
            f"{parsed['speaker_count']} speaker(s), "
            f"lang={detected_lang}"
        )
        return jsonify(response_body)

    except Exception as e:
        logger.error(f"ASR error: {e}", exc_info=True)
        return jsonify({"error": str(e)}), 500

    finally:
        # Clean up temp upload (not cached S3 files)
        if tmp_path and os.path.exists(tmp_path):
            try:
                os.remove(tmp_path)
            except OSError:
                pass
        touch_activity()


# --------------- Entry Point ---------------

if __name__ == "__main__":
    logger.info(f"Starting FunASR server on port {PORT}")
    app.run(host="0.0.0.0", port=PORT, threaded=False)
