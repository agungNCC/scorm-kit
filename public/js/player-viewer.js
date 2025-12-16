// public/js/player-viewer.js
// Minimal player engine for player.html
// Exposes window.startViewerWithPdf(pdfUrl)

// Ensure pdfjsLib exists (loaded from js/pdf.min.js by player.html)
(function () {
    if (!window.pdfjsLib) {
        console.error("pdfjsLib not found. Make sure js/pdf.min.js is loaded before player-viewer.js");
        return;
    }

    // Ensure worker path (player.html should set worker, but be safe)
    try {
        if (!pdfjsLib.GlobalWorkerOptions.workerSrc) {
            pdfjsLib.GlobalWorkerOptions.workerSrc = "js/pdf.worker.min.js";
        }
    } catch (e) { /* ignore */ }

    // STATE
    let pdfDoc = null;
    let currentPage = 1;
    let totalPages = 0;
    let isRendering = false;
    let currPage = -1;
    let visitedPages = [];
    let lastPdfUrl = null;

    // Canvas
    const canvas = document.getElementById("pdfCanvas");
    if (!canvas) {
        console.error("Canvas #pdfCanvas not found in DOM. player-viewer requires a canvas with id 'pdfCanvas'.");
        return;
    }
    const ctx = canvas.getContext("2d");

    // --- Minimal SCORM helpers (safe no-op if not in LMS) ---
    let scormAPI = null;
    let scormVersion = null;

    function findAPI(win) {
        try {
            let attempts = 0;
            const maxAttempts = 500;
            while (!win.API && !win.API_1484_11 && win.parent && win.parent !== win && attempts < maxAttempts) {
                attempts++;
                win = win.parent;
            }
            if (win.API) { scormVersion = "1.2"; return win.API; }
            if (win.API_1484_11) { scormVersion = "2004"; return win.API_1484_11; }
        } catch (e) { /* ignore */ }
        return null;
    }

    function initSCORM() {
        try {
            scormAPI = findAPI(window);
            if (!scormAPI) {
                // running standalone
                return;
            }
            if (scormVersion === "1.2") {
                scormAPI.LMSInitialize && scormAPI.LMSInitialize("");
            } else {
                scormAPI.Initialize && scormAPI.Initialize("");
            }
        } catch (e) { console.warn("SCORM init error", e); }
    }

    function getSCORMValue(a, b) {
        if (!scormAPI) return "";
        try {
            if (scormVersion === "1.2") return scormAPI.LMSGetValue(a) || "";
            return scormAPI.GetValue(b) || "";
        } catch (e) { return ""; }
    }
    function setSCORMValue(a, b, v) {
        if (!scormAPI) return;
        try {
            if (scormVersion === "1.2") scormAPI.LMSSetValue(a, String(v));
            else scormAPI.SetValue(b, String(v));
        } catch (e) { }
    }
    function commitSCORM() {
        if (!scormAPI) return;
        try {
            if (scormVersion === "1.2") scormAPI.LMSCommit && scormAPI.LMSCommit("");
            else scormAPI.Commit && scormAPI.Commit("");
        } catch (e) { }
    }
    function terminateSCORM() {
        if (!scormAPI) return;
        try {
            if (scormVersion === "1.2") scormAPI.LMSFinish && scormAPI.LMSFinish("");
            else scormAPI.Terminate && scormAPI.Terminate("");
        } catch (e) { }
    }
    window.addEventListener("beforeunload", terminateSCORM);

    // --- Helpers ---
    function logStatus(msg) {
        // lightweight status logging (player.html can show on-screen if desired)
        try { console.log("[player] " + msg); } catch (e) { }
    }

    function clearCanvas() {
        try {
            ctx.clearRect(0, 0, canvas.width || 0, canvas.height || 0);
        } catch (e) { }
    }

    // Rendering a page with fit-to-screen logic
    function renderPage(pageNumber) {
        if (!pdfDoc || isRendering) return;
        if (currPage === pageNumber) return;
        currPage = pageNumber;
        isRendering = true;

        pdfDoc.getPage(pageNumber).then((page) => {
            // available viewport are window dims
            const wrapperW = window.innerWidth || document.documentElement.clientWidth;
            const wrapperH = window.innerHeight || document.documentElement.clientHeight;

            const unscaled = page.getViewport({ scale: 1 });
            const pdfW = unscaled.width;
            const pdfH = unscaled.height;

            let scale = Math.min(wrapperW / pdfW, wrapperH / pdfH);
            if (!isFinite(scale) || scale <= 0) scale = 1;

            const viewport = page.getViewport({ scale });

            canvas.width = viewport.width;
            canvas.height = viewport.height;

            const renderContext = {
                canvasContext: ctx,
                viewport: viewport
            };

            // clear before render
            ctx.clearRect(0, 0, canvas.width, canvas.height);

            page.render(renderContext).promise.then(() => {
                isRendering = false;
                // mark visited
                if (!visitedPages[pageNumber - 1]) visitedPages[pageNumber - 1] = true;
                // save simple progress to SCORM
                try {
                    const dataString = visitedPages.map(v => v ? "1" : "0").join("");
                    setSCORMValue("cmi.suspend_data", "cmi.suspend_data", dataString);
                    setSCORMValue("cmi.core.lesson_location", "cmi.location", String(pageNumber));
                    commitSCORM();
                } catch (e) { }
            }).catch((err) => {
                console.error("Render error", err);
                isRendering = false;
            });
        }).catch((err) => {
            console.error("getPage error", err);
            isRendering = false;
        });

        // no UI buttons here; exposing currentPage for external nav if needed
    }

    // Validate PDF url (simple)
    function normalizePdfUrl(url) {
        if (!url) return null;
        // if url is relative and starts with data/ keep as-is
        return url;
    }

    // Destroy previous pdfDoc safely
    function destroyPdfDoc() {
        try {
            if (pdfDoc && typeof pdfDoc.destroy === "function") {
                pdfDoc.destroy();
            }
        } catch (e) { /* ignore */ }
        pdfDoc = null;
    }

    // MAIN: start viewer with pdfUrl (exposed)
    async function startViewerWithPdf(pdfUrl) {
        try {
            logStatus("Preparing to load PDF...");
            const url = normalizePdfUrl(pdfUrl);
            if (!url) {
                logStatus("No valid PDF URL supplied");
                throw new Error("No PDF URL");
            }

            // cleanup previous
            destroyPdfDoc();
            clearCanvas();
            currPage = -1;
            isRendering = false;
            currentPage = 1;
            totalPages = 0;
            visitedPages = [];

            // remember last url
            lastPdfUrl = url;
            window.lastLoadedPdfUrl = url;

            // init scorm API (may be no-op if standalone)
            initSCORM();

            logStatus("Loading PDF: " + url);
            const loadingTask = pdfjsLib.getDocument(url);
            const pdf = await loadingTask.promise;

            pdfDoc = pdf;
            totalPages = pdf.numPages;
            // default visitedPages array
            visitedPages = Array(totalPages).fill(false);

            // try to read suspend_data and last location from SCORM
            try {
                const suspend = getSCORMValue("cmi.suspend_data", "cmi.suspend_data");
                if (suspend && suspend.length === totalPages) {
                    visitedPages = suspend.split("").map(c => c === "1");
                }
                const lastLoc = parseInt(getSCORMValue("cmi.core.lesson_location", "cmi.location"), 10);
                if (!isNaN(lastLoc) && lastLoc >= 1 && lastLoc <= totalPages) {
                    currentPage = lastLoc;
                } else {
                    currentPage = 1;
                }
            } catch (e) { /* ignore */ }

            // render first page (or last saved)
            renderPage(currentPage);
            logStatus("PDF loaded. pages=" + totalPages);
        } catch (err) {
            console.error("startViewerWithPdf error:", err);
            // show on-canvas message if desired
            clearCanvas();
            const ctxMsg = ctx;
            try {
                ctxMsg.font = "14px sans-serif";
                ctxMsg.fillStyle = "#333";
                ctxMsg.fillText("Failed to load PDF.", 10, 30);
            } catch (e) { }
            throw err;
        }
    }

    // expose nav helpers (optional)
    window.playerViewer = window.playerViewer || {};
    window.playerViewer.getState = function () {
        return { pdfLoaded: !!pdfDoc, lastPdfUrl: lastPdfUrl, totalPages, currentPage };
    };
    window.playerViewer.next = function () {
        if (!pdfDoc) return;
        if (currentPage < totalPages) { currentPage++; renderPage(currentPage); }
    };
    window.playerViewer.prev = function () {
        if (!pdfDoc) return;
        if (currentPage > 1) { currentPage--; renderPage(currentPage); }
    };

    // expose function to global
    window.startViewerWithPdf = startViewerWithPdf;

    // also expose a destroy util
    window.playerViewer.destroy = function () {
        destroyPdfDoc();
        clearCanvas();
    };

    // Resize handling: re-render current page on resize (basic)
    window.addEventListener("resize", function () {
        if (pdfDoc && currentPage) {
            // force re-render
            currPage = -1;
            renderPage(currentPage);
        }
    }, { passive: true });

})();
