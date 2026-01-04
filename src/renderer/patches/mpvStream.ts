/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2023 Vendicated and Vencord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Logger } from "@vencord/types/utils";
import { isLinux } from "renderer/utils";

const logger = new Logger("VesktopMpvStream");

if (isLinux) {
    // Track state
    let isWatchingStream = false;
    let streamCodec = "vp8";
    let mpvStarted = false;
    const videoWorkers = new Map<RTCRtpReceiver, Worker>();
    const audioWorkers = new Map<RTCRtpReceiver, Worker>();

    // Track videos we've disabled and their overlays
    const disabledVideos = new Map<HTMLVideoElement, HTMLDivElement>();
    let mpvStreamActive = false;
    let videoObserver: MutationObserver | null = null;

    function disableVideo(video: HTMLVideoElement) {
        if (disabledVideos.has(video)) return;

        logger.info("Disabling video element for mpv");
        video.pause();
        video.muted = true;
        video.style.visibility = "hidden";

        // Add text overlay
        const overlay = document.createElement("div");
        overlay.className = "vesktop-mpv-text";
        overlay.textContent = "Playing in mpv";
        overlay.style.cssText = `
            position: absolute;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            color: #dcddde;
            font-size: 18px;
            font-weight: 500;
            z-index: 100;
            pointer-events: none;
        `;

        const parent = video.parentElement;
        if (parent) {
            const parentStyle = getComputedStyle(parent);
            if (parentStyle.position === "static") {
                (parent as HTMLElement).style.position = "relative";
            }
            parent.appendChild(overlay);
        }

        disabledVideos.set(video, overlay);
    }

    function checkAndDisableVideos() {
        document.querySelectorAll("video").forEach(video => {
            const stream = video.srcObject as MediaStream | null;
            // Only target videos with streams (not just any video)
            if (stream?.getVideoTracks?.().length > 0) {
                disableVideo(video);
            }
        });
    }

    function disableDiscordStream() {
        mpvStreamActive = true;

        checkAndDisableVideos();

        // Watch for new video elements
        videoObserver = new MutationObserver(() => {
            if (mpvStreamActive) {
                checkAndDisableVideos();
            }
        });

        videoObserver.observe(document.body, {
            childList: true,
            subtree: true
        });

        // Check periodically for the first few seconds
        [100, 300, 500, 1000, 2000].forEach(ms => setTimeout(checkAndDisableVideos, ms));

        logger.info("Discord stream disabled for mpv");
    }

    function enableDiscordStream() {
        mpvStreamActive = false;

        if (videoObserver) {
            videoObserver.disconnect();
            videoObserver = null;
        }

        disabledVideos.forEach((overlay, video) => {
            logger.info("Restoring video element");
            overlay.remove();
            video.style.visibility = "";
            video.muted = false;
            video.play().catch(() => {});
        });
        disabledVideos.clear();

        logger.info("Discord stream restored");
    }

    // Create a worker for RTCRtpScriptTransform
    function createTransformWorker(kind: "video" | "audio"): Worker {
        // Worker code as blob URL (since we can't easily load from vesktop:// in workers)
        const workerCode = `
            let trackKind = "${kind}";

            self.onrtctransform = (event) => {
                const { readable, writable } = event.transformer;

                const transformStream = new TransformStream({
                    transform(frame, controller) {
                        try {
                            // Clone the data for sending (don't transfer - frame still needs it)
                            const frameData = new Uint8Array(frame.data).slice();
                            const timestamp = frame.timestamp;
                            let isKeyFrame = false;

                            if (trackKind === "video") {
                                isKeyFrame = frame.type === "key";
                            }

                            // Send copy to main thread, keep original for Discord
                            self.postMessage({
                                kind: trackKind,
                                data: frameData,
                                timestamp: timestamp,
                                isKeyFrame: isKeyFrame
                            }, [frameData.buffer]);

                            // Pass original frame through to Discord unchanged
                            controller.enqueue(frame);
                        } catch (e) {
                            controller.enqueue(frame);
                        }
                    }
                });

                readable.pipeThrough(transformStream).pipeTo(writable).catch(() => {});
            };
        `;

        const blob = new Blob([workerCode], { type: "application/javascript" });
        const worker = new Worker(URL.createObjectURL(blob), { name: `mpv-${kind}-transform` });

        worker.onmessage = async (event) => {
            const { kind: frameKind, data, timestamp, isKeyFrame } = event.data;

            if (!mpvStarted || !isWatchingStream) return;

            try {
                if (frameKind === "video") {
                    await VesktopNative.mpvStream.sendVideoFrame(data, isKeyFrame, timestamp);
                } else if (frameKind === "audio") {
                    await VesktopNative.mpvStream.sendAudioFrame(data, timestamp);
                }
            } catch (e) {
                logger.error("Failed to send frame:", e);
            }
        };

        return worker;
    }

    // Apply transform to a receiver
    function applyTransform(receiver: RTCRtpReceiver, kind: "video" | "audio") {
        if (!("transform" in receiver)) {
            logger.warn("RTCRtpReceiver.transform not supported");
            return;
        }

        const worker = createTransformWorker(kind);
        const workerMap = kind === "video" ? videoWorkers : audioWorkers;
        workerMap.set(receiver, worker);

        try {
            // @ts-expect-error RTCRtpScriptTransform is not in TypeScript types yet
            receiver.transform = new RTCRtpScriptTransform(worker, { kind });
            logger.info(`Applied ${kind} transform`);
        } catch (e) {
            logger.error(`Failed to apply ${kind} transform:`, e);
        }
    }

    // Detect codec from receiver parameters
    function detectCodec(receiver: RTCRtpReceiver): string {
        try {
            const params = receiver.getParameters();
            const codec = params.codecs?.[0];
            if (codec?.mimeType?.toLowerCase().includes("vp9")) return "vp9";
            if (codec?.mimeType?.toLowerCase().includes("vp8")) return "vp8";
            if (codec?.mimeType?.toLowerCase().includes("h264")) return "h264";
        } catch (e) {
            logger.warn("Failed to detect codec:", e);
        }
        return "vp8";
    }

    // Start mpv stream
    async function startMpvStream() {
        if (mpvStarted) return;

        logger.info("Starting mpv stream with codec:", streamCodec);
        const result = await VesktopNative.mpvStream.start(streamCodec);

        if (result.ok) {
            mpvStarted = true;
            disableDiscordStream();
            logger.info("mpv stream started");
        } else {
            logger.error("Failed to start mpv stream:", result.error);
        }
    }

    // Stop mpv stream
    async function stopMpvStream() {
        if (!mpvStarted) return;

        logger.info("Stopping mpv stream");
        await VesktopNative.mpvStream.stop();
        mpvStarted = false;
        enableDiscordStream();

        // Cleanup workers
        for (const worker of videoWorkers.values()) {
            worker.terminate();
        }
        for (const worker of audioWorkers.values()) {
            worker.terminate();
        }
        videoWorkers.clear();
        audioWorkers.clear();
    }

    // Store original RTCPeerConnection
    const OriginalRTCPeerConnection = window.RTCPeerConnection;

    // Override RTCPeerConnection to enable encoded insertable streams
    // @ts-expect-error Override
    window.RTCPeerConnection = class extends OriginalRTCPeerConnection {
        constructor(config?: RTCConfiguration) {
            // Enable encoded insertable streams
            const newConfig = {
                ...config,
                encodedInsertableStreams: true
            };

            super(newConfig);

            // Hook track event to apply transforms
            this.addEventListener("track", (event: RTCTrackEvent) => {
                if (!isWatchingStream) return;

                const { receiver, track } = event;
                const kind = track.kind as "video" | "audio";

                logger.info(`Track added: ${kind}`);

                // Detect codec from first video receiver
                if (kind === "video") {
                    streamCodec = detectCodec(receiver);
                    logger.info("Detected codec:", streamCodec);
                }

                // Apply transform
                applyTransform(receiver, kind);

                // Start mpv after we get the first video track
                if (kind === "video" && !mpvStarted) {
                    startMpvStream();
                }
            });
        }
    };

    // Copy static properties
    Object.setPrototypeOf(window.RTCPeerConnection, OriginalRTCPeerConnection);

    // Subscribe to Discord's Flux events once Vencord is ready
    // We need to wait for Discord to load before accessing FluxDispatcher
    const setupFluxSubscriptions = () => {
        try {
            const { FluxDispatcher, UserStore } = Vencord.Webpack.Common;

            if (!FluxDispatcher || !UserStore) {
                logger.warn("FluxDispatcher or UserStore not available yet");
                setTimeout(setupFluxSubscriptions, 1000);
                return;
            }

            // Stream watch event - when user starts watching a stream
            FluxDispatcher.subscribe("STREAM_WATCH", (event: { streamKey: string }) => {
                const { streamKey } = event;
                const parts = streamKey.split(":");
                const streamUserId = parts[parts.length - 1];
                const currentUserId = UserStore.getCurrentUser()?.id;

                // Only intercept other users' streams, not our own
                if (streamUserId === currentUserId) return;

                logger.info("Started watching stream:", streamKey);
                isWatchingStream = true;
            });

            // Stream close event
            FluxDispatcher.subscribe("STREAM_CLOSE", (event: { streamKey: string }) => {
                const { streamKey } = event;
                logger.info("Stream closed:", streamKey);
                isWatchingStream = false;
                stopMpvStream();
            });

            // Also handle stream stop/leave events
            FluxDispatcher.subscribe("STREAM_STOP", () => {
                logger.info("Stream stopped");
                isWatchingStream = false;
                stopMpvStream();
            });

            logger.info("Flux subscriptions set up");
        } catch (e) {
            logger.error("Failed to setup Flux subscriptions:", e);
            setTimeout(setupFluxSubscriptions, 1000);
        }
    };

    // Wait for Vencord to be ready
    if (typeof Vencord !== "undefined" && Vencord.Webpack?.Common) {
        setupFluxSubscriptions();
    } else {
        // Poll until Vencord is ready
        const checkVencord = setInterval(() => {
            if (typeof Vencord !== "undefined" && Vencord.Webpack?.Common) {
                clearInterval(checkVencord);
                setupFluxSubscriptions();
            }
        }, 100);
    }

    logger.info("mpvStream patch initialized");
}
