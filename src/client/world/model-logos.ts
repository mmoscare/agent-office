import * as THREE from 'three';
import { MODEL_BRAND_LABEL, type ModelBrand } from '../../shared/model-brand';

const SIZE = 256;
const textures = new Map<ModelBrand, THREE.CanvasTexture>();
const urls = new Map<ModelBrand, string>();

/** World size of the badge above a worker, in the seat's local space (the seat is scaled down). */
export const MODEL_LOGO_SCALE = 0.52;

function canvasFor(brand: ModelBrand): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = SIZE;
  canvas.height = SIZE;
  drawLogo(canvas.getContext('2d')!, brand, SIZE);
  return canvas;
}

function texture(brand: ModelBrand): THREE.CanvasTexture {
  const hit = textures.get(brand);
  if (hit) return hit;
  const tex = new THREE.CanvasTexture(canvasFor(brand));
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  tex.needsUpdate = true;
  textures.set(brand, tex);
  return tex;
}

/** A camera-facing mark. The texture is shared; dispose the material, not the map. */
export function logoSprite(brand: ModelBrand): THREE.Sprite {
  const mat = new THREE.SpriteMaterial({ map: texture(brand), transparent: true, depthWrite: false, toneMapped: false });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(MODEL_LOGO_SCALE, MODEL_LOGO_SCALE, 1);
  sprite.center.set(0.5, 0);
  sprite.renderOrder = 12;
  return sprite;
}

export function disposeLogoSprite(sprite: THREE.Sprite) {
  sprite.material.dispose();
}

export function modelLogoUrl(brand: ModelBrand): string {
  const hit = urls.get(brand);
  if (hit) return hit;
  const url = canvasFor(brand).toDataURL('image/png');
  urls.set(brand, url);
  return url;
}

/** Transparent PNG of the mark, for the workers list and the terminal header. */
export function modelLogoEl(brand: ModelBrand, detail?: string): HTMLImageElement {
  const img = document.createElement('img');
  img.className = 'model-logo';
  img.alt = MODEL_BRAND_LABEL[brand];
  img.title = detail ? `${MODEL_BRAND_LABEL[brand]} · ${detail}` : MODEL_BRAND_LABEL[brand];
  img.draggable = false;
  img.src = modelLogoUrl(brand);
  return img;
}

function drawLogo(ctx: CanvasRenderingContext2D, brand: ModelBrand, s: number) {
  switch (brand) {
    case 'xai':
      return drawXai(ctx, s);
    case 'openai':
      return drawChatGpt(ctx, s);
    case 'anthropic':
      return drawAnthropic(ctx, s);
    case 'google':
      return drawGemini(ctx, s);
    case 'meta':
      return drawLlama(ctx, s);
    case 'mistral':
      return drawMistral(ctx, s);
    case 'deepseek':
      return drawDeepSeek(ctx, s);
    case 'qwen':
      return drawQwen(ctx, s);
    case 'cohere':
      return drawCohere(ctx, s);
    case 'perplexity':
      return drawPerplexity(ctx, s);
    case 'amazon':
      return drawAmazon(ctx, s);
    case 'microsoft':
      return drawMicrosoft(ctx, s);
    default: {
      const never: never = brand;
      return never;
    }
  }
}

/** xAI's X, no plate behind it. */
function drawXai(ctx: CanvasRenderingContext2D, s: number) {
  const a = s * 0.14;
  const b = s * 0.86;
  const mid = s * 0.5;
  const thick = s * 0.13;
  ctx.fillStyle = '#111111';
  ctx.beginPath();
  ctx.moveTo(a, a);
  ctx.lineTo(a + thick * 1.35, a);
  ctx.lineTo(mid, mid - thick * 0.72);
  ctx.lineTo(b - thick * 1.35, a);
  ctx.lineTo(b, a);
  ctx.lineTo(mid + thick * 0.72, mid);
  ctx.lineTo(b, b);
  ctx.lineTo(b - thick * 1.35, b);
  ctx.lineTo(mid, mid + thick * 0.72);
  ctx.lineTo(a + thick * 1.35, b);
  ctx.lineTo(a, b);
  ctx.lineTo(mid - thick * 0.72, mid);
  ctx.closePath();
  ctx.fill();
}

