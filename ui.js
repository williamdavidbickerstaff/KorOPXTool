// Builds the settings panel from SETTINGS, loads pictures and handles
// recording. The sketch calls initUI() once, from setup()

const STORAGE_KEY = "bigk-tool-settings";
// The picture each effect starts with, until you load your own
const DEFAULT_IMAGES = {
  tiles: "assets/K.png",
  lines: "assets/K.png",
  outline: "assets/K.png",
};
const DEFAULT_TILE = "assets/K.png";

// Recording formats this browser can actually make, best first
const FORMATS = detectFormats();

// key → { item, wrap, sync } for every control in the panel
const controls = {};
// { group, section } for every collapsible section
const sections = [];
// The built-in K tile and the last uploaded tile, once loaded
let kTile = null;
let customTile = null;
// The last built-in tile in use, to fall back on if an upload is cancelled
let lastShape = "k";
// The current recording, or null when not recording
let recording = null;
let recordTimer = null;
let saveTimer = null;
let toastTimer = null;

function initUI() {
  loadSavedSettings();
  buildControls();
  wireButtons();
  wireDragAndDrop();
  wireKeyboard();
  updateVisibility();

  onTileShapeChanged();
  onEffectChanged();
  onSourceChanged();

  setInterval(updateInfo, 500);
}

// ---------------------------------------------------------------- settings

function allItems() {
  return SETTINGS.flatMap((group) => group.items);
}

function defaultSettings() {
  return Object.fromEntries(allItems().map((item) => [item.key, item.value]));
}

// Copy over any saved values that still make sense
function assignSettings(saved) {
  for (const item of allItems()) {
    const value = saved?.[item.key];
    if (value !== undefined && typeof value === typeof item.value) {
      params[item.key] = value;
    }
  }

  // Uploaded tiles aren't saved, and recording formats differ per browser
  if (params.tileShape === "custom" && !customTile) {
    params.tileShape = "k";
  }
  if (!FORMATS.some((f) => f.id === params.format)) {
    params.format = FORMATS[0]?.id ?? "";
  }
}

function loadSavedSettings() {
  try {
    assignSettings(JSON.parse(localStorage.getItem(STORAGE_KEY)));
  } catch (error) {
    assignSettings({});
  }
}

function saveSettings() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(params));
    } catch (error) {
      // Private windows can refuse storage; settings just won't persist
    }
  }, 300);
}

// Replace every setting at once, from a preset or a reset
function applySettings(values) {
  const oldShape = params.tileShape;
  const oldEffect = params.effect;
  assignSettings(values);

  for (const control of Object.values(controls)) {
    control.sync();
  }
  updateVisibility();

  dirty.size = dirty.grid = dirty.tiles = true;
  if (params.tileShape !== oldShape) {
    onTileShapeChanged();
  }
  if (params.effect !== oldEffect) {
    onEffectChanged();
  }
  saveSettings();
}

// Store a new value from a control and flag whatever it invalidates
function setParam(item, value) {
  params[item.key] = value;

  if (item.rebuild) {
    dirty[item.rebuild] = true;
  }
  if (item.key === "tileShape") {
    onTileShapeChanged();
  }
  if (item.key === "effect") {
    onEffectChanged();
  }

  updateVisibility();
  saveSettings();
}

// Whether a group or item belongs to the chosen effect (or to both)
function forEffect(groupOrItem) {
  return !groupOrItem.effect || groupOrItem.effect === params.effect;
}

function updateVisibility() {
  for (const { group, section } of sections) {
    section.hidden = !forEffect(group);
  }
  for (const { item, wrap } of Object.values(controls)) {
    wrap.hidden = !forEffect(item) || (item.showIf && !item.showIf(params));
  }
}

// ---------------------------------------------------------------- panel

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) {
    node.className = className;
  }
  if (text !== undefined) {
    node.textContent = text;
  }
  return node;
}

function button(label, onClick, className = "btn") {
  const node = el("button", className, label);
  node.type = "button";
  node.addEventListener("click", onClick);
  return node;
}

