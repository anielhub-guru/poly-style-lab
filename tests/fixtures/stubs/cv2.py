"""Minimal OpenCV stand-in for tests: decodes with ffmpeg and exposes the few calls analyze_video.py uses."""
import re
import subprocess

import numpy as np

CAP_PROP_FPS, CAP_PROP_FRAME_WIDTH, CAP_PROP_FRAME_HEIGHT = 5, 3, 4
COLOR_BGR2GRAY, COLOR_BGR2RGB, INTER_AREA = 6, 4, 3
state = {"index": -1}  # lets the fake pose model know which frame it is "looking at"


class VideoCapture:
    def __init__(self, path):
        err = subprocess.run(["ffmpeg", "-hide_banner", "-i", str(path)], capture_output=True, text=True).stderr
        match = re.search(r", (\d{2,4})x(\d{2,4})", err)
        self.w, self.h = int(match.group(1)), int(match.group(2))
        self.proc = subprocess.Popen(["ffmpeg", "-loglevel", "error", "-i", str(path), "-f", "rawvideo", "-pix_fmt", "bgr24", "-"], stdout=subprocess.PIPE)

    def get(self, prop):
        return {5: 30.0, 3: float(self.w), 4: float(self.h)}[prop]

    def read(self):
        size = self.w * self.h * 3
        data = self.proc.stdout.read(size)
        if len(data) < size:
            return False, None
        state["index"] += 1
        return True, np.frombuffer(data, np.uint8).reshape(self.h, self.w, 3)

    def release(self):
        self.proc.kill()


def resize(frame, size, interpolation=None):
    width, height = size
    rows = np.linspace(0, frame.shape[0] - 1, height).astype(int)
    cols = np.linspace(0, frame.shape[1] - 1, width).astype(int)
    return frame[rows][:, cols]


def cvtColor(frame, code):
    return frame.mean(axis=2).astype(np.uint8) if code == COLOR_BGR2GRAY else frame
