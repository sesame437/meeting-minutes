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
MODEL_PATH = os.environ.get("FUNASR_MODEL_PATH", "/opt/funasr-models/damo/speech_paraformer-large-vad-punc-spk_asr_nat-zh-cn")
DEVICE = os.environ.get("FUNASR_DEVICE", "cuda")
BATCH_SIZE_S = int(os.environ.get("FUNASR_BATCH_SIZE_S", "10"))
ENABLE_IDLE_SHUTDOWN = os.environ.get("ENABLE_IDLE_SHUTDOWN", "false").lower() == "true"

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

logger.info(f"Loading FunASR model from: {MODEL_PATH}")
from funasr import AutoModel  # noqa: E402 (import after logging setup)

model = AutoModel(
    model=MODEL_PATH,
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
    s3_client.download_file(s3_bucket, s3_key, local_path)
    logger.info(f"Download complete: {os.path.getsize(local_path)} bytes")
    return local_path, False


# --------------- Audio Chunking ---------------

CHUNK_DURATION_S = int(os.environ.get("FUNASR_CHUNK_DURATION_S", "300"))  # 5分钟一片


def chunk_audio(audio_path: str, chunk_duration: int = CHUNK_DURATION_S) -> list:
    """用 ffmpeg 把音频切成固定长度片段，返回片段路径列表"""
    import subprocess

    # 获取总时长
    probe = subprocess.run(
        ["ffprobe", "-v", "quiet", "-print_format", "json", "-show_format", audio_path],
        capture_output=True, text=True
    )
    import json as _json
    duration = float(_json.loads(probe.stdout)["format"]["duration"])

    if duration <= chunk_duration:
        return [audio_path]  # 短于阈值，不切片

    chunks = []
    chunk_dir = audio_path + "_chunks"
    os.makedirs(chunk_dir, exist_ok=True)

    start = 0
    idx = 0
    while start < duration:
        chunk_path = os.path.join(chunk_dir, f"chunk_{idx:04d}.wav")
        subprocess.run([
            "ffmpeg", "-y", "-i", audio_path,
            "-ss", str(start), "-t", str(chunk_duration),
            "-ar", "16000", "-ac", "1",  # 16kHz mono（FunASR 标准格式）
            chunk_path
        ], capture_output=True)
        chunks.append(chunk_path)
        start += chunk_duration
        idx += 1

    logger.info(f"Split audio into {len(chunks)} chunks of {chunk_duration}s")
    return chunks


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
            t_first = timestamps[0]
            t_last = timestamps[-1]
            start_sec = round(t_first[0] / 1000.0, 3)
            end_sec = round((t_last[1] if len(t_last) > 1 else t_last[0]) / 1000.0, 3)
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
        generate_kwargs_base = dict(
            batch_size_s=BATCH_SIZE_S,
            batch_size_threshold_s=int(os.environ.get("FUNASR_BATCH_THRESHOLD_S", "60")),
        )
        # FunASR AutoModel may accept a language hint; pass only when not 'auto'
        if language and language != "auto":
            generate_kwargs_base["language"] = language

        import torch

        # 切片处理
        chunks = chunk_audio(audio_path)
        all_segments = []
        time_offset = 0.0

        for i, chunk_path in enumerate(chunks):
            logger.info(f"Processing chunk {i+1}/{len(chunks)}: {chunk_path}")
            torch.cuda.empty_cache()

            chunk_kwargs = dict(
                input=chunk_path,
                **generate_kwargs_base,
            )
            try:
                chunk_res = model.generate(**chunk_kwargs)
            except (RuntimeError, Exception) as e:
                if "out of memory" in str(e).lower():
                    logger.warning(f"OOM on chunk {i+1}, retrying with batch_size_s=5")
                    torch.cuda.empty_cache()
                    chunk_kwargs["batch_size_s"] = 5
                    chunk_res = model.generate(**chunk_kwargs)
                else:
                    raise

            # 解析 chunk 结果，时间戳加上 offset
            for item in chunk_res:
                timestamps = item.get("timestamp") or []
                text_content = item.get("text", "").strip()
                if not text_content:
                    continue

                if timestamps:
                    t0 = timestamps[0]
                    t_last = timestamps[-1]
                    start_sec = round(t0[0] / 1000.0 + time_offset, 3)
                    end_sec = round((t_last[1] if len(t_last) > 1 else t_last[0]) / 1000.0 + time_offset, 3)
                else:
                    start_sec = round(time_offset, 3)
                    end_sec = round(time_offset + 1.0, 3)

                spk_raw = item.get("spk_id") or item.get("spk") or "SPEAKER_0"
                # 说话人 ID 加 chunk 偏移前缀，后续合并时需要归一化
                speaker = f"SPK_{spk_raw}"

                all_segments.append({
                    "start": start_sec,
                    "end": end_sec,
                    "text": text_content,
                    "speaker": speaker,
                })

            # 更新时间偏移（用实际 chunk 时长）
            import subprocess as _sp
            import json as _json2
            probe2 = _sp.run(
                ["ffprobe", "-v", "quiet", "-print_format", "json", "-show_format", chunk_path],
                capture_output=True, text=True
            )
            try:
                chunk_actual_dur = float(_json2.loads(probe2.stdout)["format"]["duration"])
            except Exception:
                chunk_actual_dur = CHUNK_DURATION_S
            time_offset += chunk_actual_dur

        # 清理临时片段目录
        if len(chunks) > 1:
            import shutil
            chunk_dir = chunks[0].rsplit("/", 1)[0]
            shutil.rmtree(chunk_dir, ignore_errors=True)

        # 合并说话人 ID（跨片段归一化：按出现顺序映射为 SPEAKER_0/1/2...）
        seen_speakers = {}
        spk_counter = 0
        for seg in all_segments:
            raw = seg["speaker"]
            if raw not in seen_speakers:
                seen_speakers[raw] = f"SPEAKER_{spk_counter}"
                spk_counter += 1
            seg["speaker"] = seen_speakers[raw]

        segments = all_segments
        full_text = "".join(seg["text"] for seg in segments)
        unique_speakers = sorted(set(seg["speaker"] for seg in segments))

        logger.info(f"Raw FunASR output: {len(chunks)} chunk(s) -> {len(segments)} segment(s)")

        # --- Detect language from result (FunASR may include it) ---
        detected_lang = language

        response_body = {
            "text": full_text,
            "segments": segments,
            "language": detected_lang,
            "speakers": unique_speakers,
            "speaker_count": len(unique_speakers),
            "cached": cached,
        }
        logger.info(
            f"Done: {len(segments)} segments, "
            f"{len(unique_speakers)} speaker(s), "
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
        import torch
        if torch.cuda.is_available():
            torch.cuda.empty_cache()


# --------------- Entry Point ---------------

if __name__ == "__main__":
    logger.info(f"Starting FunASR server on port {PORT}")
    app.run(host="0.0.0.0", port=PORT, threaded=False)