const OPEN_GROUPS = [
  "Source",
  "Canvas",
  "Colours",
  "Lines",
  "Line colours",
  "Outline",
  "Outline glitch",
  "Outline colours",
];

function buildControls() {
  const container = document.getElementById("controls");

  for (const group of SETTINGS) {
    if (group.bare) {
      const top = document.getElementById("top-controls");
      for (const item of group.items) {
        top.append(makeControl(item));
      }
      continue;
    }

    const section = el("details", "group");
    sections.push({ group, section });
    section.open = OPEN_GROUPS.includes(group.group);
    section.dataset.group = group.group;
    section.append(el("summary", "", group.group));

    const body = el("div", "group-body");
    section.append(body);

    if (group.group === "Tile") {
      body.append(
        button("Upload tile image…", () =>
          document.getElementById("tile-input").click(),
        ),
      );
    }
    if (group.palettes) {
      body.append(makePalettes());
    }
    if (group.recorder) {
      const formatItem = group.items.find((item) => item.key === "format");
      formatItem.options = FORMATS.map((f) => [f.id, f.label]);
    }

    for (const item of group.items) {
      body.append(makeControl(item));
    }

    if (group.recorder) {
      if (FORMATS.length === 0) {
        body.append(
          el(
            "p",
            "note",
            "This browser can't record video. Try Chrome, Edge, Firefox or Safari.",
          ),
        );
      }
      const takes = el("div", "takes");
      takes.id = "takes";
      takes.append(el("p", "note", "Recordings appear here."));
      body.append(takes);
    }

    container.append(section);
  }

  container.append(makePresetSection());
}

function makeControl(item) {
  const wrap = el("div", `control control-${item.type}`);
  const id = `c-${item.key}`;
  let sync;

  if (item.help) {
    wrap.title = item.help;
  }

  const label = el("label", "", item.label);
  label.htmlFor = id;

  if (item.type === "checkbox") {
    const input = el("input");
    input.type = "checkbox";
    input.id = id;
    input.addEventListener("change", () => setParam(item, input.checked));
    sync = () => (input.checked = params[item.key]);
    wrap.append(input, label);
  } else if (item.type === "range") {
    const range = el("input");
    range.type = "range";
    range.id = id;
    const number = el("input", "number");
    number.type = "number";
    number.setAttribute("aria-label", item.label);
    for (const input of [range, number]) {
      input.min = item.min;
      input.max = item.max;
      input.step = item.step;
    }

    range.addEventListener("input", () => {
      number.value = range.value;
      setParam(item, parseFloat(range.value));
    });
    number.addEventListener("change", () => {
      const value = constrain(
        parseFloat(number.value) || 0,
        item.min,
        item.max,
      );
      number.value = range.value = value;
      setParam(item, value);
    });
    sync = () => (range.value = number.value = params[item.key]);

    const row = el("div", "row");
    row.append(range, number);
    wrap.append(label, row);
  } else if (item.type === "number") {
    const number = el("input", "number wide");
    number.type = "number";
    number.id = id;
    number.min = item.min;
    number.max = item.max;
    number.step = item.step;
    number.addEventListener("change", () => {
      const value = Math.round(
        constrain(parseFloat(number.value) || item.value, item.min, item.max),
      );
      number.value = value;
      setParam(item, value);
    });
    sync = () => (number.value = params[item.key]);
    wrap.append(label, number);
  } else if (item.type === "colour") {
    const picker = el("input");
    picker.type = "color";
    picker.id = id;
    const hex = el("input", "hex");
    hex.type = "text";
    hex.spellcheck = false;
    hex.setAttribute("aria-label", `${item.label} hex`);

    picker.addEventListener("input", () => {
      hex.value = picker.value.toUpperCase();
      setParam(item, hex.value);
    });
    hex.addEventListener("change", () => {
      const value = normaliseHex(hex.value);
      if (value) {
        picker.value = value.toLowerCase();
        setParam(item, value);
      }
      hex.value = params[item.key];
    });
    sync = () => {
      hex.value = params[item.key];
      picker.value = params[item.key].toLowerCase();
    };

    const row = el("div", "row");
    row.append(picker, hex);
    wrap.append(label, row);
  } else if (item.type === "select") {
    const select = el("select");
    select.id = id;
    for (const [value, text] of item.options) {
      const option = el("option", "", text);
      option.value = value;
      select.append(option);
    }
    select.addEventListener("change", () => setParam(item, select.value));
    sync = () => (select.value = params[item.key]);
    wrap.append(label, select);
  } else if (item.type === "segmented") {
    const options = el("div", "segmented");
    options.setAttribute("role", "group");
    options.setAttribute("aria-label", item.label);
    const buttons = item.options.map(([value, text]) => {
      const option = button(text, () => {
        setParam(item, value);
        sync();
      });
      option.dataset.value = value;
      options.append(option);
      return option;
    });
    sync = () => {
      for (const option of buttons) {
        option.setAttribute(
          "aria-pressed",
          option.dataset.value === params[item.key],
        );
      }
    };
    wrap.append(el("span", "label", item.label), options);
  } else if (item.type === "text") {
    const input = el("input", "text");
    input.type = "text";
    input.id = id;
    input.spellcheck = false;
    input.addEventListener("input", () => setParam(item, input.value));
    sync = () => (input.value = params[item.key]);
    wrap.append(label, input);
  }

  sync();
  controls[item.key] = { item, wrap, sync };
  return wrap;
}

