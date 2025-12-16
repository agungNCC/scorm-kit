// server.js
// Node >= 18 (uses global fetch)
// Endpoints: static public/, /render, /proxy, /upload, /package
import express from "express";
import morgan from "morgan";
import multer from "multer";
import archiver from "archiver";
import sanitize from "sanitize-filename";
import { v4 as uuidv4 } from "uuid";
import { pipeline } from "stream";
import { promisify } from "util";
import fs from "fs/promises";
import fsSync from "fs";
import path from "path";
import cp from "child_process";
import { fileURLToPath } from "url";
import { Readable } from "stream";


const pump = promisify(pipeline);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(morgan("dev"));

// tmp root for downloads / conversions
const tmpRoot = path.join(__dirname, "tmp");
await fs.mkdir(tmpRoot, { recursive: true });

// serve public static files
const publicDir = path.join(__dirname, "public");
app.use(express.static(publicDir));

// ---------------- multer (must be defined BEFORE routes that use it) ----------------
const uploadStorage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, tmpRoot);
    },
    filename: function (req, file, cb) {
        const ext = path.extname(file.originalname) || "";
        cb(null, `${uuidv4()}${ext}`);
    },
});
const upload = multer({
    storage: uploadStorage,
    limits: { fileSize: 200 * 1024 * 1024 }, // 200MB default
});

// ---------------- helper: convert office->pdf via LibreOffice ----------------
async function convertToPdf(inputPath, outDir) {
    return new Promise((resolve, reject) => {
        const args = ["--headless", "--convert-to", "pdf", "--outdir", outDir, inputPath];
        const proc = cp.spawn("soffice", args, { stdio: ["ignore", "pipe", "pipe"] });

        let stderr = "";
        proc.stderr.on("data", (d) => (stderr += d.toString()));
        proc.on("error", (err) => reject(err));
        proc.on("close", (code) => {
            if (code !== 0) return reject(new Error("soffice exit code " + code + " - " + stderr));
            const pdfPath = path.join(outDir, path.basename(inputPath).replace(path.extname(inputPath), ".pdf"));
            resolve(pdfPath);
        });
    });
}

