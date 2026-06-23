const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const ROOT = __dirname;
const DATA_FILE = path.join(ROOT, "portfolio-data.json");
const PORT = Number(process.env.PORT || 4173);
const EDIT_NICKNAME = process.env.EDIT_NICKNAME || "";
const EDIT_PASSWORD = process.env.EDIT_PASSWORD || "";
const sessions = new Map();

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf"
};

function sendJson(res, status, payload) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(JSON.stringify(payload));
}

function readJsonBody(req, limit = 12 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
      if (Buffer.byteLength(body) > limit) {
        reject(new Error("Request body is too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(body || "{}"));
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function sessionFrom(req) {
  const cookie = req.headers.cookie || "";
  const match = cookie.match(/(?:^|;\s*)portfolio_session=([^;]+)/);
  if (!match) return null;
  const session = sessions.get(match[1]);
  if (!session || session.expiresAt < Date.now()) {
    if (match[1]) sessions.delete(match[1]);
    return null;
  }
  return match[1];
}

function requireSession(req, res) {
  if (sessionFrom(req)) return true;
  sendJson(res, 401, { error: "Authentication required" });
  return false;
}

function cleanText(value, max = 5000) {
  return String(value == null ? "" : value).slice(0, max);
}

function cleanLocalized(value) {
  return {
    en: cleanText(value && value.en),
    tr: cleanText(value && value.tr)
  };
}

function cleanUrl(value) {
  const text = cleanText(value, 2000).trim();
  if (!text) return "";
  try {
    const url = new URL(text);
    return ["http:", "https:"].includes(url.protocol) ? url.href : "";
  } catch {
    return "";
  }
}

function cleanImage(value) {
  const text = cleanText(value, 8 * 1024 * 1024).trim();
  if (text.startsWith("data:image/")) return text;
  if (/^https?:\/\//i.test(text)) return cleanUrl(text);
  if (!text.includes("..") && !text.startsWith("/") && !text.includes("\\")) return text;
  return "assets/a-star-cropped.png";
}

function validatePortfolio(input) {
  if (!input || !Array.isArray(input.projects)) throw new Error("Projects must be an array");
  if (input.projects.length > 100) throw new Error("Too many projects");

  const ids = new Set();
  const projects = input.projects.map((project, index) => {
    const baseId = cleanText(project.id || `project-${index + 1}`, 80)
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "") || `project-${index + 1}`;
    let id = baseId;
    let suffix = 2;
    while (ids.has(id)) id = `${baseId}-${suffix++}`;
    ids.add(id);

    return {
      id,
      title: cleanText(project.title, 160),
      image: cleanImage(project.image),
      featured: Boolean(project.featured),
      subtitle: cleanLocalized(project.subtitle),
      meta: cleanLocalized(project.meta),
      summary: cleanLocalized(project.summary),
      details: {
        en: Array.isArray(project.details && project.details.en) ? project.details.en.slice(0, 30).map((item) => cleanText(item, 2000)) : [],
        tr: Array.isArray(project.details && project.details.tr) ? project.details.tr.slice(0, 30).map((item) => cleanText(item, 2000)) : []
      },
      paperUrl: cleanUrl(project.paperUrl),
      huggingFaceUrl: cleanUrl(project.huggingFaceUrl)
    };
  });

  const featuredCount = projects.filter((project) => project.featured).length;
  if (projects.length >= 3 && featuredCount !== 3) {
    throw new Error("Select exactly three featured projects");
  }

  return {
    about: {
      en: {
        p1: cleanText(input.about && input.about.en && input.about.en.p1),
        p2: cleanText(input.about && input.about.en && input.about.en.p2)
      },
      tr: {
        p1: cleanText(input.about && input.about.tr && input.about.tr.p1),
        p2: cleanText(input.about && input.about.tr && input.about.tr.p2)
      }
    },
    projects
  };
}

async function serveFile(res, relativePath) {
  const decoded = decodeURIComponent(relativePath);
  const requested = path.resolve(ROOT, `.${decoded}`);
  if (!requested.startsWith(`${ROOT}${path.sep}`) && requested !== ROOT) {
    sendJson(res, 403, { error: "Forbidden" });
    return;
  }

  try {
    const stat = await fs.promises.stat(requested);
    if (!stat.isFile()) throw new Error("Not a file");
    res.writeHead(200, {
      "Content-Type": mimeTypes[path.extname(requested).toLowerCase()] || "application/octet-stream",
      "Cache-Control": path.extname(requested) === ".html" ? "no-cache" : "public, max-age=3600"
    });
    fs.createReadStream(requested).pipe(res);
  } catch {
    sendJson(res, 404, { error: "Not found" });
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

  if (req.method === "GET" && url.pathname === "/api/portfolio") {
    try {
      const data = JSON.parse(await fs.promises.readFile(DATA_FILE, "utf8"));
      sendJson(res, 200, data);
    } catch {
      sendJson(res, 500, { error: "Could not read portfolio data" });
    }
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/session") {
    sendJson(res, 200, { authenticated: Boolean(sessionFrom(req)) });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/login") {
    try {
      if (!EDIT_NICKNAME || !EDIT_PASSWORD) {
        sendJson(res, 503, { error: "Editor credentials are not configured" });
        return;
      }
      const body = await readJsonBody(req, 16 * 1024);
      if (!safeEqual(body.nickname, EDIT_NICKNAME) || !safeEqual(body.password, EDIT_PASSWORD)) {
        sendJson(res, 401, { error: "Invalid nickname or password" });
        return;
      }
      const token = crypto.randomBytes(32).toString("hex");
      sessions.set(token, { expiresAt: Date.now() + 8 * 60 * 60 * 1000 });
      res.setHeader("Set-Cookie", `portfolio_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800`);
      sendJson(res, 200, { authenticated: true });
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/logout") {
    const token = sessionFrom(req);
    if (token) sessions.delete(token);
    res.setHeader("Set-Cookie", "portfolio_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0");
    sendJson(res, 200, { authenticated: false });
    return;
  }

  if (req.method === "PUT" && url.pathname === "/api/portfolio") {
    if (!requireSession(req, res)) return;
    try {
      const clean = validatePortfolio(await readJsonBody(req));
      const tempFile = `${DATA_FILE}.tmp`;
      await fs.promises.writeFile(tempFile, `${JSON.stringify(clean, null, 2)}\n`, "utf8");
      await fs.promises.rename(tempFile, DATA_FILE);
      sendJson(res, 200, clean);
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return;
  }

  if (req.method !== "GET") {
    sendJson(res, 405, { error: "Method not allowed" });
    return;
  }

  if (url.pathname === "/") {
    await serveFile(res, "/index.html");
    return;
  }
  if (url.pathname === "/edit" || url.pathname === "/edit/") {
    await serveFile(res, "/edit.html");
    return;
  }
  await serveFile(res, url.pathname);
});

server.listen(PORT, () => {
  console.log(`Portfolio: http://localhost:${PORT}`);
  console.log(`Editor:    http://localhost:${PORT}/edit`);
});
