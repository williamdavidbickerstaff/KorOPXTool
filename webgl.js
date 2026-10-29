// Shared plumbing for the shader effects (Lines and Outline). They draw into
// one WebGL buffer, which is then copied onto the main canvas so recording
// and snapshots work the same as for Tiles. One buffer for both, as browsers
// only allow a handful of WebGL contexts

// Draws a full-canvas rectangle with vUv running 0..1 from the top left
const FULLSCREEN_VERT = `
attribute vec3 aPosition;
attribute vec2 aTexCoord;
varying vec2 vUv;

void main() {
  // flip Y here so the fragment shader can stay exactly as written
  vUv = vec2(aTexCoord.x, 1.0 - aTexCoord.y);
  vec4 pos = vec4(aPosition, 1.0);
  pos.xy = pos.xy * 2.0 - 1.0;   // p5's rect is 0..1, convert to clip space
  gl_Position = pos;
}
`;

let glBuffer = null;
// The source fitted, mirrored and blurred to the canvas size, for the
// shaders to sample
let glSource = null;
// Set if this browser can't make a WebGL context, so we stop trying
let glUnavailable = false;

// Make the buffers on first use, and keep them the size of the canvas.
// Returns false if shader effects can't run here
function prepareGL() {
  if (glUnavailable) {
    return false;
  }

  if (!glBuffer) {
    try {
      glBuffer = createGraphics(width, height, WEBGL);
    } catch (error) {
      glUnavailable = true;
      showMessage(
        "This effect needs WebGL, which this browser has turned off. Check hardware acceleration is on in its settings.",
      );
      return false;
    }
    glBuffer.pixelDensity(1);
    glBuffer.noStroke();
    glSource = createGraphics(width, height);
    glSource.pixelDensity(1);
  }

  if (glBuffer.width !== width || glBuffer.height !== height) {
    glBuffer.resizeCanvas(width, height);
    glSource.resizeCanvas(width, height);
  }
  return true;
}

// Make a shader on the shared buffer, once
function makeShader(frag) {
  return glBuffer.createShader(FULLSCREEN_VERT, frag);
}

// Draw the source where Fit, Scale and Position put it, over the surround
// colour, optionally blurred
function drawGLSource(surround, blur) {
  const ctx = glSource.drawingContext;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.filter = "none";
  ctx.fillStyle = surround;
  ctx.fillRect(0, 0, width, height);

  const size = source && sourceSize(source);
  if (size) {
    const r = sourceRect(size);
    if (params.mirror) {
      ctx.translate(r.x * 2 + r.w, 0);
      ctx.scale(-1, 1);
    }
    if (blur > 0) {
      ctx.filter = `blur(${blur}px)`;
    }
    ctx.drawImage(source.el, r.x, r.y, r.w, r.h);
  }

  ctx.restore();
}

// Run a shader over the whole buffer (its uniforms already set) and copy
// the result onto the main canvas
function drawShader(shader) {
  glBuffer.shader(shader);
  glBuffer.rect(0, 0, width, height);
  image(glBuffer, width / 2, height / 2);
}

// "#FF8000" → [1, 0.5, 0], the 0–1 colour the shaders expect
function unitRGB(hex) {
  const c = color(hex);
  return [red(c) / 255, green(c) / 255, blue(c) / 255];
}
