"""
Decode one QQ SILK v3 voice file to WAV.

pysilk.decode emits raw 16-bit mono PCM, so this wraps it in a WAV header.

Usage: python silk-decode.py <input.silk|.amr> <output.wav>
"""
import io
import struct
import sys
import wave

import pysilk

RATE = 16000


def main() -> int:
    if len(sys.argv) != 3:
        print("usage: silk-decode.py <in> <out>", file=sys.stderr)
        return 2
    source, target = sys.argv[1], sys.argv[2]
    pcm = io.BytesIO()
    with open(source, "rb") as handle:
        pysilk.decode(handle, pcm, RATE)
    raw = pcm.getvalue()
    if not raw:
        print("decoded zero bytes", file=sys.stderr)
        return 1
    with wave.open(target, "wb") as out:
        out.setnchannels(1)
        out.setsampwidth(2)
        out.setframerate(RATE)
        out.writeframes(raw)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
