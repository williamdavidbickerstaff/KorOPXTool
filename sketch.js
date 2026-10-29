// The picture being rendered out of tiles and dots:
// { el, kind: "image" | "video" | "webcam", name, url, stream }
let source = null;
// The picture used as each tile (an <img> or <canvas>), and a copy of it
// capped in size so recolouring stays quick while dragging colour pickers
let tileSource = null;
let tileBase = null;

let tile;
let glitchTile;
// The tiles shrunk to the size they're drawn at, so they stay crisp
let drawTile;
let drawGlitchTile;
// Blocky low-resolution versions of each tile, shown while it decodes
let tileSteps = [];
let glitchTileSteps = [];

let cells = [];
// grid[col][row] gives the cell at that position, for looking up neighbours
let grid = [];
let cols = 0;
let rows = 0;
// Top-left corner of the grid, which is centred on the canvas
let startX = 0;
let startY = 0;

// Tiny copy of the source with one pixel per grid cell
let frameCanvas;
let frameCtx;
// The smoothed source colour of each cell, one pixel per cell
let colourCanvas;
let colourCtx;
let colourData;
// Tiles and dots that take the source colour are drawn here first, then
// coloured in all at once
let layer;

// Where the real pointer is, in canvas pixels
const pointer = { x: 0, y: 0, active: false, jumped: false };
// The last position used to measure speed, and whether it was the real
// pointer or the auto-glitch ghost
let lastPointer = null;
// Smoothed pointer speed, 0 when still and 1 at fullSpeed or faster
let mouseSpeed = 0;
// Recent pointer positions that keep glitching for a while after it passes
let trail = [];
// frameCount when the reveal started; null keeps the canvas empty
let revealStart = null;

// What needs working out again before the next frame
const dirty = { size: true, grid: true, tiles: true };

function setup() {
  pixelDensity(1);
  const { w, h } = outputSize();
  const canvas = createCanvas(w, h);
  canvas.parent("stage");
  listenToPointer(canvas.elt);
  noStroke();
  imageMode(CENTER);

  frameCanvas = document.createElement("canvas");
  frameCtx = frameCanvas.getContext("2d", { willReadFrequently: true });
  colourCanvas = document.createElement("canvas");
  colourCtx = colourCanvas.getContext("2d");

  initUI();
  replayReveal();
}

function draw() {
  drawFrame();
  // Hand the finished frame to the MP4 recorder, if one is running
  onFrameDrawn();
}

function drawFrame() {
  applyChanges();

  if (params.effect === "lines") {
    drawLines();
    return;
  }
  if (params.effect === "outline") {
    drawOutline();
    return;
  }

  background(params.backgroundColour);

  readSource();

  const p = currentPointer();
  updateMouseSpeed(p);
  updateTrail(p);

  if (revealStart === null || !drawTile) {
    return;
  }

  const P = params.cellSize;
  const usesLayer = params.tileFromSource || params.dotFromSource;
  if (usesLayer) {
    prepareLayer();
  }

  const dotColour = color(
    params.dotMatchesTile ? params.tileColour : params.dotColour,
  );
  const ghostColour = color(params.glitchColour);
  const rowShifts = makeRowShifts();

  for (const cell of cells) {
    // Cells appear once the wave reaches them, growing in from nothing
    const age =
      frameCount - revealStart - cell.revealOrder * params.revealFrames;
    if (age < 0) {
      continue;
    }
    const grow = min(1, age / params.revealGrow);

    const centreX = cell.cx + P / 2;
    const centreY = cell.cy + P / 2;
    const strength = trailStrength(centreX, centreY);

    let shown = cell;
    let bright = cell.bright;
    let split = false;

    if (strength > 0) {
      // Show the contents of a cell further along the row, so the band looks
      // torn sideways; cells near the edge of the area slide less
      const shift = Math.round(rowShifts[cell.row] * strength);
      const shifted = grid[cell.col - shift]?.[cell.row];
      if (shifted) {
        shown = shifted;
        bright = shifted.bright;
      }

      if (random() < params.swapChance * strength) {
        bright = !bright;
      }

      split = random() < params.splitChance * strength;
    }

    // Cells still growing in flicker between faces as they load
    if (grow < 1 && random() < params.revealGlitch) {
      bright = !bright;
    }

    if (split) {
      drawFace(
        window,
        decodeStep(drawGlitchTile, glitchTileSteps, grow),
        grow < 1,
        ghostColour,
        bright,
        shown.dotSize,
        centreX - params.splitOffset,
        centreY,
        grow,
      );
    }

    const fromSource = bright ? params.tileFromSource : params.dotFromSource;
    drawFace(
      fromSource ? layer : window,
      decodeStep(drawTile, tileSteps, grow),
      grow < 1,
      dotColour,
      bright,
      shown.dotSize,
      centreX,
      centreY,
      grow,
    );
  }

  if (usesLayer) {
    colourLayer();
    image(layer, width / 2, height / 2);
  }
}