/** Six interlocking loops: the ChatGPT / OpenAI knot, on a clear background. */
function drawChatGpt(ctx: CanvasRenderingContext2D, s: number) {
  const c = s / 2;
  const ring = s * 0.2;
  const r = s * 0.155;
  ctx.fillStyle = '#111111';
  for (let i = 0; i < 6; i++) {
    const a = (Math.PI / 3) * i - Math.PI / 2;
    ctx.beginPath();
    ctx.arc(c + Math.cos(a) * ring, c + Math.sin(a) * ring, r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalCompositeOperation = 'destination-out';
  for (let i = 0; i < 6; i++) {
    const a = (Math.PI / 3) * i - Math.PI / 2;
    ctx.beginPath();
    ctx.arc(c + Math.cos(a) * ring, c + Math.sin(a) * ring, r * 0.46, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.beginPath();
  ctx.arc(c, c, s * 0.055, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalCompositeOperation = 'source-over';
}

/** Anthropic's clay starburst. */
function drawAnthropic(ctx: CanvasRenderingContext2D, s: number) {
  ctx.save();
  ctx.translate(s / 2, s / 2);
  ctx.fillStyle = '#C4563A';
  const rays = 8;
  for (let i = 0; i < rays; i++) {
    ctx.save();
    ctx.rotate((Math.PI * 2 * i) / rays);
    ctx.beginPath();
    ctx.roundRect(-s * 0.055, -s * 0.42, s * 0.11, s * 0.28, s * 0.055);
    ctx.fill();
    ctx.restore();
  }
  ctx.beginPath();
  ctx.arc(0, 0, s * 0.11, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

/** Gemini's four-point spark. */
function drawGemini(ctx: CanvasRenderingContext2D, s: number) {
  spark(ctx, s * 0.5, s * 0.52, s * 0.4, '#4285F4');
  spark(ctx, s * 0.72, s * 0.28, s * 0.14, '#EA4335');
}

function spark(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, color: string) {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(x, y - r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.quadraticCurveTo(x, y, x, y + r);
  ctx.quadraticCurveTo(x, y, x - r, y);
  ctx.quadraticCurveTo(x, y, x, y - r);
  ctx.closePath();
  ctx.fill();
}

/** A small llama, for Llama models. */
function drawLlama(ctx: CanvasRenderingContext2D, s: number) {
  ctx.fillStyle = '#0668E1';
  ctx.beginPath();
  ctx.ellipse(s * 0.4, s * 0.62, s * 0.22, s * 0.15, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillRect(s * 0.5, s * 0.32, s * 0.09, s * 0.28);
  ctx.beginPath();
  ctx.ellipse(s * 0.66, s * 0.3, s * 0.16, s * 0.1, 0.4, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(s * 0.58, s * 0.24);
  ctx.lineTo(s * 0.52, s * 0.08);
  ctx.lineTo(s * 0.68, s * 0.22);
  ctx.closePath();
  ctx.fill();
  ctx.fillRect(s * 0.26, s * 0.7, s * 0.07, s * 0.16);
  ctx.fillRect(s * 0.46, s * 0.7, s * 0.07, s * 0.16);
}

function drawMistral(ctx: CanvasRenderingContext2D, s: number) {
  ctx.fillStyle = '#FF6A00';
  ctx.beginPath();
  ctx.moveTo(s * 0.12, s * 0.8);
  ctx.lineTo(s * 0.12, s * 0.2);
  ctx.lineTo(s * 0.3, s * 0.2);
  ctx.lineTo(s * 0.5, s * 0.48);
  ctx.lineTo(s * 0.7, s * 0.2);
  ctx.lineTo(s * 0.88, s * 0.2);
  ctx.lineTo(s * 0.88, s * 0.8);
  ctx.lineTo(s * 0.7, s * 0.8);
  ctx.lineTo(s * 0.7, s * 0.46);
  ctx.lineTo(s * 0.5, s * 0.68);
  ctx.lineTo(s * 0.3, s * 0.46);
  ctx.lineTo(s * 0.3, s * 0.8);
  ctx.closePath();
  ctx.fill();
}

function drawDeepSeek(ctx: CanvasRenderingContext2D, s: number) {
  ctx.fillStyle = '#4D6BFE';
  ctx.beginPath();
  ctx.ellipse(s * 0.52, s * 0.56, s * 0.3, s * 0.16, -0.15, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(s * 0.24, s * 0.52);
  ctx.quadraticCurveTo(s * 0.08, s * 0.28, s * 0.2, s * 0.42);
  ctx.quadraticCurveTo(s * 0.08, s * 0.7, s * 0.26, s * 0.62);
  ctx.closePath();
  ctx.fill();
  ctx.beginPath();
  ctx.ellipse(s * 0.7, s * 0.48, s * 0.08, s * 0.05, 0.4, 0, Math.PI * 2);
  ctx.fill();
}

function drawQwen(ctx: CanvasRenderingContext2D, s: number) {
  ctx.strokeStyle = '#615CED';
  ctx.fillStyle = '#615CED';
  ctx.lineWidth = s * 0.1;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.arc(s * 0.46, s * 0.46, s * 0.24, 0.4, Math.PI * 2 - 0.2);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(s * 0.62, s * 0.62);
  ctx.lineTo(s * 0.8, s * 0.82);
  ctx.stroke();
}

function drawCohere(ctx: CanvasRenderingContext2D, s: number) {
  ctx.strokeStyle = '#FF7759';
  ctx.lineWidth = s * 0.12;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.arc(s / 2, s / 2, s * 0.28, 0.7, Math.PI * 2 - 0.5);
  ctx.stroke();
}

function drawPerplexity(ctx: CanvasRenderingContext2D, s: number) {
  ctx.save();
  ctx.translate(s / 2, s / 2);
  ctx.fillStyle = '#20808D';
  for (let i = 0; i < 6; i++) {
    ctx.save();
    ctx.rotate((Math.PI * i) / 3);
    ctx.beginPath();
    ctx.roundRect(-s * 0.045, -s * 0.4, s * 0.09, s * 0.8, s * 0.045);
    ctx.fill();
    ctx.restore();
  }
  ctx.restore();
}

function drawAmazon(ctx: CanvasRenderingContext2D, s: number) {
  ctx.strokeStyle = '#FF9900';
  ctx.fillStyle = '#FF9900';
  ctx.lineWidth = s * 0.08;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.arc(s / 2, s * 0.4, s * 0.26, 0.15 * Math.PI, 0.85 * Math.PI);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(s * 0.74, s * 0.58);
  ctx.lineTo(s * 0.86, s * 0.5);
  ctx.lineTo(s * 0.78, s * 0.7);
  ctx.closePath();
  ctx.fill();
}

function drawMicrosoft(ctx: CanvasRenderingContext2D, s: number) {
  const g = s * 0.06;
  const b = (s - g * 3) / 2;
  const colors = ['#F25022', '#7FBA00', '#00A4EF', '#FFB900'];
  colors.forEach((color, i) => {
    ctx.fillStyle = color;
    ctx.fillRect(g + (i % 2) * (b + g), g + (i < 2 ? 0 : 1) * (b + g), b, b);
  });
}
