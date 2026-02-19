"""
FunASR ASR HTTP server based on Paraformer + VAD + CAM++ (speaker diarization).

Designed to run on EC2 GPU instance at /home/ubuntu/funasr-server.py

Endpoints:
    GET  /health  - Health check
    POST /asr     - Transcribe audio (S3 key or direct upload)
"""

import hashlib
import logging
import os
import pathlib
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
MODEL_PATH = os.environ.get("FUNASR_MODEL_PATH", "/opt/funasr-models/damo/speech_paraformer-large-vad-punc-spk_asr_nat-zh-cn")
FUNASR_MODEL = os.environ.get("FUNASR_MODEL", "paraformer-zh")
DEVICE = os.environ.get("FUNASR_DEVICE", "cuda")
BATCH_SIZE_S = int(os.environ.get("FUNASR_BATCH_SIZE_S", "300"))
ENABLE_IDLE_SHUTDOWN = os.environ.get("ENABLE_IDLE_SHUTDOWN", "false").lower() == "true"

# Decide which model to load: local path takes priority, fall back to FUNASR_MODEL
if pathlib.Path(MODEL_PATH).exists():
    model_to_load = MODEL_PATH
    logger.info(f"Using local model path: {MODEL_PATH}")
else:
    model_to_load = FUNASR_MODEL
    logger.info(f"Local model not found at {MODEL_PATH}, using: {FUNASR_MODEL}")

# --------------- Global State ---------------

os.makedirs(CACHE_DIR, exist_ok=True)

# --------------- S3 Singleton ---------------

s3_client = boto3.client("s3", region_name=REGION)

_last_activity = time.time()
_activity_lock = threading.Lock()


def touch_activity():
    global _last_activity
    with _activity_lock:
        _last_activity = time.time()


# --------------- Model Initialization ---------------

logger.info(f"Loading FunASR model: {model_to_load}")
from funasr import AutoModel  # noqa: E402 (import after logging setup)

model = AutoModel(
    model=model_to_load,
    vad_model="fsmn-vad",
    vad_kwargs={"max_single_segment_time": 10000},  # VAD 最大分段 10 秒，防止 OOM
    punc_model="ct-punc",
    spk_model="cam++",
    device=DEVICE,
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
    if not ENABLE_IDLE_SHUTDOWN:
        return
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
    tmp_path = local_path + ".tmp"
    try:
        s3_client.download_file(s3_bucket, s3_key, tmp_path)
        os.rename(tmp_path, local_path)  # atomic on Linux
    except Exception:
        # 清理不完整的临时文件
        if os.path.exists(tmp_path):
            os.remove(tmp_path)
        raise
    logger.info(f"Download complete: {os.path.getsize(local_path)} bytes")
    return local_path, False


# --------------- Routes ---------------


@app.route("/health", methods=["GET"])
def health():
    return jsonify(
        {
            "status": "ok",
            "model": model_to_load,
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
            batch_size_s=BATCH_SIZE_S,           # 动态 batch 总秒数（默认 300）
            batch_size_threshold_s=60,           # 超过 60s 的 VAD 片段单独处理
        )
        # FunASR AutoModel may accept a language hint; pass only when not 'auto'
        if language and language != "auto":
            generate_kwargs["language"] = language

        import torch
        torch.cuda.empty_cache()

        # 官方推荐单次调用，VAD 自动分段（max_single_segment_time=10000ms 防 OOM）
        res = model.generate(**generate_kwargs)

        logger.info(f"Raw FunASR output: {res}")

        # --- Parse result ---
        # cam++ 输出格式：sentence_info 模式（优先）或 timestamp+spk_id 模式（fallback）
        segments = []
        if res and isinstance(res, list):
            item = res[0] if isinstance(res[0], dict) else {}

            # 优先用 sentence_info（cam++ 输出格式）
            sentence_info = item.get("sentence_info", [])
            if sentence_info:
                for sent in sentence_info:
                    segments.append({
                        "start": round(sent.get("start", 0) / 1000.0, 3),
                        "end": round(sent.get("end", 0) / 1000.0, 3),
                        "text": sent.get("text", "").replace(" ", ""),  # 去掉字间空格
                        "speaker": sent.get("spk", "SPEAKER_0"),
                    })
            else:
                # fallback: 旧格式，整个 res 是 segments
                for seg_item in res:
                    timestamps = seg_item.get("timestamp") or []
                    text_content = seg_item.get("text", "").replace(" ", "").strip()
                    if not text_content:
                        continue
                    if timestamps:
                        t0 = timestamps[0]
                        t_last = timestamps[-1]
                        start_sec = round(t0[0] / 1000.0, 3)
                        end_sec = round((t_last[1] if len(t_last) > 1 else t_last[0]) / 1000.0, 3)
                    else:
                        start_sec, end_sec = 0.0, 0.0
                    spk = seg_item.get("spk_id") or seg_item.get("spk") or "SPEAKER_0"
                    segments.append({
                        "start": start_sec,
                        "end": end_sec,
                        "text": text_content,
                        "speaker": spk,
                    })

        full_text = "".join(seg["text"] for seg in segments)
        unique_speakers = sorted(set(seg["speaker"] for seg in segments))

        logger.info(
            f"Done: {len(segments)} segments, "
            f"{len(unique_speakers)} speaker(s), "
            f"lang={language}"
        )

        response_body = {
            "text": full_text,
            "segments": segments,
            "language": language,
            "speakers": unique_speakers,
            "speaker_count": len(unique_speakers),
            "cached": cached,
        }
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
        import torch
        if torch.cuda.is_available():
            torch.cuda.empty_cache()


# --------------- Entry Point ---------------

if __name__ == "__main__":
    logger.info(f"Starting FunASR server on port {PORT}")
    app.run(host="0.0.0.0", port=PORT, threaded=False)
