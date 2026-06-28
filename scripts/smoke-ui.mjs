import { chromium } from "@playwright/test";

const baseUrl = process.env.VCAD_SMOKE_URL || "http://localhost:8080";

async function launchBrowser() {
  try {
    return await chromium.launch({ channel: "msedge" });
  } catch {
    return chromium.launch();
  }
}

async function sampleCanvas(canvas) {
  return canvas.evaluate((node) => {
    const gl = node.getContext("webgl2") || node.getContext("webgl");
    if (!gl) return { width: node.width, height: node.height, samples: [], nonBlank: false };
    const points = [
      [0.5, 0.5],
      [0.42, 0.42],
      [0.58, 0.58],
      [0.35, 0.65],
      [0.65, 0.35]
    ];
    const samples = points.map(([px, py]) => {
      const pixel = new Uint8Array(4);
      gl.readPixels(Math.floor(node.width * px), Math.floor(node.height * py), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
      return Array.from(pixel);
    });
    const nonBlank = samples.some(([r, g, b, a]) => a > 0 && (Math.abs(r - g) > 2 || Math.abs(g - b) > 2 || r < 245));
    return { width: node.width, height: node.height, samples, nonBlank };
  });
}

async function checkViewport(browser, width, height) {
  const page = await browser.newPage({ viewport: { width, height } });
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: /sign in/i }).click();
  await page.waitForSelector(".cad-panel", { timeout: 15000 });
  const canvases = await page.locator(".viewport-3d canvas").all();
  if (canvases.length < 1) {
    throw new Error(`No CAD canvas rendered at ${width}x${height}`);
  }
  const samples = [];
  for (const canvas of canvases) {
    samples.push(await sampleCanvas(canvas));
  }
  if (!samples.some((sample) => sample.nonBlank && sample.width > 0 && sample.height > 0)) {
    throw new Error(`CAD canvas pixels were blank at ${width}x${height}: ${JSON.stringify(samples)}`);
  }
  await page.close();
  return { width, height, canvases: samples.length };
}

const browser = await launchBrowser();
try {
  const results = [];
  results.push(await checkViewport(browser, 1440, 920));
  results.push(await checkViewport(browser, 390, 844));
  console.log(JSON.stringify({ ok: true, results }, null, 2));
} finally {
  await browser.close();
}