// "#f05" or "FF0055" → "#FF0055", or null if it isn't a colour
function normaliseHex(text) {
  let hex = String(text).trim().replace(/^#/, "");
  if (/^[0-9a-f]{3}$/i.test(hex)) {
    hex = [...hex].map((c) => c + c).join("");
  }
  return /^[0-9a-f]{6}$/i.test(hex) ? `#${hex.toUpperCase()}` : null;
}

function makePalettes() {
  const wrap = el("div", "palettes");
  const chips = el("div", "chips");

  for (const palette of PALETTES) {
    const chip = button("", () => applyPalette(palette), "chip");
    chip.title = palette.name;
    chip.setAttribute("aria-label", `${palette.name} palette`);
    chip.style.setProperty("--bg", palette.background);
    chip.style.setProperty("--fg", palette.tile);
    chip.style.setProperty("--gl", palette.glitch);
    chip.append(el("span"), el("span"), el("span"));
    chips.append(chip);
  }

  const actions = el("div", "row");
  actions.append(
    button("Swap colours", () => {
      const [background, ink] = paletteKeys();
      applyPalette({
        background: params[ink],
        tile: params[background],
        glitch: params.glitchColour,
      });
    }),
    button("Random", () => applyPalette(randomPalette())),
  );

  wrap.append(chips, actions);
  return wrap;
}

// The background and foreground colour settings of the chosen effect
function paletteKeys() {
  return {
    tiles: ["backgroundColour", "tileColour"],
    lines: ["linesBackground", "linesInk"],
    outline: ["outlineBackground", "outlineLine"],
  }[params.effect];
}

// Palettes recolour whichever effect is showing: Lines and Outline take
// the background and tile colours as their background and lines, and
// Outline's echo goes halfway between the two
function applyPalette(palette) {
  const [background, ink] = paletteKeys();
  const values = {
    ...params,
    [background]: palette.background,
    [ink]: palette.tile,
  };
  if (params.effect === "tiles") {
    values.glitchColour = palette.glitch;
    values.dotMatchesTile = true;
  }
  if (params.effect === "outline") {
    values.outlineEcho = mixHex(palette.background, palette.tile, 0.5);
  }
  applySettings(values);
}

// The colour a fraction t of the way from hex colour a to b
function mixHex(a, b, t) {
  const channel = (hex, i) => parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16);
  const mixed = [0, 1, 2].map((i) =>
    Math.round(channel(a, i) + (channel(b, i) - channel(a, i)) * t)
      .toString(16)
      .padStart(2, "0"),
  );
  return `#${mixed.join("")}`.toUpperCase();
}

