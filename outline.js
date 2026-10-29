// The Outline effect, after glitchK2.mp4: a thin outline traced around the
// bright parts of the picture, broken up by glitches. Areas of the outline
// snap to blocky stair-steps of different sizes, scatter breaks them into
// islands of contour, bands of rows tear sideways, and dimmer echoes of the
// outline sit behind it at a different scale.
//
// The glitch pattern flows smoothly from one random pattern to the next,
// and every so often a burst cuts in: a few frames of harder glitching with
// no animation at all. Drawn by a shader, using the buffers in webgl.js

const OUTLINE_FRAG = `
precision highp float;

uniform sampler2D uTexture;
uniform vec2  uResolution;   // canvas pixels
uniform float uSeedA;        // the glitch pattern being left
uniform float uSeedB;        // the glitch pattern being moved towards
uniform float uMix;          // how far between them, 0..1
uniform float uCleanA;       // 1.0 if pattern A is a clean outline
uniform float uCleanB;       // 1.0 if pattern B is a clean outline
uniform float uIntensity;    // multiplies tearing and scatter (raised in bursts)
uniform float uThreshold;    // brightness (0..1) that counts as inside
uniform float uInvert;       // 1.0 swaps light and dark
uniform float uLineWidth;    // outline thickness in px

uniform float uRegion;       // size in px of the areas that pick their own step
uniform float uSmoothChance; // chance an area keeps a crisp, unstepped outline
uniform float uStepMin;      // smallest stair-step in px
uniform float uStepMax;      // largest stair-step in px
uniform float uScatter;      // px each step block's sample wanders (main outline)
uniform float uSliceChance;  // chance a band of rows tears sideways
uniform float uSliceMax;     // furthest a band tears, in px
uniform float uSliceHeight;  // typical band height in px

uniform float uEchoes;       // how many echoes, 0..4
uniform float uEchoScale;    // size of each echo relative to the one before
uniform vec2  uEchoOffset;   // px each echo moves from the one before
uniform float uEchoScatter;  // px each step block's sample wanders (echoes)
uniform float uEchoFade;     // strength of each echo relative to the one before

uniform vec3  uBg;
uniform vec3  uLine;
uniform vec3  uEcho;

varying vec2 vUv;

// Repeatable random number 0..1 for a point
float hash(vec2 p) {
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
}

// How far one pattern tears the band of rows at height y sideways, in px
float tear(float y, float seed, float clean) {
    if (clean > 0.5) {
        return 0.0;
    }
    float bandH = uSliceHeight * (0.5 + hash(vec2(seed, 9.1)));
    float band  = floor(y / max(bandH, 1.0));
    if (hash(vec2(band, seed * 7.3)) < uSliceChance * uIntensity) {
        return (hash(vec2(band * 3.1, seed)) * 2.0 - 1.0) * uSliceMax * uIntensity;
    }
    return 0.0;
}

// The stair-step size one pattern gives the area around q, in px
// (1.0 = a crisp outline)
float stepSize(vec2 q, float seed, float clean) {
    if (clean > 0.5) {
        return 1.0;
    }
    float pick = hash(floor(q / uRegion) + seed);
    if (pick < uSmoothChance) {
        return 1.0;
    }
    float t = (pick - uSmoothChance) / max(1.0 - uSmoothChance, 0.0001);
    return max(min(floor(mix(uStepMin, uStepMax + 1.0, t)), uStepMax), 1.0);
}

// Random 0..1 pair for nudging a step block's sample
vec2 nudge(vec2 cell, float seed) {
    return vec2(hash(cell * 1.37 + seed * 3.1), hash(cell * 2.71 + seed * 1.7));
}

// 1.0 if canvas point q (px, from the top left) is inside the shape, seen
// through the glitches. Every random choice is blended between patterns A
// and B, so tears slide and steps grow or shrink rather than jumping: the
// area q is in picks a step size, and the picture is sampled once per step
// block, from a point nudged up to scatter px, so blocks near an edge land
// randomly in or out
float inside(vec2 q, float offset, float scatter) {
    float a = uSeedA + offset;
    float b = uSeedB + offset;

    q.x += mix(tear(q.y, a, uCleanA), tear(q.y, b, uCleanB), uMix);
    float size = mix(stepSize(q, a, uCleanA), stepSize(q, b, uCleanB), uMix);

    // Steps are laid out from the centre of their area, so as the size
    // changes the blocks grow or shrink in place and keep their identity
    // (and their nudge), instead of the whole grid sliding past
    vec2 anchor = (floor(q / uRegion) + 0.5) * uRegion;
    vec2 cell = floor((q - anchor) / size);
    vec2 at   = anchor + (cell + 0.5) * size;
    // Crisp areas stay clean; scatter fades in as an area starts to step
    float stepped = clamp(size - 1.0, 0.0, 1.0);
    if (stepped > 0.0) {
        vec2 n = mix(nudge(cell, a), nudge(cell, b), uMix);
        at += (n * 2.0 - 1.0) * scatter * uIntensity * stepped;
    }
    vec3 col  = texture2D(uTexture, at / uResolution).rgb;
    float luma = dot(col, vec3(0.299, 0.587, 0.114));
    luma = mix(luma, 1.0 - luma, uInvert);
    return step(uThreshold, luma);
}

// 1.0 where p lies on the boundary of the shape, uLineWidth px thick
// (offset gives each echo its own patterns)
float edge(vec2 p, float offset, float scatter) {
    float h = uLineWidth * 0.5;
    float c = inside(p, offset, scatter);
    float e = abs(c - inside(p + vec2(h, 0.0), offset, scatter));
    e = max(e, abs(c - inside(p - vec2(h, 0.0), offset, scatter)));
    e = max(e, abs(c - inside(p + vec2(0.0, h), offset, scatter)));
    e = max(e, abs(c - inside(p - vec2(0.0, h), offset, scatter)));
    return e;
}

void main() {
    vec2 p = vec2(gl_FragCoord.x, uResolution.y - gl_FragCoord.y);
    vec2 centre = uResolution * 0.5;
    vec3 col = uBg;

    // Echoes first, furthest back, so the main outline draws over them
    for (int i = 4; i >= 1; i--) {
        float n = float(i);
        if (n > uEchoes) {
            continue;
        }
        vec2 q = centre + (p - centre - uEchoOffset * n) / pow(uEchoScale, n);
        float e = edge(q, n * 13.0, uEchoScatter);
        col = mix(col, uEcho, e * pow(uEchoFade, n - 1.0));
    }

    col = mix(col, uLine, edge(p, 0.0, uScatter));
    gl_FragColor = vec4(col, 1.0);
}
`;

