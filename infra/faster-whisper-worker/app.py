import base64
import os
import tempfile
import wave

import numpy as np
from fastapi import FastAPI
from faster_whisper import WhisperModel
from pydantic import BaseModel

app = FastAPI(title="Project Veritas Faster-Whisper Worker")


def normalize_optional_text(value: str | None) -> str | None:
    if value is None:
        return None

    trimmed = value.strip()
    return trimmed or None

WHISPER_MODEL = os.getenv("WHISPER_MODEL", "base")
WHISPER_DEVICE = os.getenv("WHISPER_DEVICE", "cpu")
WHISPER_COMPUTE_TYPE = os.getenv("WHISPER_COMPUTE_TYPE", "int8")
WHISPER_LANGUAGE = normalize_optional_text(os.getenv("WHISPER_LANGUAGE"))
WHISPER_BEAM_SIZE = int(os.getenv("WHISPER_BEAM_SIZE", "5"))
WHISPER_BEST_OF = int(os.getenv("WHISPER_BEST_OF", "5"))
WHISPER_TEMPERATURE = float(os.getenv("WHISPER_TEMPERATURE", "0"))

model = WhisperModel(
    WHISPER_MODEL,
    device=WHISPER_DEVICE,
    compute_type=WHISPER_COMPUTE_TYPE,
)


class TranscribeRequest(BaseModel):
    sessionId: str
    seq: int
    sampleRate: int
    language: str | None = None
    initialPrompt: str | None = None
    pcm16MonoBase64: str


@app.get("/health")
def health():
    return {"status": "ok", "service": "whisper-worker"}


@app.post("/transcribe")
def transcribe(payload: TranscribeRequest):
    pcm_bytes = base64.b64decode(payload.pcm16MonoBase64)
    pcm_array = np.frombuffer(pcm_bytes, dtype=np.int16)
    requested_language = normalize_optional_text(payload.language) or WHISPER_LANGUAGE

    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as handle:
        audio_path = handle.name

    try:
        with wave.open(audio_path, "wb") as wav_file:
            wav_file.setnchannels(1)
            wav_file.setsampwidth(2)
            wav_file.setframerate(payload.sampleRate)
            wav_file.writeframes(pcm_array.tobytes())

        segments, info = model.transcribe(
            audio_path,
            language=requested_language,
            initial_prompt=payload.initialPrompt,
            beam_size=WHISPER_BEAM_SIZE,
            best_of=WHISPER_BEST_OF,
            temperature=WHISPER_TEMPERATURE,
            condition_on_previous_text=True,
            vad_filter=True,
        )

        text = " ".join(segment.text.strip() for segment in segments).strip()
        confidence = round(float(info.language_probability or 0.0), 3)

        return {
            "text": text,
            "confidence": confidence,
        }
    finally:
        if os.path.exists(audio_path):
            os.unlink(audio_path)