// A dark background with a bright tile and a contrasting ghost, or now and
// then the same thing flipped light
function randomPalette() {
  const hue = Math.random() * 360;
  const tile = hslToHex(hue, 0.85, 0.65);
  const glitch = hslToHex(hue + 150 + Math.random() * 60, 0.75, 0.4);
  const dark = hslToHex(hue, 0.3, 0.05);
  const light = hslToHex(hue, 0.25, 0.9);

  return Math.random() < 0.25
    ? { background: light, tile: hslToHex(hue, 0.7, 0.2), glitch }
    : { background: dark, tile, glitch };
}

function hslToHex(h, s, l) {
  const f = (n) => {
    const k = (n + h / 30) % 12;
    const c =
      l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(c * 255)
      .toString(16)
      .padStart(2, "0");
  };
  return `#${f(0)}${f(8)}${f(4)}`.toUpperCase();
}

function makePresetSection() {
  const section = el("details", "group");
  section.append(el("summary", "", "Presets"));
  const body = el("div", "group-body");
  const grid = el("div", "button-grid");

  grid.append(
    button("Save preset", savePreset),
    button("Load preset…", () =>
      document.getElementById("preset-input").click(),
    ),
    button("Copy as code", copyAsCode),
    button("Reset all", () => {
      applySettings(defaultSettings());
      showMessage("Settings reset.");
    }),
  );

  body.append(
    grid,
    el(
      "p",
      "note",
      "Settings are remembered in this browser. “Copy as code” gives constants you can paste into the original sketch.",
    ),
  );
  section.append(body);
  return section;
}

function savePreset() {
  const blob = new Blob([JSON.stringify(params, null, 2)], {
    type: "application/json",
  });
  download(blob, `bigk-preset-${timestamp()}.json`);
}

async function loadPreset(file) {
  try {
    applySettings({ ...defaultSettings(), ...JSON.parse(await file.text()) });
    showMessage(`Loaded ${file.name}.`);
  } catch (error) {
    showMessage("That file isn't a BigK preset.");
  }
}

// The chosen effect's settings as constants, in the style of the
// original sketches
function copyAsCode() {
  const effectName = controls.effect.item.options.find(
    ([value]) => value === params.effect,
  )[1];
  const lines = [`// ${effectName} settings from the BigK tool`];

  for (const group of SETTINGS) {
    for (const item of group.items) {
      if (!item.name || !forEffect(group) || !forEffect(item)) {
        continue;
      }

      let value = params[item.key];
      if (item.key === "dotColour" && params.dotMatchesTile) {
        value = "FILL_COLOUR";
      } else if (item.key === "revealResolutions") {
        value = `[${parseResolutions(value).join(", ")}]`;
      } else if (typeof value === "string") {
        value = JSON.stringify(value);
      }
      lines.push(`const ${item.name} = ${value};`);
    }
  }

  const text = lines.join("\n");
  navigator.clipboard
    .writeText(text)
    .then(() => showMessage("Copied settings as code."))
    .catch(() => {
      download(new Blob([text], { type: "text/javascript" }), "settings.js");
    });
}

// ---------------------------------------------------------------- sources

function wireButtons() {
  const mediaInput = document.getElementById("media-input");
  const tileInput = document.getElementById("tile-input");
  const presetInput = document.getElementById("preset-input");

  for (const id of ["upload-btn", "empty-upload-btn"]) {
    document
      .getElementById(id)
      .addEventListener("click", () => mediaInput.click());
  }
  for (const id of ["webcam-btn", "empty-webcam-btn"]) {
    document.getElementById(id).addEventListener("click", toggleWebcam);
  }

  mediaInput.addEventListener("change", () => {
    if (mediaInput.files[0]) {
      loadMediaFile(mediaInput.files[0]);
    }
    mediaInput.value = "";
  });
  tileInput.addEventListener("change", () => {
    if (tileInput.files[0]) {
      loadTileFile(tileInput.files[0]);
    }
    tileInput.value = "";
  });
  presetInput.addEventListener("change", () => {
    if (presetInput.files[0]) {
      loadPreset(presetInput.files[0]);
    }
    presetInput.value = "";
  });

  document.getElementById("play-btn").addEventListener("click", () => {
    const video = source?.el;
    if (video instanceof HTMLVideoElement) {
      video.paused ? video.play() : video.pause();
      onSourceChanged();
    }
  });

  toolbarButton("reveal-btn", replayReveal);
  toolbarButton("record-btn", toggleRecording);
  toolbarButton("snapshot-btn", snapshot);
  toolbarButton("panel-btn", togglePanel);
}

