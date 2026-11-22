// Inlines the sources into one page for the Claude artifact.
// Usage: node build.js [out]   (default: dist/index.html)
const fs = require("fs");
const path = require("path");
const src = (f) => fs.readFileSync(path.join(__dirname, "src", f), "utf8");
const out = process.argv[2] || path.join(__dirname, "dist", "index.html");
const html = src("index.html")
  .replace("/*STYLES*/", () => src("styles.css"))
  .replace("/*PLAN*/", () => src("plan.js"))
  .replace("/*LOGIC*/", () => src("logic.js"))
  .replace("/*APP*/", () => src("app.js"));
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, html);
console.log(`Wrote ${out} (${(html.length / 1024).toFixed(1)} KB)`);