// Work out anything a settings change has invalidated, biggest first
function applyChanges() {
  if (dirty.size) {
    dirty.size = false;
    const { w, h } = outputSize();
    // The canvas can't change size mid-recording
    if ((w !== width || h !== height) && !isRecording()) {
      resizeCanvas(w, h);
      noStroke();
      imageMode(CENTER);
      dirty.grid = true;
    }
    fitCanvasToStage();
  }

  if (dirty.grid) {
    dirty.grid = false;
    buildGrid();
    dirty.tiles = true;
  }

  if (dirty.tiles && tileSource) {
    dirty.tiles = false;
    buildTiles();
  }
}

// The canvas size, in pixels, for the chosen output size. Kept even so
// H.264 recordings don't fail on odd dimensions
function outputSize() {
  let w;
  let h;

  if (params.size === "window") {
    const stage = document.getElementById("stage");
    w = stage.clientWidth;
    h = stage.clientHeight;
  } else if (params.size === "custom") {
    w = params.customW;
    h = params.customH;
  } else if (params.size === "source") {
    const size = source && sourceSize(source);
    w = size ? size.w : 1920;
    h = size ? size.h : 1080;
  } else {
    [w, h] = params.size.split("x").map(Number);
  }

  const even = (n) => Math.max(16, Math.min(7680, Math.round(n / 2) * 2));
  return { w: even(w), h: even(h) };
}

// Scale the canvas on screen to fit the stage. Its real size stays the
// output size, which is what gets recorded
function fitCanvasToStage() {
  const stage = document.getElementById("stage");
  const canvas = document.querySelector("#stage canvas");
  if (!canvas) {
    return;
  }

  const gutter = params.size === "window" ? 0 : 32;
  const s = min(
    (stage.clientWidth - gutter) / width,
    (stage.clientHeight - gutter) / height,
  );
  canvas.style.width = `${Math.max(1, width * s)}px`;
  canvas.style.height = `${Math.max(1, height * s)}px`;
}

function windowResized() {
  if (params.size === "window") {
    dirty.size = true;
  } else {
    fitCanvasToStage();
  }
}

// Swap in a new picture to render. Releases whatever the old one was holding
function setSource(next) {
  if (source && source !== next) {
    source.stream?.getTracks().forEach((track) => track.stop());
    if (source.el instanceof HTMLVideoElement) {
      source.el.pause();
      source.el.remove();
    }
    if (source.url) {
      URL.revokeObjectURL(source.url);
    }
  }

  source = next;
  for (const cell of cells) {
    cell.r = cell.g = cell.b = cell.a = 0;
  }

  if (params.size === "source") {
    dirty.size = true;
  }
  replayReveal();
  onSourceChanged();
}

// The source's own size in pixels, or null while it's still loading
function sourceSize(s) {
  const el = s.el;
  if (el instanceof HTMLVideoElement) {
    return el.readyState >= 2 && el.videoWidth > 0
      ? { w: el.videoWidth, h: el.videoHeight }
      : null;
  }
  const w = el.naturalWidth || el.width;
  const h = el.naturalHeight || el.height;
  return w > 0 && h > 0 ? { w, h } : null;
}

// Where the source sits on the canvas, after Fit, Scale and Position
function sourceRect(size) {
  let fit = 1;
  if (params.fit === "contain") {
    fit = min(width / size.w, height / size.h);
  } else if (params.fit === "cover") {
    fit = max(width / size.w, height / size.h);
  }

  const w = size.w * fit * params.imageScale;
  const h = size.h * fit * params.imageScale;
  return {
    x: (width - w) / 2 + (params.offsetX * width) / 2,
    y: (height - h) / 2 + (params.offsetY * height) / 2,
    w,
    h,
  };
}