// Toolbar buttons let go of focus after a mouse click, so Space and R keep
// working as shortcuts instead of pressing the button again
function toolbarButton(id, onClick) {
  const node = document.getElementById(id);
  node.addEventListener("click", (event) => {
    onClick();
    if (event.detail > 0) {
      node.blur();
    }
  });
}

// Show the chosen effect's starting picture, unless you've loaded your own
function loadDefaultImage() {
  const effect = params.effect;
  const path = DEFAULT_IMAGES[effect];
  if (source?.isDefault && source.el.src.endsWith(path)) {
    return;
  }

  const img = new Image();
  img.onload = () => {
    if ((!source || source.isDefault) && params.effect === effect) {
      setSource({
        el: img,
        kind: "image",
        name: path.split("/").pop(),
        isDefault: true,
      });
    }
  };
  img.src = path;
}

// Called when switching between effects
function onEffectChanged() {
  const tiles = params.effect === "tiles";

  if (!source || source.isDefault) {
    loadDefaultImage();
  }
  // Only Tiles has the reveal and hover glitch
  document.getElementById("reveal-btn").hidden = !tiles;
  document.getElementById("hint").hidden = !tiles;
  controls.effect.sync();
  updateVisibility();
}

function loadMediaFile(file) {
  const url = URL.createObjectURL(file);

  if (file.type.startsWith("video/")) {
    const video = makeVideo();
    video.src = url;
    video.play().catch(() => {});
    setSource({ el: video, kind: "video", name: file.name, url });
    setMirror(false);
  } else if (file.type.startsWith("image/")) {
    const img = new Image();
    img.onload = () => {
      setSource({ el: img, kind: "image", name: file.name, url });
      setMirror(false);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      showMessage(`Couldn't open ${file.name}.`);
    };
    img.src = url;
  } else {
    URL.revokeObjectURL(url);
    showMessage("Drop an image or a video file.");
  }
}

async function toggleWebcam() {
  if (source?.kind === "webcam") {
    setSource(null);
    return;
  }

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });
    const video = makeVideo();
    video.srcObject = stream;
    await video.play();
    setSource({ el: video, kind: "webcam", name: "Webcam", stream });
    setMirror(true);
  } catch (error) {
    showMessage(webcamError(error));
  }
}

function webcamError(error) {
  if (!window.isSecureContext || !navigator.mediaDevices) {
    return "The webcam only works on https:// or localhost — not from a file or a network address.";
  }
  switch (error.name) {
    case "NotAllowedError":
      return "Camera access was blocked. Allow it from the icon in the address bar, and on a Mac in System Settings → Privacy & Security → Camera.";
    case "NotFoundError":
    case "OverconstrainedError":
      return "No camera was found.";
    case "NotReadableError":
      return "The camera is busy — close any other app or tab using it and try again.";
    default:
      return `Couldn't open the webcam (${error.message || error.name}).`;
  }
}

// Videos live in a hidden holder on the page; some browsers stop decoding
// videos that aren't in the document
function makeVideo() {
  const video = el("video");
  video.muted = true;
  video.loop = true;
  video.playsInline = true;
  video.autoplay = true;
  video.addEventListener("loadedmetadata", () => {
    if (params.size === "source") {
      dirty.size = true;
    }
    onSourceChanged();
  });
  document.getElementById("video-holder").append(video);
  return video;
}

function setMirror(on) {
  params.mirror = on;
  controls.mirror.sync();
  saveSettings();
}

// Called by the sketch whenever the source changes
function onSourceChanged() {
  const name = document.getElementById("source-name");
  const size = source && sourceSize(source);
  const play = document.getElementById("play-btn");
  const isVideo = source?.kind === "video";

  name.textContent = source
    ? `${source.name}${size ? ` · ${size.w} × ${size.h}` : ""}`
    : "No source";
  play.hidden = !isVideo;
  play.textContent = isVideo && source.el.paused ? "Play" : "Pause";
  document.getElementById("webcam-btn").textContent =
    source?.kind === "webcam" ? "Stop webcam" : "Webcam";
  document.getElementById("empty").hidden = !!source;
  // Images and video each show their own threshold
  updateVisibility();
}

