# Notes for agents

## MediaMTX "decode errors" are known noise

`[path cam-3] [RTSP source] 13 decode errors`, about once a second on most
cameras, is harmless. The cameras slip vendor packets with an undeclared
RTP payload type (50) into the video stream; MediaMTX drops them and no
video is lost. Don't spend time on it, and don't restart or reconfigure
MediaMTX to quiet it: that costs footage on every camera. How to tell it
from a real problem: "Reading the recorder's log" in `docs/FORK_DEPLOY.md`.