// Sample the source once per cell and decide which cells are bright
function readSource() {
  frameCtx.clearRect(0, 0, cols, rows);
  const size = source && sourceSize(source);

  if (size) {
    const r = sourceRect(size);
    const P = params.cellSize;

    frameCtx.save();
    // Canvas pixels → grid cells, so each cell lands on one pixel
    frameCtx.scale(1 / P, 1 / P);
    frameCtx.translate(-startX, -startY);
    if (params.mirror) {
      frameCtx.translate(r.x * 2 + r.w, 0);
      frameCtx.scale(-1, 1);
    }
    frameCtx.imageSmoothingQuality = "high";
    frameCtx.drawImage(source.el, r.x, r.y, r.w, r.h);
    frameCtx.restore();
  }

  let pixels;
  try {
    pixels = frameCtx.getImageData(0, 0, cols, rows).data;
  } catch (error) {
    // The browser won't let us read pictures opened straight from disk
    // (file://). Uploads always work
    setSource(null);
    showMessage(
      "Couldn't read that picture. Open this tool through a web server, or upload your own image.",
    );
    return;
  }

  // Stills snap straight to their values; video eases so noise doesn't flicker
  const moving = source && source.kind !== "image";
  const ease = moving ? params.smoothing : 1;
  const threshold = moving ? params.videoThreshold : params.threshold;
  const colours = colourData.data;

  for (const cell of cells) {
    const i = (cell.col + cell.row * cols) * 4;

    cell.r += (pixels[i] - cell.r) * ease;
    cell.g += (pixels[i + 1] - cell.g) * ease;
    cell.b += (pixels[i + 2] - cell.b) * ease;
    cell.a += (pixels[i + 3] / 255 - cell.a) * ease;

    colours[i] = cell.r;
    colours[i + 1] = cell.g;
    colours[i + 2] = cell.b;
    colours[i + 3] = 255;

    // Transparent parts and anything outside the picture count as dark,
    // even when inverted
    const avg = (cell.r + cell.g + cell.b) / 3;
    const level = (params.invert ? 255 - avg : avg) * cell.a;
    cell.bright = level > threshold;
  }

  updateDotSizes();
}

// Dots shrink towards minDotSize as they get closer to the bright cells
function updateDotSizes() {
  const distances = distanceToBright();
  const span = Math.max(1, params.dotFalloff - 1);

  for (const cell of cells) {
    const distance = distances[cell.col + cell.row * cols];
    const t = constrain((distance - 1) / span, 0, 1);
    cell.dotSize = lerp(params.minDotSize, params.dotSize, t);
  }
}

// Distance, in grid cells, from every cell to the nearest bright cell.
// Two sweeps over the grid (a chamfer distance transform) keep this fast
// enough to run every frame
function distanceToBright() {
  const diagonal = Math.SQRT2;
  const d = new Float32Array(cols * rows);

  for (const cell of cells) {
    d[cell.col + cell.row * cols] = cell.bright ? 0 : Infinity;
  }

  const relax = (col, row, fromCol, fromRow, step) => {
    if (fromCol < 0 || fromCol >= cols || fromRow < 0 || fromRow >= rows) {
      return;
    }
    const i = col + row * cols;
    const candidate = d[fromCol + fromRow * cols] + step;
    if (candidate < d[i]) {
      d[i] = candidate;
    }
  };

  // Sweep down and right, pulling distances from above and to the left
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      relax(col, row, col - 1, row, 1);
      relax(col, row, col, row - 1, 1);
      relax(col, row, col - 1, row - 1, diagonal);
      relax(col, row, col + 1, row - 1, diagonal);
    }
  }

  // Sweep up and left, pulling distances from below and to the right
  for (let row = rows - 1; row >= 0; row--) {
    for (let col = cols - 1; col >= 0; col--) {
      relax(col, row, col + 1, row, 1);
      relax(col, row, col, row + 1, 1);
      relax(col, row, col + 1, row + 1, diagonal);
      relax(col, row, col - 1, row + 1, diagonal);
    }
  }

  return d;
}

// Make sure the colour layer exists and matches the canvas, then clear it
function prepareLayer() {
  if (!layer || layer.width !== width || layer.height !== height) {
    layer?.remove();
    layer = createGraphics(width, height);
    layer.pixelDensity(1);
    layer.noStroke();
    layer.imageMode(CENTER);
  }
  layer.clear();
}