// ---------------------------------------------------------------- tiles

function loadTileFile(file) {
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.onload = () => {
    customTile = img;
    params.tileShape = "custom";
    controls.tileShape.sync();
    setTileSource(img);
    saveSettings();
  };
  img.onerror = () => showMessage(`Couldn't open ${file.name}.`);
  img.src = url;
}

// Called when the Tile setting changes, and by the sketch if a tile
// picture can't be read
function onTileShapeChanged() {
  const shape = params.tileShape;

  if (shape === "custom") {
    if (customTile) {
      setTileSource(customTile);
    } else {
      // Nothing uploaded yet: ask for a picture, and keep the current tile
      // until one arrives
      params.tileShape = lastShape;
      controls.tileShape.sync();
      document.getElementById("tile-input").click();
    }
    return;
  }

  lastShape = shape;
  if (shape === "k") {
    if (kTile) {
      setTileSource(kTile);
    } else {
      const img = new Image();
      img.onload = () => {
        kTile = img;
        if (params.tileShape === "k") {
          setTileSource(img);
        }
      };
      img.onerror = () => {
        params.tileShape = "square";
        controls.tileShape.sync();
        onTileShapeChanged();
      };
      img.src = DEFAULT_TILE;
    }
  } else {
    setTileSource(drawShape(shape));
  }

  controls.tileShape?.sync();
}

// A white shape on a transparent square, for the built-in tiles
function drawShape(shape) {
  const size = 256;
  const canvas = el("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff";

  if (shape === "circle") {
    ctx.beginPath();
    ctx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2);
    ctx.fill();
  } else if (shape === "plus") {
    const t = size / 3;
    ctx.fillRect(t, 0, t, size);
    ctx.fillRect(0, t, size, t);
  } else if (shape === "diamond") {
    ctx.beginPath();
    ctx.moveTo(size / 2, 0);
    ctx.lineTo(size, size / 2);
    ctx.lineTo(size / 2, size);
    ctx.lineTo(0, size / 2);
    ctx.fill();
  } else {
    ctx.fillRect(0, 0, size, size);
  }

  return canvas;
}

// ---------------------------------------------------------------- recording

// Recording formats this browser can make. MP4 comes from the WebCodecs
// encoder in mp4.js where possible, otherwise the built-in recorder; WebM
// always uses the built-in recorder
function detectFormats() {
  const recorderMime = (mimes) =>
    typeof MediaRecorder === "undefined"
      ? undefined
      : mimes.find((m) => MediaRecorder.isTypeSupported(m));

  const candidates = [
    {
      id: "mp4",
      label: "MP4 (H.264)",
      ext: "mp4",
      webCodecs: canEncodeMp4(),
      mime: recorderMime([
        "video/mp4;codecs=avc1.640033",
        "video/mp4;codecs=avc1",
        "video/mp4",
      ]),
    },
    {
      id: "webm-vp9",
      label: "WebM (VP9)",
      ext: "webm",
      mime: recorderMime(["video/webm;codecs=vp9"]),
    },
    {
      id: "webm-vp8",
      label: "WebM (VP8)",
      ext: "webm",
      mime: recorderMime(["video/webm;codecs=vp8", "video/webm"]),
    },
  ];

  return candidates.filter((format) => format.webCodecs || format.mime);
}

function isRecording() {
  return recording !== null;
}

function toggleRecording() {
  if (recording) {
    stopRecording();
  } else {
    startRecording();
  }
}

// Called by the sketch after every frame, so the MP4 encoder gets each
// finished frame
function onFrameDrawn() {
  recording?.capture?.();
}

