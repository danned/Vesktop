/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2023 Vendicated and Vencord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { spawn, ChildProcess, execSync } from "child_process";
import { app, ipcMain } from "electron";
import { mkdtemp, rm } from "fs/promises";
import { createWriteStream, WriteStream } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { IpcEvents } from "../shared/IpcEvents";

let ffmpegProcess: ChildProcess | null = null;
let mpvProcess: ChildProcess | null = null;
let videoFifo: string | null = null;
let audioFifo: string | null = null;
let tempDir: string | null = null;
let videoStream: WriteStream | null = null;
let audioStream: WriteStream | null = null;
let ivfHeaderWritten = false;
let frameCount = 0;
let gotKeyFrame = false;
let detectedCodec = "unknown";

// IVF file header for VP8/VP9
function createIvfFileHeader(codec: string, width = 1920, height = 1080): Buffer {
    const header = Buffer.alloc(32);
    header.write("DKIF", 0); // Signature
    header.writeUInt16LE(0, 4); // Version
    header.writeUInt16LE(32, 6); // Header size
    header.write(codec === "vp9" ? "VP90" : "VP80", 8); // FourCC
    header.writeUInt16LE(width, 12);
    header.writeUInt16LE(height, 14);
    header.writeUInt32LE(30000, 16); // Framerate numerator
    header.writeUInt32LE(1000, 20); // Framerate denominator
    header.writeUInt32LE(0, 24); // Frame count (unknown)
    header.writeUInt32LE(0, 28); // Unused
    return header;
}

// IVF frame header
function createIvfFrameHeader(frameSize: number, timestamp: number): Buffer {
    const header = Buffer.alloc(12);
    header.writeUInt32LE(frameSize, 0);
    // Timestamp as 64-bit value - use BigInt for proper handling of large numbers
    const ts = BigInt(Math.max(0, Math.floor(timestamp / 1000))); // Convert to ms, ensure non-negative
    header.writeBigUInt64LE(ts, 4);
    return header;
}

async function cleanup() {
    if (videoStream) {
        videoStream.end();
        videoStream = null;
    }
    if (audioStream) {
        audioStream.end();
        audioStream = null;
    }
    if (ffmpegProcess) {
        ffmpegProcess.kill();
        ffmpegProcess = null;
    }
    if (mpvProcess) {
        mpvProcess.kill();
        mpvProcess = null;
    }
    if (tempDir) {
        try {
            await rm(tempDir, { recursive: true, force: true });
        } catch (e) {
            console.error("[mpvStream] Failed to cleanup temp dir:", e);
        }
        tempDir = null;
        videoFifo = null;
        audioFifo = null;
    }
    ivfHeaderWritten = false;
    frameCount = 0;
    gotKeyFrame = false;
    detectedCodec = "unknown";
}

// Detect codec from frame data
function detectCodecFromFrame(data: Uint8Array): string {
    // H.264 Annex B: starts with 00 00 00 01 or 00 00 01
    if ((data[0] === 0x00 && data[1] === 0x00 && data[2] === 0x00 && data[3] === 0x01) ||
        (data[0] === 0x00 && data[1] === 0x00 && data[2] === 0x01)) {
        return "h264";
    }
    // VP8 keyframe: bit 0 of first byte is 0, and has sync code 9d 01 2a at offset 3
    if ((data[0] & 0x01) === 0 && data[3] === 0x9d && data[4] === 0x01 && data[5] === 0x2a) {
        return "vp8";
    }
    // VP9: more complex detection, check for VP9 superframe marker
    if ((data[0] & 0x02) === 0) {
        return "vp9"; // Simplified check
    }
    return "unknown";
}

// Check if H.264 frame contains SPS (NAL type 7) or IDR (NAL type 5)
// These are the frame types we need to start decoding from
function isH264KeyFrame(data: Uint8Array): boolean {
    let i = 0;
    while (i < data.length - 4) {
        // Find start code (00 00 00 01 or 00 00 01)
        if (data[i] === 0x00 && data[i + 1] === 0x00) {
            let nalStart = -1;
            if (data[i + 2] === 0x01) {
                nalStart = i + 3;
            } else if (data[i + 2] === 0x00 && data[i + 3] === 0x01) {
                nalStart = i + 4;
            }

            if (nalStart > 0 && nalStart < data.length) {
                const nalType = data[nalStart] & 0x1f;
                // NAL type 5 = IDR slice, type 7 = SPS
                if (nalType === 5 || nalType === 7) {
                    return true;
                }
                i = nalStart;
                continue;
            }
        }
        i++;
    }
    return false;
}

