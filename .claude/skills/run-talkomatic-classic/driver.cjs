#!/usr/bin/env node
// Drives talkomatic's room.html in headless Chrome, one or more users at once.
// Reads commands from stdin, one per line (heredoc for a script, or tmux for
// an interactive session). See SKILL.md for setup.
//
//   open <id> phone|desktop [path]   log in, join as display name <id>
//                                     (path defaults to /room.html)
//   type <id> <text>                  insert text into <id>'s own box
//   tap  <id> <selector>              touch tap (phone)
//   click <id> <selector>             mouse click
//   text <id> [selector]              print textContent (default: own box)
//   peer <id> <name>                  print the text <id> sees in <name>'s box
//   eval <id> <js expression>         print the result
//   ss   <id> [name]                  screenshot -> $TK_OUT/<name>.png
//   wait <ms>
//   quit
//
// Env: TK_PORT (3123), TK_OUT (screenshot dir), TK_PW_DIR (where
// playwright-core is installed).

const path = require("path");
const os = require("os");
const fs = require("fs");
const readline = require("readline");

const PW_DIR = process.env.TK_PW_DIR || path.join(os.tmpdir(), "tk-pw");
let chromium;
try {
  ({ chromium } = require(require.resolve("playwright-core", { paths: [PW_DIR] })));
} catch {
  console.error(
    `playwright-core not found in ${PW_DIR}. Run:\n  npm install --prefix ${PW_DIR} playwright-core@1.48.2`,
  );
  process.exit(1);
}

const BASE = `http://localhost:${process.env.TK_PORT || 3123}`;
const OUT = process.env.TK_OUT || path.join(os.tmpdir(), "tk-run-shots");
fs.mkdirSync(OUT, { recursive: true });

const OWN = ".chat-row.current-user .chat-input";
const DEVICES = {
  phone: {
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    userAgent:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
  },
  desktop: { viewport: { width: 1280, height: 800 } },
};

const RAW_TAIL = new Set(["type", "tap", "click", "text", "peer", "eval"]);
let browser;
const pages = new Map();

function page(id) {
  const p = pages.get(id);
  if (!p) throw new Error(`no user "${id}" - open it first`);
  return p;
}

// The room's error modal (rate limit, kicked, ...) silently swallows every
// later tap/click, so surface it as soon as it shows up.
async function reportModal(id, p) {
  const msg = await p
    .$eval("#customModal.show", (m) => m.innerText.replace(/\s+/g, " ").trim())
    .catch(() => null);
  if (msg) console.log(`[${id}] MODAL OPEN: ${msg}`);
}

const commands = {
  async open(id, kind = "desktop", urlPath = "/room.html") {
    if (!DEVICES[kind]) throw new Error(`device must be phone|desktop`);
    const ctx = await browser.newContext(DEVICES[kind]);
    // The login form can't be submitted from the page: /login sends
    // Referrer-Policy: no-referrer, so Chrome posts it with Origin: null and
    // the CORS check rejects it. A request made through the context sends no
    // Origin and shares the cookie jar with the page.
    const res = await ctx.request.post(`${BASE}/login`, {
      form: { name: "tester", password: "testpw", next: urlPath },
      maxRedirects: 0,
    });
    if (res.status() !== 303)
      throw new Error(`login failed (${res.status()}) - did serve.sh start run?`);
    const p = await ctx.newPage();
    p.on("pageerror", (e) => console.log(`[${id}] pageerror: ${e.message}`));
    p.on("console", (m) => {
      if (m.type() === "error") console.log(`[${id}] console.error: ${m.text()}`);
    });
    await p.goto(BASE + urlPath);
    try {
      await p.waitForSelector("#nameEntryInput", { state: "visible", timeout: 15000 });
      await p.fill("#nameEntryInput", id);
      await p.click("#nameEntryConfirmBtn");
      await p.waitForSelector(OWN, { timeout: 15000 });
    } catch (e) {
      throw new Error(
        `join as "${id}" timed out. A name used in an earlier run against this ` +
          `server lingers as a ghost seat: pick a new name or rerun serve.sh start.`,
      );
    }
    pages.set(id, p);
    console.log(`[${id}] joined (${kind})`);
  },
  async type(id, text) {
    const p = page(id);
    const own = await p.$(OWN);
    const focused = await own.evaluate((el) => el === document.activeElement);
    if (!focused) await own.click();
    // insertText is one input event, like a dictation phrase. keyboard.type
    // sends one socket update per character and trips the server's 75
    // events/second limit on anything longer than a few words.
    await p.keyboard.insertText(text);
  },
  async tap(id, sel) {
    await page(id).tap(sel, { timeout: 5000 });
  },
  async click(id, sel) {
    await page(id).click(sel, { timeout: 5000 });
  },
  async text(id, sel) {
    const s = sel || OWN;
    console.log(JSON.stringify(await page(id).$eval(s, (el) => el.textContent)));
  },
  async peer(id, name) {
    const t = await page(id).evaluate((n) => {
      for (const row of document.querySelectorAll(".chat-row")) {
        const nameEl = row.querySelector(".ui-name");
        if (nameEl && nameEl.textContent.trim() === n)
          return row.querySelector(".chat-input")?.textContent ?? null;
      }
      return null;
    }, name);
    console.log(JSON.stringify(t));
  },
  async eval(id, js) {
    const r = await page(id).evaluate(js);
    console.log(typeof r === "string" ? r : JSON.stringify(r));
  },
  async ss(id, name) {
    const file = path.join(OUT, `${name || id}.png`);
    await page(id).screenshot({ path: file });
    console.log(file);
  },
  async wait(ms) {
    await new Promise((r) => setTimeout(r, Number(ms) || 500));
  },
};

(async () => {
  browser = await chromium.launch({ channel: "chrome", headless: true });
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  for await (const raw of rl) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    console.log(`> ${line}`);
    const [cmd, ...args] = line.split(/\s+/);
    // Commands whose last argument is free text (type, tap, click, text,
    // peer, eval) get the raw rest of the line after <id>, spaces intact.
    const m = raw.match(/^\s*\S+\s+\S+ ?(.*)$/);
    const rest = m ? m[1] : "";
    if (cmd === "quit") break;
    const fn = commands[cmd];
    if (!fn) {
      console.log(`unknown command: ${cmd}`);
      continue;
    }
    try {
      await fn(...(RAW_TAIL.has(cmd) ? [args[0], rest || undefined] : args));
    } catch (e) {
      console.log(`ERROR: ${e.message.split("\n")[0]}`);
    }
    for (const [id, p] of pages) await reportModal(id, p);
  }
  await browser.close();
})();