async function startRecording() {
  const format = FORMATS.find((f) => f.id === params.format) ?? FORMATS[0];
  if (!format) {
    showMessage(
      "This browser can't record video. Try Chrome, Edge, Firefox or Safari.",
    );
    return;
  }

  // Claim the slot straight away, so a second press while the encoder is
  // being set up doesn't start another recording
  recording = { pending: true };
  const canvas = document.querySelector("#stage canvas");
  const fps = Number(params.fps);
  const bitrate = params.bitrate * 1e6;

  let config = null;
  if (format.webCodecs) {
    config = await findAvcConfig(width, height, fps, bitrate);
  }
  if (!config && !format.mime) {
    recording = null;
    showMessage(
      `This browser can't encode ${format.label} at ${width} × ${height}. Try a smaller output size, or WebM.`,
    );
    return;
  }

  const onError = (error) => {
    showMessage(`Recording failed (${error?.message ?? "unknown error"}).`);
    stopRecording();
  };

  let recorder;
  try {
    recorder = config
      ? createMp4Recorder(canvas, config, onError)
      : createStreamRecorder(canvas, format, fps, bitrate, onError);
  } catch (error) {
    recording = null;
    showMessage(`Couldn't start recording (${error.message}).`);
    return;
  }

  if (params.revealOnRecord) {
    replayReveal();
  }
  if (params.restartOnRecord && source?.kind === "video") {
    source.el.currentTime = 0;
    source.el.play().catch(() => {});
  }

  recording = {
    ...recorder,
    format,
    w: width,
    h: height,
    startedAt: performance.now(),
  };
  setRecordingUI(true);
}

async function stopRecording() {
  if (!recording || recording.pending || recording.stopping) {
    return;
  }

  const take = recording;
  take.stopping = true;
  const seconds = (performance.now() - take.startedAt) / 1000;
  setRecordingUI(false);
  document.getElementById("rec-time").textContent = "Saving…";

  try {
    const blob = await take.finish();
    if (blob && blob.size > 0) {
      addTake(blob, take, seconds);
    }
  } catch (error) {
    showMessage(`Couldn't save the recording (${error.message}).`);
  } finally {
    recording = null;
    document.getElementById("rec-time").textContent = "";
  }
}

// The browser's built-in recorder, which records the canvas as a stream.
// Used for WebM, and for MP4 where WebCodecs isn't available
function createStreamRecorder(canvas, format, fps, bitrate, onError) {
  const stream = canvas.captureStream(fps);
  const chunks = [];
  let recorder;

  try {
    recorder = new MediaRecorder(stream, {
      mimeType: format.mime,
      videoBitsPerSecond: bitrate,
    });
  } catch (error) {
    stream.getTracks().forEach((track) => track.stop());
    throw error;
  }

  recorder.ondataavailable = (event) => {
    if (event.data.size > 0) {
      chunks.push(event.data);
    }
  };
  recorder.onerror = (event) => onError(event.error);
  recorder.start(1000);

  return {
    finish() {
      return new Promise((resolve) => {
        recorder.onstop = () => {
          stream.getTracks().forEach((track) => track.stop());
          resolve(new Blob(chunks, { type: format.mime.split(";")[0] }));
        };
        recorder.stop();
      });
    },
  };
}

function setRecordingUI(on) {
  const record = document.getElementById("record-btn");
  const time = document.getElementById("rec-time");

  record.classList.toggle("recording", on);
  record.firstChild.textContent = on ? "■ Stop " : "● Record ";
  // The canvas can't change size mid-recording
  for (const key of ["size", "customW", "customH"]) {
    controls[key].wrap
      .querySelectorAll("input, select")
      .forEach((input) => (input.disabled = on));
  }

  clearInterval(recordTimer);
  time.textContent = "";
  if (on) {
    recordTimer = setInterval(() => {
      const seconds = (performance.now() - recording.startedAt) / 1000;
      time.textContent = formatDuration(seconds);
      if (params.maxDuration > 0 && seconds >= params.maxDuration) {
        stopRecording();
      }
    }, 100);
  }
}