// Paint the source colours over everything drawn on the layer, keeping only
// the shapes, so each tile and dot takes the colour of the cell beneath it
function colourLayer() {
  const ctx = layer.drawingContext;
  const P = params.cellSize;

  colourCtx.putImageData(colourData, 0, 0);
  ctx.save();
  ctx.globalCompositeOperation = "source-in";
  // Keep each cell's colour as a hard-edged block instead of blurring them
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(colourCanvas, startX, startY, cols * P, rows * P);
  ctx.restore();
}

// The real pointer while it's over the canvas, otherwise the auto-glitch
// ghost if it's switched on
function currentPointer() {
  if (pointer.active) {
    return pointer;
  }
  if (params.autoGlitch) {
    // Wander smoothly over the canvas, reaching a little past its edges
    const t = frameCount * 0.006 * params.autoSpeed;
    return {
      x: map(noise(t, 0), 0.2, 0.8, -0.1, 1.1) * width,
      y: map(noise(t, 100), 0.2, 0.8, -0.1, 1.1) * height,
      ghost: true,
    };
  }
  return null;
}

// Ease mouseSpeed towards how fast the pointer moved this frame, so the
// effect builds up and dies down smoothly instead of jumping between frames
function updateMouseSpeed(p) {
  let target = 0;

  // Measuring across a jump (a new touch, or switching between the real
  // pointer and the ghost) would read as one huge flick
  const comparable =
    p && lastPointer && !pointer.jumped && !!p.ghost === lastPointer.ghost;
  if (comparable) {
    const dx = p.x - lastPointer.x;
    const dy = p.y - lastPointer.y;
    target = min(1, sqrt(dx * dx + dy * dy) / params.fullSpeed);
  }

  lastPointer = p ? { x: p.x, y: p.y, ghost: !!p.ghost } : null;
  pointer.jumped = false;
  mouseSpeed = lerp(mouseSpeed, target, params.speedSmoothing);

  // Settle completely once the pointer stops, so the image goes still
  if (mouseSpeed < 0.01) {
    mouseSpeed = 0;
  }
}

// Drop a new point where the pointer is, and age the older ones so the
// glitch lingers along the path and fades out behind the cursor
function updateTrail(p) {
  if (p && mouseSpeed > 0) {
    trail.push({
      x: p.x,
      y: p.y,
      // Faster movements reach further out
      reach: params.hoverRadius * lerp(params.minReach, 1, mouseSpeed),
      speed: mouseSpeed,
      life: 1,
    });
  }

  for (const point of trail) {
    point.life -= 1 / params.trailFrames;
  }

  trail = trail.filter((point) => point.life > 0);
}

// How strongly the glitch affects a cell: strongest at the cursor and when
// moving fast, fading towards the edge of each trail point and as it ages
function trailStrength(x, y) {
  let strength = 0;

  for (const point of trail) {
    // Older points shrink as well as weaken, so the trail tapers off
    const reach = point.reach * lerp(params.trailTaper, 1, point.life);
    const dx = x - point.x;
    const dy = y - point.y;

    if (abs(dx) > reach || abs(dy) > reach) {
      continue;
    }

    const falloff = max(0, 1 - sqrt(dx * dx + dy * dy) / reach);
    strength = max(
      strength,
      pow(falloff, params.hoverFalloff) * point.speed * point.life,
    );
  }

  return strength;
}

// Draw a miniature copy of the tile, or a dot, centred at (x, y) on the
// target: window for the main canvas, or the colour layer.
// grow shrinks the dot towards nothing while the cell is loading in; tiles
// load in by decoding instead (see decodeStep)
function drawFace(
  target,
  tileImage,
  blocky,
  dotColour,
  bright,
  dotSize,
  x,
  y,
  grow,
) {
  if (bright) {
    // Fit the tile inside the cell without stretching it, then apply tileScale.
    // Sized from the full tile so the blocky decode steps fill the same space
    const s = (params.cellSize * params.tileScale) / max(tile.width, tile.height);

    // Keep decode steps as hard-edged blocks instead of blurring them
    target.drawingContext.imageSmoothingEnabled = !blocky;
    target.image(tileImage, x, y, tile.width * s, tile.height * s);
    target.drawingContext.imageSmoothingEnabled = true;
  } else {
    const d = dotSize * grow;
    if (d <= 0) {
      return;
    }
    target.fill(dotColour);
    if (params.dotShape === "square") {
      target.square(x - d / 2, y - d / 2, d);
    } else {
      target.circle(x, y, d);
    }
  }
}