// ----------------- /render : download remote office file -> convert -> serve -----------------
app.get("/render", async (req, res) => {
    try {
        const fileUrl = req.query.url;
        if (!fileUrl) return res.status(400).send("Missing url param");
        if (!/^https?:\/\//i.test(fileUrl)) return res.status(400).send("Invalid url");

        const id = uuidv4();
        const workdir = path.join(tmpRoot, id);
        await fs.mkdir(workdir, { recursive: true });

        // derive filename
        const urlPath = new URL(fileUrl).pathname;
        const rawName = path.basename(urlPath) || "presentation.pptx";
        const filename = sanitize(rawName) || "presentation.pptx";
        const inputPath = path.join(workdir, filename);

        // download remote file
        const resp = await fetch(fileUrl);
        if (!resp.ok) throw new Error("Failed to download file: " + resp.status);
        const ws = fsSync.createWriteStream(inputPath);
        await pump(resp.body, ws);

        // convert
        const pdfPath = await convertToPdf(inputPath, workdir);

        // serve static under /files/:id
        app.use(`/files/${id}`, express.static(workdir, { index: false, dotfiles: "deny" }));

        const pdfUrl = `${req.protocol}://${req.get("host")}/files/${id}/${path.basename(pdfPath)}`;

        // respond with pdf url
        res.json({ pdf: pdfUrl });

        // cleanup after 30 minutes
        setTimeout(() => fs.rm(workdir, { recursive: true, force: true }).catch(() => { }), 1000 * 60 * 30);
    } catch (err) {
        console.error("Render error:", err);
        res.status(500).send("Error processing file: " + (err.message || err));
    }
});

// ----------------- /proxy : stream external resource to client (CORS fix) -----------------
const PROXY_WHITELIST = null; // set array of hostnames to restrict if needed
app.get("/proxy", async (req, res) => {
    const target = req.query.url;
    if (!target) return res.status(400).send("Missing url");
    if (!/^https?:\/\//i.test(target)) return res.status(400).send("Invalid url");

    try {
        if (Array.isArray(PROXY_WHITELIST)) {
            const urlObj = new URL(target);
            if (!PROXY_WHITELIST.includes(urlObj.hostname)) {
                return res.status(403).send("Host not allowed");
            }
        }


        const upstream = await fetch(target);
        Readable.fromWeb(upstream.body)
        if (!upstream.ok) {
            return res.status(502).send(`Upstream returned ${upstream.status}`);
        }

        // headers
        const contentType = upstream.headers.get("content-type");
        const contentLength = upstream.headers.get("content-length");
        if (contentType) res.setHeader("Content-Type", contentType);
        if (contentLength) res.setHeader("Content-Length", contentLength);
        res.setHeader("Access-Control-Allow-Origin", "*");

        // ✅ Convert Web Stream → Node Stream
        try {
            //res.destroy(err);
            const nodeStream = Readable.fromWeb(upstream.body);

            nodeStream.pipe(res);

            nodeStream.on("error", (err) => {
                console.error("Proxy stream error:", err);
                try { res.destroy(err); } catch { }
            });

        } catch { }

    } catch (err) {
        console.error("Proxy error:", err);
        res.status(500).send("Proxy error: " + (err.message || err));
    }
});

// ----------------- /upload : accept file upload, convert if needed, return pdf url -----------------
app.post("/upload", upload.single("file"), async (req, res) => {
    try {
        if (!req.file) return res.status(400).send("No file uploaded");

        const inputPath = req.file.path;
        const originalName = req.file.originalname || "upload";
        const ext = path.extname(originalName).toLowerCase();

        if (ext === ".pdf") {
            // move to package-able workdir
            const id = uuidv4();
            const workdir = path.join(tmpRoot, id);
            await fs.mkdir(workdir, { recursive: true });
            const destPath = path.join(workdir, path.basename(originalName));
            await fs.copyFile(inputPath, destPath);

            app.use(`/files/${id}`, express.static(workdir, { index: false, dotfiles: "deny" }));
            const pdfUrl = `${req.protocol}://${req.get("host")}/files/${id}/${path.basename(destPath)}`;

            setTimeout(() => fs.rm(workdir, { recursive: true, force: true }).catch(() => { }), 1000 * 60 * 30);
            fs.unlink(inputPath).catch(() => { });
            return res.json({ pdf: pdfUrl });
        }

        // other office formats -> convert
        const id = uuidv4();
        const workdir = path.join(tmpRoot, id);
        await fs.mkdir(workdir, { recursive: true });
        const safeName = sanitize(originalName) || `file${ext}`;
        const movedPath = path.join(workdir, safeName);
        await fs.rename(inputPath, movedPath);

        const pdfPath = await convertToPdf(movedPath, workdir);

        app.use(`/files/${id}`, express.static(workdir, { index: false, dotfiles: "deny" }));
        const pdfUrl = `${req.protocol}://${req.get("host")}/files/${id}/${path.basename(pdfPath)}`;

        setTimeout(() => fs.rm(workdir, { recursive: true, force: true }).catch(() => { }), 1000 * 60 * 30);

        res.json({ pdf: pdfUrl });
    } catch (err) {
        console.error("Upload/convert error:", err);
        res.status(500).send("Upload/convert error: " + (err.message || err));
    }
});

// ----------------- /package : build SCORM package (zip) and stream it -----------------
async function copyRecursive(src, dst) {
    const stat = await fs.stat(src);
    if (stat.isDirectory()) {
        await fs.mkdir(dst, { recursive: true });
        const items = await fs.readdir(src);
        for (const it of items) {
            await copyRecursive(path.join(src, it), path.join(dst, it));
        }
    } else {
        await fs.copyFile(src, dst);
    }
}

function generateManifest(pkgId, title, launchFile, resourceFiles) {
    const filesXml = resourceFiles.map(f => `<file href="${f}" />`).join("\n      ");
    return `<?xml version="1.0" encoding="UTF-8"?>
<manifest identifier="${pkgId}" version="1"
  xmlns="http://www.imsproject.org/xsd/imscp_rootv1p1p2"
  xmlns:adlcp="http://www.adlnet.org/xsd/adlcp_rootv1p2"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  xsi:schemaLocation="http://www.imsproject.org/xsd/imscp_rootv1p1p2
  imscp_rootv1p1p2.xsd">
  <metadata>
    <schema>ADL SCORM</schema>
    <schemaversion>1.2</schemaversion>
  </metadata>
  <organizations default="ORG_1">
    <organization identifier="ORG_1">
      <title>${title}</title>
      <item identifier="ITEM_1" identifierref="RES_1">
        <title>${title}</title>
      </item>
    </organization>
  </organizations>
  <resources>
    <resource identifier="RES_1" type="webcontent" adlcp:scormtype="sco" href="${launchFile}">
      ${filesXml}
    </resource>
  </resources>
</manifest>`;
}

function generateConfigJS(cfg, pdfFilename) {
    return `// Config.js
var Config = {
    // Judul dokumen yang tampil di topbar
    title: "${(cfg.title || "").replace(/"/g, '\\"')}",

    // MODE: masukkan link PPTX publik (A).
    // Contoh: "https://example.com/training.pptx"
    // Jika nanti diintegrasikan ke LMS, LMS tinggal mengganti / generate URL ini.
    //pptUrl: "https://netpolitanteam.com/demo/ppt/test.pptx",
    pptUrl: null,

    // (opsional) fallback ke file PDF statis di folder \`data/\`
    filename: "${pdfFilename}",

    // UI config (tidak perlu ubah)
    fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
    fontSize: "14px",
    fontColor: "#222222",
    bodyBgColor: "#ffffff",
    headerBgColor: "#555555",
    headerTextColor: "#ffffff",
    footerBgColor: "#555555",
    footerTextColor: "#ffffff",
    buttonBgColor: "#777777",
    buttonPrimaryBgColor: "#007bff",
    buttonTextColor: "#ffffff",
    progressBarColor: "#00ff00",

    // sidebar default open? (true/false)
    sidebarDefaultOpen: ${Boolean(cfg.sidebarDefaultOpen)},

    // Lock sequence slides? (true = must go sequentially)
    slideSequenceLocked: ${Boolean(cfg.slideSequenceLocked)},

    // nav button position: 'left' | 'center' | 'right'
    navPosition: "right"
};`;
}

app.use(express.json());

app.post("/package", async (req, res) => {
    try {
        const { pdfUrl, config } = req.body;
        if (!pdfUrl) return res.status(400).send("Missing pdfUrl");

        const pkgId = "pkg_" + uuidv4();
        const tmpPkgDir = path.join(tmpRoot, pkgId);
        await fs.mkdir(tmpPkgDir, { recursive: true });

        // 1) copy viewer assets
        const copyTargets = [
            { src: path.join(publicDir, "player.html"), dst: path.join(tmpPkgDir, "player.html") },
            { src: path.join(publicDir, "index_lms.html"), dst: path.join(tmpPkgDir, "index_lms.html") },
            { src: path.join(publicDir, "css"), dst: path.join(tmpPkgDir, "css") },
            { src: path.join(publicDir, "js"), dst: path.join(tmpPkgDir, "js") }
        ];

        for (const t of copyTargets) {
            if (fsSync.existsSync(t.src)) {
                await copyRecursive(t.src, t.dst);
            }
        }

        // 2) data folder + PDF
        const dataDir = path.join(tmpPkgDir, "data");
        await fs.mkdir(dataDir, { recursive: true });

        const pdfFilename = "content.pdf";
        const pdfDestPath = path.join(dataDir, pdfFilename);

        const resp = await fetch(pdfUrl);
        if (!resp.ok) throw new Error("Failed fetching PDF: " + resp.status);
        await pump(resp.body, fsSync.createWriteStream(pdfDestPath));

        // 3) Config.js (🔥 PENTING)
        const configJS = generateConfigJS(config || {}, pdfFilename);
        await fs.writeFile(path.join(tmpPkgDir, "Config.js"), configJS, "utf8");

        // 4) index_lms.html fallback
        const indexLmsPath = path.join(tmpPkgDir, "index_lms.html");
        if (!fsSync.existsSync(indexLmsPath)) {
            await fs.writeFile(
                indexLmsPath,
                `<!doctype html><html><body style="margin:0">
<iframe src="player.html?pdf=data/${pdfFilename}" style="width:100%;height:100vh;border:0;"></iframe>
</body></html>`,
                "utf8"
            );
        }

        // 5) manifest
        const resourceFiles = [
            "player.html",
            "index_lms.html",
            "Config.js",
            "data/" + pdfFilename
        ];

        if (fsSync.existsSync(path.join(tmpPkgDir, "css", "styles.css"))) resourceFiles.push("css/styles.css");
        if (fsSync.existsSync(path.join(tmpPkgDir, "js", "pdf.min.js"))) resourceFiles.push("js/pdf.min.js");
        if (fsSync.existsSync(path.join(tmpPkgDir, "js", "pdf.worker.min.js"))) resourceFiles.push("js/pdf.worker.min.js");
        if (fsSync.existsSync(path.join(tmpPkgDir, "js", "player-viewer.js"))) resourceFiles.push("js/player-viewer.js");

        const manifestXml = generateManifest(
            pkgId,
            config?.title || "SCORM Package",
            "index_lms.html",
            resourceFiles
        );

        await fs.writeFile(path.join(tmpPkgDir, "imsmanifest.xml"), manifestXml, "utf8");

        // 6) zip
        res.setHeader("Content-Type", "application/zip");
        res.setHeader("Content-Disposition", 'attachment; filename="scorm_package.zip"');

        const archive = archiver("zip", { zlib: { level: 9 } });
        archive.pipe(res);
        archive.directory(tmpPkgDir + "/", false);
        await archive.finalize();

        setTimeout(() => fs.rm(tmpPkgDir, { recursive: true, force: true }).catch(() => { }), 1000 * 60 * 5);
    } catch (err) {
        console.error("Package generation error:", err);
        res.status(500).send("Package generation error: " + (err.message || err));
    }
});


// ----------------- simple health check -----------------
app.get("/healthz", (req, res) => res.send("ok"));

// ----------------- start server -----------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server listening on http://localhost:${PORT}`));
