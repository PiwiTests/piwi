"""Reads each line of a job with Kokoro, the model loaded once.

The job, JSON on stdin: the model's and the voices' files (`model`, `voices`), the voice, its speed and language, and
the lines, each a text and the WAV file its reading goes in (16-bit mono, at the model's rate). `lib/voice.mjs` writes
the job and reads the files' lengths back.
"""

import json
import sys
import wave

import numpy as np
from kokoro_onnx import Kokoro

job = json.load(sys.stdin)
kokoro = Kokoro(job["model"], job["voices"])
for line in job["lines"]:
    samples, rate = kokoro.create(line["text"], voice=job["voice"], speed=job["speed"], lang=job["lang"])
    pcm = (np.clip(samples, -1.0, 1.0) * 32767).astype("<i2")
    with wave.open(line["file"], "wb") as out:
        out.setnchannels(1)
        out.setsampwidth(2)
        out.setframerate(rate)
        out.writeframes(pcm.tobytes())