// The version of a tile to show at this point in its decode: blocky steps
// while it loads, then the full tile
function decodeStep(full, steps, grow) {
  if (grow >= 1 || steps.length === 0) {
    return full;
  }
  return steps[Math.floor(grow * steps.length)];
}

// Pick this frame's sideways slide, in grid cells, for every row. Rows are
// grouped into bands of random height so they tear apart in chunks
function makeRowShifts() {
  const shifts = new Array(rows).fill(0);

  if (trail.length === 0) {
    return shifts;
  }

  let row = 0;
  while (row < rows) {
    const bandHeight = Math.floor(random(1, params.sliceHeight + 1));
    const shift =
      random() < params.sliceChance
        ? Math.round(random(-params.maxSlice, params.maxSlice))
        : 0;

    for (let i = 0; i < bandHeight && row < rows; i++, row++) {
      shifts[row] = shift;
    }
  }

  return shifts;
}

// Track the pointer ourselves, in canvas pixels, so it lines up however
// large the canvas is shown on screen
function listenToPointer(canvas) {
  const move = (event) => {
    const rect = canvas.getBoundingClientRect();
    pointer.x = ((event.clientX - rect.left) * width) / rect.width;
    pointer.y = ((event.clientY - rect.top) * height) / rect.height;
  };

  canvas.addEventListener("pointermove", (event) => {
    move(event);
    pointer.active = true;
    document.getElementById("hint").classList.add("seen");
  });
  canvas.addEventListener("pointerdown", (event) => {
    move(event);
    pointer.active = true;
    pointer.jumped = true;
    document.activeElement?.blur();
  });
  canvas.addEventListener("pointerleave", () => (pointer.active = false));
}

// Start (or replay) the reveal
function replayReveal() {
  revealStart = frameCount;
}

// Use a new picture for the tiles
function setTileSource(el) {
  tileSource = el;
  tileBase = null;
  dirty.tiles = true;
}

// Make the coloured tiles, their decode steps and their drawn-size copies
function buildTiles() {
  try {
    tileBase ??= elementToImage(tileSource, 512);
    tile = makeTile(tileBase, color(params.tileColour));
    glitchTile = makeTile(tileBase, color(params.glitchColour));
  } catch (error) {
    // Same file:// restriction as readSource; fall back to a plain square
    showMessage("Couldn't read the tile picture, so it's using a square.");
    params.tileShape = "square";
    onTileShapeChanged();
    return;
  }

  const resolutions = parseResolutions(params.revealResolutions);
  tileSteps = resolutions.map((r) => pixelate(tile, r));
  glitchTileSteps = resolutions.map((r) => pixelate(glitchTile, r));

  const s = (params.cellSize * params.tileScale) / max(tile.width, tile.height);
  drawTile = shrink(tile, tile.width * s, tile.height * s);
  drawGlitchTile = shrink(glitchTile, glitchTile.width * s, glitchTile.height * s);
}

// "1, 2, 3, 5, 8" → [1, 2, 3, 5, 8], skipping anything that isn't a
// positive whole number
function parseResolutions(text) {
  return String(text)
    .split(/[^0-9]+/)
    .map(Number)
    .filter((n) => n > 0)
    .map((n) => Math.min(n, 64));
}

// Copy an <img> or <canvas> into a p5.Image no larger than maxSize across
function elementToImage(el, maxSize) {
  const w = el.naturalWidth || el.width;
  const h = el.naturalHeight || el.height;
  const s = min(1, maxSize / max(w, h));
  const result = createImage(
    Math.max(1, Math.round(w * s)),
    Math.max(1, Math.round(h * s)),
  );
  result.drawingContext.drawImage(el, 0, 0, result.width, result.height);
  return result;
}

// Scale an image to (w, h), halving it a step at a time on the way down so
// it stays smooth instead of turning into scattered specks
function shrink(source, w, h) {
  w = Math.max(1, Math.round(w));
  h = Math.max(1, Math.round(h));

  let current = source.canvas;
  let cw = source.width;
  let ch = source.height;

  while (cw / 2 >= w && ch / 2 >= h) {
    const half = document.createElement("canvas");
    half.width = Math.ceil(cw / 2);
    half.height = Math.ceil(ch / 2);
    half.getContext("2d").drawImage(current, 0, 0, half.width, half.height);
    current = half;
    cw = half.width;
    ch = half.height;
  }

  const result = createImage(w, h);
  result.drawingContext.drawImage(current, 0, 0, w, h);
  return result;
}