async function startFfmpegAndMpv(codec: string) {
    if (!tempDir) {
        tempDir = await mkdtemp(join(tmpdir(), "vesktop-mpv-"));
    }

    // Determine file extension and ffmpeg input format based on codec
    let inputFormat: string;
    let fileExt: string;

    if (codec === "h264") {
        inputFormat = "h264";
        fileExt = "h264";
        videoFifo = join(tempDir, "video.h264");
    } else {
        inputFormat = "ivf";
        fileExt = "ivf";
        videoFifo = join(tempDir, "video.ivf");
    }

    // Create named pipe for video
    try {
        execSync(`mkfifo "${videoFifo}"`);
    } catch (e) {
        console.error("[mpvStream] Failed to create FIFO:", e);
        return false;
    }

    // Spawn ffmpeg with correct input format - low latency settings
    ffmpegProcess = spawn("ffmpeg", [
        "-fflags", "nobuffer",
        "-flags", "low_delay",
        "-f", inputFormat,
        "-i", videoFifo,
        "-c:v", "copy",
        "-f", "mpegts",
        "pipe:1"
    ], {
        stdio: ["ignore", "pipe", "pipe"]
    });

    ffmpegProcess.stderr?.on("data", (data: Buffer) => {
        console.log("[ffmpeg]", data.toString());
    });

    ffmpegProcess.on("error", (err) => {
        console.error("[mpvStream] ffmpeg error:", err);
    });

    ffmpegProcess.on("exit", (code) => {
        console.log("[mpvStream] ffmpeg exited with code:", code);
    });

    // Spawn mpv to play ffmpeg's output - low latency settings
    mpvProcess = spawn("mpv", [
        "--no-terminal",
        "--force-window=immediate",
        "--profile=low-latency",
        "--cache=no",
        "--demuxer-readahead-secs=0",
        "--title=Discord Stream",
        "-"
    ], {
        stdio: ["pipe", "inherit", "inherit"]
    });

    mpvProcess.on("error", (err) => {
        console.error("[mpvStream] mpv error:", err);
    });

    mpvProcess.on("exit", (code) => {
        console.log("[mpvStream] mpv exited with code:", code);
        cleanup();
    });

    // Pipe ffmpeg output to mpv input
    if (ffmpegProcess.stdout && mpvProcess.stdin) {
        ffmpegProcess.stdout.pipe(mpvProcess.stdin);
    }

    // Wait for ffmpeg to start, then open FIFO for writing
    await new Promise(resolve => setTimeout(resolve, 100));

    videoStream = createWriteStream(videoFifo);

    // For VP8/VP9, write IVF header; for H.264, write raw
    if (codec !== "h264") {
        const ivfHeader = createIvfFileHeader(codec);
        videoStream.write(ivfHeader);
    }

    ivfHeaderWritten = true;
    console.log("[mpvStream] Started ffmpeg/mpv with codec:", codec);
    return true;
}

ipcMain.handle(IpcEvents.MPV_STREAM_START, async (_, codec: string) => {
    try {
        await cleanup();
        console.log("[mpvStream] Initialized, waiting for first frame to detect codec (hint:", codec, ")");
        return { ok: true };
    } catch (e: any) {
        console.error("[mpvStream] Failed to start:", e);
        await cleanup();
        return { ok: false, error: e?.message || "Unknown error" };
    }
});

ipcMain.handle(
    IpcEvents.MPV_STREAM_VIDEO_FRAME,
    async (_, data: Uint8Array, isKeyFrame: boolean, timestamp: number) => {
        // Log first few frames regardless of type
        if (frameCount < 5) {
            console.log(`[mpvStream] Frame ${frameCount}: size=${data.length}, isKey=${isKeyFrame}`);
            console.log(`[mpvStream] First 16 bytes:`,
                Array.from(data.slice(0, 16)).map(b => b.toString(16).padStart(2, '0')).join(' '));
        }

        // On first frame, detect codec
        if (detectedCodec === "unknown") {
            detectedCodec = detectCodecFromFrame(data);
            console.log("[mpvStream] Detected codec from frame:", detectedCodec);
        }

        // Start ffmpeg/mpv if not already started
        if (!videoStream) {
            // For H.264, we need to start from a keyframe (SPS/IDR)
            // Don't rely on WebRTC's isKeyFrame - parse NAL units ourselves
            if (detectedCodec === "h264") {
                const isKey = isH264KeyFrame(data);
                if (!isKey) {
                    if (frameCount < 5) {
                        console.log("[mpvStream] Waiting for H.264 keyframe (SPS/IDR)...");
                    }
                    return true; // Wait for keyframe
                }
                console.log("[mpvStream] Found H.264 keyframe, starting ffmpeg/mpv");
            }

            console.log("[mpvStream] Starting ffmpeg/mpv with codec:", detectedCodec);
            const started = await startFfmpegAndMpv(detectedCodec);
            if (!started) {
                console.error("[mpvStream] Failed to start ffmpeg/mpv");
                return false;
            }
        }

        if (!videoStream || !ivfHeaderWritten) {
            return false;
        }

        try {
            const frameData = Buffer.from(data);

            // For H.264, write raw data; for VP8/VP9, add IVF frame header
            if (detectedCodec === "h264") {
                videoStream.write(frameData);
            } else {
                const frameHeader = createIvfFrameHeader(frameData.length, timestamp);
                videoStream.write(frameHeader);
                videoStream.write(frameData);
            }

            frameCount++;

            if (frameCount <= 5 || frameCount % 100 === 0) {
                console.log(`[mpvStream] Frame ${frameCount}: size=${frameData.length}, key=${isKeyFrame}`);
            }

            return true;
        } catch (e) {
            console.error("[mpvStream] Failed to write video frame:", e);
            return false;
        }
    }
);

ipcMain.handle(IpcEvents.MPV_STREAM_AUDIO_FRAME, async (_, data: Uint8Array, _timestamp: number) => {
    if (!audioStream) {
        return false;
    }

    try {
        // Opus frames can be written directly
        audioStream.write(Buffer.from(data));
        return true;
    } catch (e) {
        console.error("[mpvStream] Failed to write audio frame:", e);
        return false;
    }
});

ipcMain.handle(IpcEvents.MPV_STREAM_STOP, async () => {
    console.log("[mpvStream] Stopping, frames written:", frameCount);
    await cleanup();
});

// Cleanup on app quit
app.on("before-quit", cleanup);