let outlineShader = null;
// Frames left in the current burst, and the pattern it's showing
let burstFrames = 0;
let burstSeed = 1;

function drawOutline() {
  if (!prepareGL()) {
    background(0);
    return;
  }
  outlineShader ??= makeShader(OUTLINE_FRAG);
  drawGLSource(params.outlineSurround, params.outlineBlur);

  const s = outlineShader;
  s.setUniform("uTexture", glSource);
  s.setUniform("uResolution", [width, height]);
  setGlitchPattern(s);
  s.setUniform("uThreshold", params.outlineThreshold / 255);
  s.setUniform("uInvert", params.invert ? 1 : 0);
  s.setUniform("uLineWidth", params.outlineWidth);

  s.setUniform("uRegion", params.outlineRegion);
  s.setUniform("uSmoothChance", params.outlineSmooth);
  s.setUniform("uStepMin", params.outlineStepMin);
  s.setUniform("uStepMax", params.outlineStepMax);
  s.setUniform("uScatter", params.outlineScatter);
  s.setUniform("uSliceChance", params.outlineSliceChance);
  s.setUniform("uSliceMax", params.outlineSliceMax);
  s.setUniform("uSliceHeight", params.outlineSliceHeight);

  s.setUniform("uEchoes", params.outlineEchoes);
  s.setUniform("uEchoScale", params.outlineEchoScale);
  s.setUniform("uEchoOffset", [params.outlineEchoX, params.outlineEchoY]);
  s.setUniform("uEchoScatter", params.outlineEchoScatter);
  s.setUniform("uEchoFade", params.outlineEchoFade);

  s.setUniform("uBg", unitRGB(params.outlineBackground));
  s.setUniform("uLine", unitRGB(params.outlineLine));
  s.setUniform("uEcho", unitRGB(params.outlineEcho));
  drawShader(s);
}

// Choose this frame's glitch: normally a blend from one tick's pattern to
// the next, outlineRate patterns a second at 60 fps, or during a burst a
// harder pattern shown as-is, with no blending
function setGlitchPattern(s) {
  if (burstFrames > 0) {
    burstFrames--;
  } else if (Math.random() < params.outlineBurstChance / 60) {
    burstFrames = params.outlineBurstLength;
  }

  if (burstFrames > 0) {
    // Cut to a new pattern every couple of frames, so a burst stutters
    if (burstFrames % 2 === 0) {
      burstSeed = 1 + Math.floor(Math.random() * 996);
    }
    s.setUniform("uSeedA", burstSeed);
    s.setUniform("uSeedB", burstSeed);
    s.setUniform("uMix", 0);
    s.setUniform("uCleanA", 0);
    s.setUniform("uCleanB", 0);
    s.setUniform("uIntensity", params.outlineBurstIntensity);
    return;
  }

  const position = (frameCount * params.outlineRate) / 60;
  const tick = Math.floor(position);
  // Each tick holds its pattern, then spends the last `outlineTransition`
  // of its time easing into the next one (0 = cut instantly)
  const transition = params.outlineTransition;
  const t =
    transition > 0
      ? constrain((position - tick - (1 - transition)) / transition, 0, 1)
      : 0;

  s.setUniform("uSeedA", (tick % 997) + 1);
  s.setUniform("uSeedB", ((tick + 1) % 997) + 1);
  s.setUniform("uMix", t * t * (3 - 2 * t));
  s.setUniform("uCleanA", tickRandom(tick) < params.outlineClean ? 1 : 0);
  s.setUniform("uCleanB", tickRandom(tick + 1) < params.outlineClean ? 1 : 0);
  s.setUniform("uIntensity", 1);
}

// Repeatable random number 0..1 for a glitch tick
function tickRandom(tick) {
  const x = Math.sin(tick * 12.9898 + 4.1414) * 43758.5453;
  return x - Math.floor(x);
}