// Shrink a tile to `across` blocks wide (keeping its proportions) by
// averaging each block of pixels, so it reads as a clean low-res version of
// the tile rather than the scattered specks the browser gives when it
// shrinks a large image in one go
function pixelate(source, across) {
  across = Math.min(across, source.width);
  const blockW = source.width / across;
  const down = max(1, Math.round(source.height / blockW));
  const blockH = source.height / down;
  const result = createImage(across, down);

  source.loadPixels();
  result.loadPixels();

  for (let by = 0; by < down; by++) {
    for (let bx = 0; bx < across; bx++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let count = 0;

      for (
        let y = Math.floor(by * blockH);
        y < Math.floor((by + 1) * blockH);
        y++
      ) {
        for (
          let x = Math.floor(bx * blockW);
          x < Math.floor((bx + 1) * blockW);
          x++
        ) {
          const i = (x + y * source.width) * 4;
          r += source.pixels[i];
          g += source.pixels[i + 1];
          b += source.pixels[i + 2];
          a += source.pixels[i + 3];
          count++;
        }
      }

      const j = (bx + by * across) * 4;
      count = Math.max(1, count);
      result.pixels[j] = r / count;
      result.pixels[j + 1] = g / count;
      result.pixels[j + 2] = b / count;
      result.pixels[j + 3] = a / count;
    }
  }

  result.updatePixels();
  return result;
}

// Build a copy of the image where bright pixels take the fill colour
// and dark pixels become transparent, so the background shows through
function makeTile(source, fillColour) {
  const result = createImage(source.width, source.height);
  source.loadPixels();
  result.loadPixels();

  const fr = red(fillColour);
  const fg = green(fillColour);
  const fb = blue(fillColour);

  for (let i = 0; i < source.pixels.length; i += 4) {
    let avg =
      (source.pixels[i] + source.pixels[i + 1] + source.pixels[i + 2]) / 3;
    if (params.tileInvert) {
      avg = 255 - avg;
    }

    result.pixels[i] = fr;
    result.pixels[i + 1] = fg;
    result.pixels[i + 2] = fb;
    result.pixels[i + 3] =
      avg > params.tileThreshold ? source.pixels[i + 3] : 0;
  }

  result.updatePixels();
  return result;
}

// Lay out the grid of cells over the whole canvas. Their faces are filled
// in from the source every frame by readSource()
function buildGrid() {
  const P = params.cellSize;
  cols = Math.ceil(width / P);
  rows = Math.ceil(height / P);
  startX = (width - cols * P) / 2;
  startY = (height - rows * P) / 2;

  frameCanvas.width = cols;
  frameCanvas.height = rows;
  colourCanvas.width = cols;
  colourCanvas.height = rows;
  colourData = colourCtx.createImageData(cols, rows);

  cells = [];
  grid = [];

  for (let col = 0; col < cols; col++) {
    grid[col] = [];

    for (let row = 0; row < rows; row++) {
      const cell = {
        cx: startX + col * P,
        cy: startY + row * P,
        col,
        row,
        r: 0,
        g: 0,
        b: 0,
        a: 0,
        bright: false,
        dotSize: params.dotSize,
        revealOrder: 0,
      };

      cells.push(cell);
      grid[col][row] = cell;
    }
  }

  setRevealOrder();
}

// When each cell appears during the reveal, from 0 (first) to 1 (last)
function setRevealOrder() {
  const lastCol = Math.max(1, cols - 1);
  const lastRow = Math.max(1, rows - 1);
  const furthest = Math.hypot(lastCol / 2, lastRow / 2);

  for (const cell of cells) {
    switch (params.revealDirection) {
      case "horizontal":
        cell.revealOrder = cell.col / lastCol;
        break;
      case "vertical":
        cell.revealOrder = cell.row / lastRow;
        break;
      case "centre":
        cell.revealOrder =
          Math.hypot(cell.col - lastCol / 2, cell.row - lastRow / 2) / furthest;
        break;
      case "random":
        cell.revealOrder = Math.random();
        break;
      default:
        // Cells further down and to the right appear later, so the image
        // sweeps in diagonally from the top left corner
        cell.revealOrder = (cell.col + cell.row) / (lastCol + lastRow);
    }
  }
}
