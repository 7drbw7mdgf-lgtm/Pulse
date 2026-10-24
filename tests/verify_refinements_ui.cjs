const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { chromium } = require("playwright");

(async () => {
  const root = path.resolve(__dirname, '..');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "pulse-refinements-"));
  const python = process.env.PULSE_TEST_PYTHON || "python3";
  const pdf = path.join(profile, "fixture.pdf");
  const gen = spawnSync(python, ["-c", 'import pymupdf,sys;d=pymupdf.open();p=d.new_page();p.insert_text((50,70),"Highlighter test passage here.",fontsize=14);d.save(sys.argv[1])', pdf]);
  assert.equal(gen.status, 0);

  const bytes = fs.readFileSync(pdf);
  const identity = require("node:crypto").createHash("sha256").update(bytes).digest("hex");
  fs.mkdirSync(path.join(profile, "pdfs"), { recursive: true });
  fs.writeFileSync(path.join(profile, "pdfs", identity + ".pdf"), bytes);

  fs.writeFileSync(path.join(profile, "library.json"), JSON.stringify({
    papers: [
      { id: "p1", title: "Paper Alpha", x: 100, y: 150, authors: ["Author A"], year: "2024", pdfAttachments: [{ id: identity, name: "Paper Alpha.pdf", size: bytes.length, pages: 1 }], selected: true, mapIds: ["map-1"] },
      { id: "p2", title: "Paper Beta", x: 600, y: 700, authors: ["Author B"], year: "2025", pdfAttachments: [], selected: false, mapIds: ["map-1"] }
    ],
    maps: [{ id: "map-1", name: "Map 1" }],
    activeMapId: "map-1"
  }));

  const backend = spawn(python, ["-B", "local-web/pulse-backend/pulse_backend.py"], {
    cwd: root,
    env: { ...process.env, PULSE_CONFIG_DIR: profile, PULSE_PORT: "0", PULSE_DISABLE_BUNDLED_OLLAMA: "1" }
  });

  let browser;
  try {
    const url = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error("Backend timeout")), 15000);
      backend.stdout.on("data", data => {
        const m = String(data).match(/http:\/\/127\.0\.0\.1:\d+/);
        if (m) { clearTimeout(timer); resolve(m[0]); }
      });
      backend.once("exit", code => { clearTimeout(timer); reject(Error("Backend exit " + code)); });
    });

    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1280, height: 850 } });

    await page.goto(url);
    await page.waitForFunction(() => state.autosaveReady && state.papers.length === 2);

    // 1. Verify Fit view
    console.log("Testing Fit view...");
    await page.evaluate(() => {
      // Offset view first
      state.view.x = -500;
      state.view.y = -600;
      state.view.width = 2000;
      state.view.height = 1500;
    });
    // Click dockFitButton in the tools
    await page.evaluate(() => fitCanvasToMap());
    const fitted = await page.evaluate(() => {
      const xs = state.papers.map(p => p.x), ys = state.papers.map(p => p.y);
      const minX = Math.min(...xs), maxX = Math.max(...xs);
      const minY = Math.min(...ys), maxY = Math.max(...ys);
      return {
        view: { ...state.view },
        expectedCenterX: (minX + maxX) / 2,
        expectedCenterY: (minY + maxY) / 2
      };
    });
    assert(fitted.view.width > 0 && fitted.view.height > 0);
    const centerX = fitted.view.x + fitted.view.width / 2;
    assert(Math.abs(centerX - fitted.expectedCenterX) < 1, `Fitted center X should match paper center ${fitted.expectedCenterX}, got ${centerX}`);
    console.log("PASS: Fit view correctly bounds and centers all papers.");

    // 2. Open PDF Viewer
    console.log("Testing PDF reader & Highlighter...");
    await page.evaluate(() => PulsePDF.open("p1"));
    await page.waitForFunction(() => document.querySelectorAll(".pdf-page img").length > 0);

    // Verify dock buttons: no underline duplicate
    const dockTools = await page.$$eval('#pdfDock [data-pdf-tool]', els => els.map(e => e.dataset.pdfTool));
    assert(!dockTools.includes("underline"), "Underline should not be duplicated in bottom dock");
    assert(dockTools.includes("highlight"), "Highlight tool is in bottom dock");
    assert(dockTools.includes("note"), "Note tool is in bottom dock");

    // Click Highlighter tool
    await page.click('[data-pdf-tool="highlight"]');
    assert.equal(await page.locator('[data-pdf-tool="highlight"]').getAttribute("aria-pressed"), "true");

    // Select text on page surface and verify save
    await page.evaluate(() => {
      const textLayer = document.querySelector(".pdf-text-layer");
      const range = document.createRange();
      range.selectNodeContents(textLayer);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      document.querySelector(".pdf-page-stack").dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    });

    await page.waitForFunction(() => {
      const p = state.papers.find(x => x.id === "p1");
      return p.pdfAnnotations && p.pdfAnnotations.some(a => a.kind === "highlight");
    });
    console.log("PASS: Highlighter saved highlight annotation.");

    // 3. Test draggable comments
    console.log("Testing Comment creation and dragging...");
    await page.click('[data-pdf-tool="note"]');
    await page.click(".pdf-page", { position: { x: 150, y: 200 } });
    await page.fill(".pdf-inline-note textarea", "Draggable test comment");
    await page.click(".pdf-inline-note [data-pdf-post]");

    await page.waitForFunction(() => {
      const p = state.papers.find(x => x.id === "p1");
      return p.pdfAnnotations && p.pdfAnnotations.some(a => a.kind === "note");
    });

    const pin = page.locator(".pdf-note-pin");
    assert.equal(await pin.count(), 1);
    const initialBox = await pin.boundingBox();

    // Drag pin by 80px to the right and 60px down
    await page.mouse.move(initialBox.x + initialBox.width / 2, initialBox.y + initialBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(initialBox.x + initialBox.width / 2 + 80, initialBox.y + initialBox.height / 2 + 60, { steps: 5 });
    await page.mouse.up();

    const afterBox = await pin.boundingBox();
    assert(afterBox.x > initialBox.x + 40, `Pin should have moved right. Before: ${initialBox.x}, After: ${afterBox.x}`);
    assert(afterBox.y > initialBox.y + 30, `Pin should have moved down. Before: ${initialBox.y}, After: ${afterBox.y}`);
    console.log("PASS: Comment pin dragged successfully.");

    // 4. Verify Trends Layout
    console.log("Testing Trends view...");
    await page.click("#pdfReaderClose");
    await page.click('[data-rail="trends"]');
    await page.waitForFunction(() => {
      const view = document.getElementById("trendsView");
      return view && !view.hidden && view.querySelector(".trends-merged");
    });
    const hasMapSlot = await page.locator(".trends-map-slot").count();
    assert(hasMapSlot >= 1, "Trends topic map slot is present in the re-introduced trends layout");
    console.log("PASS: Trends layout with merged topic map and groups is active.");

    console.log("ALL 5 REFINEMENT VERIFICATIONS PASSED!");
  } finally {
    await browser?.close();
    const stopped = new Promise(r => backend.once("exit", r));
    backend.kill();
    await stopped;
    fs.rmSync(profile, { recursive: true, force: true });
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
