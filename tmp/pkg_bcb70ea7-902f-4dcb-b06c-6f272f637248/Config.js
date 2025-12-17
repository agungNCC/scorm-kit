// Config.js
var Config = {
    // Judul dokumen yang tampil di topbar
    title: "BAWANA SCORM-KIT",

    // MODE: masukkan link PPTX publik (A).
    // Contoh: "https://example.com/training.pptx"
    // Jika nanti diintegrasikan ke LMS, LMS tinggal mengganti / generate URL ini.
    //pptUrl: "https://netpolitanteam.com/demo/ppt/test.pptx",
    pptUrl: null,

    // (opsional) fallback ke file PDF statis di folder `data/`
    filename: "content.pdf",

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
    sidebarDefaultOpen: true,

    // Lock sequence slides? (true = must go sequentially)
    slideSequenceLocked: true,

    // nav button position: 'left' | 'center' | 'right'
    navPosition: "right"
};