/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2023 Vendicated and Vencord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Web Worker for extracting raw encoded frames from WebRTC streams
 * Used by RTCRtpScriptTransform to intercept video/audio frames
 */

// Track type from transformer options
let trackKind = "unknown";

// Handle RTCRtpScriptTransform initialization
self.onrtctransform = (event) => {
    const { readable, writable } = event.transformer;
    const options = event.transformer.options || {};
    trackKind = options.kind || "unknown";

    console.log("[mpvStreamWorker] Transform started for track:", trackKind);

    // Create transform stream to intercept frames
    const transformStream = new TransformStream({
        transform(frame, controller) {
            try {
                // Extract frame data
                const frameData = new Uint8Array(frame.data);
                const timestamp = frame.timestamp;
                const metadata = frame.getMetadata ? frame.getMetadata() : {};

                // Determine frame type
                let isKeyFrame = false;
                if (trackKind === "video") {
                    // For video, check if it's a key frame
                    isKeyFrame = frame.type === "key";
                }

                // Send frame data to main thread
                self.postMessage({
                    kind: trackKind,
                    data: frameData,
                    timestamp: timestamp,
                    isKeyFrame: isKeyFrame,
                    metadata: metadata
                }, [frameData.buffer]); // Transfer buffer for performance

                // Pass frame through unchanged to Discord
                controller.enqueue(frame);
            } catch (e) {
                console.error("[mpvStreamWorker] Error processing frame:", e);
                // Still pass through the frame even on error
                controller.enqueue(frame);
            }
        },

        flush() {
            console.log("[mpvStreamWorker] Transform stream flushed");
            self.postMessage({ kind: trackKind, event: "flush" });
        }
    });

    // Pipe readable through transform to writable
    readable.pipeThrough(transformStream).pipeTo(writable).catch((err) => {
        console.error("[mpvStreamWorker] Pipe error:", err);
    });
};

// Handle messages from main thread (e.g., stop commands)
self.onmessage = (event) => {
    const { command } = event.data;
    console.log("[mpvStreamWorker] Received command:", command);
};
