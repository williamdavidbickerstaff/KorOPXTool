// Records the canvas straight to an MP4 file, using the browser's own H.264
// encoder (WebCodecs) and mp4-muxer to package it. This works in browsers
// whose built-in recorder only makes WebM, and gives a standard MP4 that
// editors and social apps accept, rather than the fragmented kind Chrome's
// recorder writes

function canEncodeMp4() {
  return (
    typeof VideoEncoder !== "undefined" &&
    typeof VideoFrame !== "undefined" &&
    typeof Mp4Muxer !== "undefined"
  );
}

// H.264 profiles and levels to try, most capable first. Higher levels allow
// bigger frames at higher frame rates (5.2 covers 4K at 60 fps); the first
// one the browser accepts at this size is used
const AVC_CODECS = [
  "avc1.640034", // High 5.2
  "avc1.4d0034", // Main 5.2
  "avc1.420034", // Baseline 5.2
  "avc1.640033", // High 5.1
  "avc1.64002a", // High 4.2
  "avc1.640028", // High 4.0
  "avc1.42001f", // Baseline 3.1
];

// The first encoder setup this browser supports for this size, or null
async function findAvcConfig(width, height, fps, bitrate) {
  for (const codec of AVC_CODECS) {
    const config = {
      codec,
      width,
      height,
      bitrate,
      framerate: fps,
      avc: { format: "avc" },
    };
    try {
      const { supported } = await VideoEncoder.isConfigSupported(config);
      if (supported) {
        return config;
      }
    } catch (error) {
      // Some browsers throw for codec strings they don't know; try the next
    }
  }
  return null;
}

// Start encoding. Call capture() after every frame is drawn, and finish()
// to get the MP4 as a Blob
function createMp4Recorder(canvas, config, onError) {
  const fps = config.framerate;
  const muxer = new Mp4Muxer.Muxer({
    target: new Mp4Muxer.ArrayBufferTarget(),
    video: {
      codec: "avc",
      width: config.width,
      height: config.height,
      frameRate: fps,
    },
    // Put the index at the front so the file plays before it's fully loaded
    fastStart: "in-memory",
    firstTimestampBehavior: "offset",
  });

  let failed = null;
  let finishing = false;
  const encoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (error) => {
      failed = error;
      onError(error);
    },
  });
  encoder.configure(config);

  // Microseconds per frame, and a keyframe every two seconds so the video
  // can be scrubbed through
  const frameDuration = 1e6 / fps;
  const keyFrameEvery = Math.round(fps * 2);
  const startedAt = performance.now();
  let framesEncoded = 0;
  let lastSlot = -1;

  return {
    capture() {
      if (failed || finishing || encoder.state !== "configured") {
        return;
      }

      // Place each frame on the frame-rate grid by real time, so the video
      // plays at the speed it was drawn even if the browser dropped frames.
      // Skip frames drawn faster than the chosen frame rate
      const slot = Math.round(
        ((performance.now() - startedAt) * 1000) / frameDuration,
      );
      if (slot <= lastSlot) {
        return;
      }
      // If the encoder falls behind (huge sizes on a slow machine), drop
      // frames rather than let them pile up in memory
      if (encoder.encodeQueueSize > 4) {
        return;
      }

      const frame = new VideoFrame(canvas, {
        timestamp: slot * frameDuration,
        duration: frameDuration,
      });
      encoder.encode(frame, { keyFrame: framesEncoded % keyFrameEvery === 0 });
      frame.close();

      framesEncoded++;
      lastSlot = slot;
    },

    async finish() {
      finishing = true;
      if (!failed) {
        await encoder.flush();
      }
      if (encoder.state !== "closed") {
        encoder.close();
      }
      if (failed || framesEncoded === 0) {
        return null;
      }
      muxer.finalize();
      return new Blob([muxer.target.buffer], { type: "video/mp4" });
    },
  };
}
