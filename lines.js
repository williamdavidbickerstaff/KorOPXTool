// The Lines effect, from 28:10:26/Lines: rows of horizontal lines that
// thicken where the picture is dark, drawn by a shader. Every number that
// was written into the shader is now a uniform fed from the settings.
// The buffers and vertex shader it draws with are in webgl.js

const LINES_FRAG = `
precision highp float;

uniform sampler2D uTexture;
uniform vec2  uResolution;   // device pixels
uniform float uPitch;        // row height in device pixels, EVEN whole number
uniform float uMinHalf;      // half-thickness in px for bright areas, e.g. 1.0
uniform float uGap;          // gap left between rows in px where it's darkest
uniform float uCurve;        // how quickly lines thicken as the picture darkens
uniform float uEdge;         // width of the antialiased edge in px
uniform float uInvert;       // 1.0 swaps light and dark
uniform float uThreshold;    // brightness (0..1) where lines are half thickness
uniform float uSoftness;     // brightness range (0..1) the change happens over
uniform vec3  uBg;
uniform vec3  uInk;

varying vec2 vUv;

void main() {
    float y         = gl_FragCoord.y;
    float rowIndex  = floor(y / uPitch);
    float rowCenter = (rowIndex + 0.5) * uPitch / uResolution.y;

    // distance from the row centre in device pixels (symmetric)
    float dPx = abs(y - (rowIndex + 0.5) * uPitch);

    vec3 col = texture2D(uTexture, vec2(vUv.x, 1.0 - rowCenter)).rgb;
    float luma = dot(col, vec3(0.299, 0.587, 0.114));
    luma = mix(luma, 1.0 - luma, uInvert);

    // Stretch the brightness around the threshold: the full 0..1 range at
    // softness 1, down to a hard thick-or-thin cut at softness 0
    float soft = max(uSoftness, 0.001);
    luma = clamp((luma - (uThreshold - soft * 0.5)) / soft, 0.0, 1.0);

    float maxHalf = max(uMinHalf, (uPitch - uGap) * 0.5);
    float halfW   = mix(uMinHalf, maxHalf, pow(clamp(1.0 - luma, 0.0, 1.0), uCurve));

    // antialiased edge, uEdge px wide
    float line = 1.0 - smoothstep(halfW - uEdge * 0.5, halfW + uEdge * 0.5, dPx);

    gl_FragColor = vec4(mix(uBg, uInk, line), 1.0);
}
`;

let linesShader = null;

function drawLines() {
  if (!prepareGL()) {
    background(0);
    return;
  }
  linesShader ??= makeShader(LINES_FRAG);
  // The blur softens the picture so the lines get rounded, lens-shaped ends
  drawGLSource(params.linesSurround, params.lineBlur);

  linesShader.setUniform("uTexture", glSource);
  linesShader.setUniform("uResolution", [width, height]);
  linesShader.setUniform("uPitch", params.lineSpacing);
  linesShader.setUniform("uMinHalf", params.lineMin / 2);
  linesShader.setUniform("uGap", params.lineGap);
  linesShader.setUniform("uCurve", params.lineCurve);
  // A zero-width edge would make smoothstep undefined
  linesShader.setUniform("uEdge", max(0.01, params.lineEdge));
  linesShader.setUniform("uInvert", params.invert ? 1 : 0);
  linesShader.setUniform("uThreshold", params.lineThreshold / 255);
  linesShader.setUniform("uSoftness", params.lineSoftness / 255);
  linesShader.setUniform("uBg", unitRGB(params.linesBackground));
  linesShader.setUniform("uInk", unitRGB(params.linesInk));
  drawShader(linesShader);
}