function addTake(blob, take, seconds) {
  const url = URL.createObjectURL(blob);
  const filename = `bigk-${timestamp()}.${take.format.ext}`;
  const list = document.getElementById("takes");
  list.querySelector(".note")?.remove();

  const card = el("div", "take");
  const video = el("video");
  video.src = url;
  video.muted = true;
  video.loop = true;
  video.playsInline = true;
  video.controls = true;

  const meta = el(
    "div",
    "take-meta",
    `${formatDuration(seconds)} · ${take.w} × ${take.h} · ${take.format.label} · ${formatBytes(blob.size)}`,
  );

  const save = el("a", "btn primary", "Download");
  save.href = url;
  save.download = filename;

  const remove = button("Delete", () => {
    URL.revokeObjectURL(url);
    card.remove();
  });

  const actions = el("div", "row");
  actions.append(save, remove);
  card.append(video, meta, actions);
  list.prepend(card);

  document.querySelector('details[data-group="Record"]').open = true;
  showMessage(`Recording ready · ${formatBytes(blob.size)}`, {
    label: "Download",
    href: url,
    filename,
  });
}

function snapshot() {
  const canvas = document.querySelector("#stage canvas");
  canvas.toBlob(
    (blob) => download(blob, `bigk-${timestamp()}.png`),
    "image/png",
  );
}

// ---------------------------------------------------------------- page

function togglePanel() {
  const app = document.getElementById("app");
  app.classList.toggle("panel-hidden");
  document.getElementById("panel-btn").firstChild.textContent =
    app.classList.contains("panel-hidden") ? "Show panel " : "Hide panel ";
  requestAnimationFrame(windowResized);
}

function wireKeyboard() {
  window.addEventListener("keydown", (event) => {
    // Leave typing alone, and let Space/Enter work the focused control;
    // letter shortcuts still work while a slider or checkbox has focus
    const target = event.target;
    if (
      target.matches?.("input[type=text], input[type=number], select, textarea")
    ) {
      return;
    }
    if (
      target.closest?.("button, a, input") &&
      (event.key === " " || event.key === "Enter")
    ) {
      return;
    }
    if (event.metaKey || event.ctrlKey || event.altKey || event.repeat) {
      return;
    }

    const actions = {
      " ": replayReveal,
      r: toggleRecording,
      p: snapshot,
      h: togglePanel,
    };
    const action = actions[event.key.toLowerCase()];
    if (action) {
      event.preventDefault();
      action();
    }
  });
}

function wireDragAndDrop() {
  const main = document.getElementById("main");
  let depth = 0;

  main.addEventListener("dragenter", (event) => {
    event.preventDefault();
    depth++;
    main.classList.add("dragging");
  });
  main.addEventListener("dragleave", () => {
    depth = Math.max(0, depth - 1);
    if (depth === 0) {
      main.classList.remove("dragging");
    }
  });
  main.addEventListener("dragover", (event) => event.preventDefault());
  main.addEventListener("drop", (event) => {
    event.preventDefault();
    depth = 0;
    main.classList.remove("dragging");
    const file = event.dataTransfer.files[0];
    if (file) {
      loadMediaFile(file);
    }
  });
}

function updateInfo() {
  const info = document.getElementById("canvas-info");
  const detail = {
    tiles: `${cols} × ${rows} cells`,
    lines: `${Math.ceil(height / params.lineSpacing)} lines`,
    outline: `${params.outlineEchoes} echo${params.outlineEchoes === 1 ? "" : "es"}`,
  }[params.effect];
  info.textContent = `${width} × ${height} · ${detail} · ${Math.round(frameRate())} fps`;
}

// A short message along the bottom of the stage, optionally with a link
function showMessage(text, action) {
  const toast = document.getElementById("toast");
  toast.replaceChildren(el("span", "", text));

  if (action) {
    const link = el("a", "btn primary", action.label);
    link.href = action.href;
    link.download = action.filename;
    toast.append(link);
  }

  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(
    () => toast.classList.remove("show"),
    action ? 8000 : 4000,
  );
}

function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = el("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

function timestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function formatDuration(seconds) {
  const m = Math.floor(seconds / 60);
  const s = seconds - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, "0")}`;
}

function formatBytes(bytes) {
  return bytes > 1e6
    ? `${(bytes / 1e6).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1e3))} KB`;
}
