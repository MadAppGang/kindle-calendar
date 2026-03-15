import puppeteer, { Browser } from "puppeteer-core";

export interface RenderOptions {
  width: number;
  height: number;
  dpi: number;
}

export interface ScreenshotResult {
  png: Buffer;
}

/**
 * Resolves the Chromium executable path.
 * In Lambda: uses @sparticuz/chromium (headless shell optimized for Lambda).
 * Locally: uses the full Puppeteer-bundled Chromium.
 */
async function getChromiumConfig(): Promise<{ executablePath: string; args: string[] }> {
  if (process.env["AWS_LAMBDA_FUNCTION_NAME"]) {
    // Running in Lambda — use @sparticuz/chromium
    const chromium = await import("@sparticuz/chromium");
    const mod = chromium.default ?? chromium;
    return {
      executablePath: await mod.executablePath(),
      args: mod.args,
    };
  }

  // Local dev — find puppeteer's bundled Chromium
  try {
    const fullPuppeteer = await import("puppeteer");
    const mod = fullPuppeteer.default ?? fullPuppeteer;
    return {
      executablePath: mod.executablePath(),
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-gpu",
        "--disable-dev-shm-usage",
      ],
    };
  } catch {
    throw new Error(
      "No Chromium found. Install 'puppeteer' for local dev or deploy to Lambda with @sparticuz/chromium."
    );
  }
}

let cachedBrowser: Browser | null = null;

async function getBrowser(): Promise<Browser> {
  if (cachedBrowser && cachedBrowser.connected) {
    return cachedBrowser;
  }

  const { executablePath, args } = await getChromiumConfig();
  cachedBrowser = await puppeteer.launch({
    executablePath,
    headless: true,
    args: [
      ...args,
      "--font-render-hinting=none",
    ],
  });

  return cachedBrowser;
}

/**
 * Renders HTML to a PNG screenshot using headless Chromium.
 * Reuses the browser instance across warm Lambda invocations.
 */
export async function renderHtmlToScreenshot(
  html: string,
  options: RenderOptions
): Promise<ScreenshotResult> {
  const browser = await getBrowser();

  const page = await browser.newPage();
  try {
    await page.setViewport({
      width: options.width,
      height: options.height,
      deviceScaleFactor: 1,
    });

    await page.setContent(html, {
      waitUntil: "networkidle0",
      timeout: 15000,
    });

    await page.evaluate("document.fonts.ready");

    const screenshot = await page.screenshot({
      type: "png",
      fullPage: false,
      clip: {
        x: 0,
        y: 0,
        width: options.width,
        height: options.height,
      },
    });

    return { png: Buffer.from(screenshot) };
  } finally {
    await page.close();
  }
}
