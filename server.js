import fs from "fs/promises";
import path from "path";
import mammoth from "mammoth";
import cors from "cors";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { GoogleGenerativeAI } from "@google/generative-ai";
import "dotenv/config";
import crypto from "crypto";
import fsExtra from "fs-extra";
import express from "express";
import multer from "multer";


/* ------------------- BASIC SETUP ------------------- */

const app = express();
const upload = multer({ dest: "uploads/" });
app.use(cors());
app.use(express.json({ limit: "5mb" }));

const ROOT = process.cwd();
const FRONTEND_URL = process.env.FRONTEND_URL || "https://ai-folio-frontend.vercel.app";
const PORTFOLIOS_DIR = path.join(ROOT, "portfolios");
/* ------------------- PDF TEXT EXTRACTION ------------------- */

async function extractPDF(filePath) {
  const pdf = await getDocument(filePath).promise;
  let fullText = "";
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    const pageText = content.items.map(item => item.str).join(" ");
    fullText += pageText + "\n";
  }
  return fullText;
}

/* ------------------- FILE TEXT EXTRACTOR ------------------- */

async function extractTextFromFile(filePath, originalName) {
  const ext = path.extname(originalName).toLowerCase();

  if (ext === ".pdf") return await extractPDF(filePath);
  if (ext === ".docx") return (await mammoth.extractRawText({ path: filePath })).value;
  if (ext === ".txt") return await fs.readFile(filePath, "utf8");

  return "";
}

/* ------------------- JSON SAFETY HELPERS ------------------- */

function cleanGeminiOutput(raw) {
  return raw
    .replace(/```json/gi, "")
    .replace(/```/g, "")
    .trim();
}

function extractJSON(raw) {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1) {
    throw new Error("No JSON object found");
  }
  return raw.slice(start, end + 1);
}

/* ------------------- GEMINI CV PARSER ------------------- */
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

async function parseCVWithGemini(cvText) {
  const model = genAI.getGenerativeModel({
    model: "models/gemini-2.5-flash"
  });

  const prompt = `
    You are highly accurate CV parsing assistant.
    You must extract structured data from the CV and respond ONLY in valid JSON.

    Extract PROFESSIONAL SUMMARY, EXPERIENCE, EDUCATION, CONTACT, CERTIFICATIONS, POSITION, NAME, PROJECTS , AWRDS , TOTAL YEARS OF EXPERIENCE, LINKS and return skills in EXACTLY THIS FORMAT:
    
    "skills": {
        "Backend": [],
        "Architecture": [],
        "Databases": [],
        "Cloud / DevOps": [],
        "Frontend": [],
        "AI / Tools": [],
        "Authentication": []
    }

    profile_image: If a profile image URL is provided in the CV, use that.
    If not provided, automatically generate a realistic human-looking avatar (not robotic or emoji style), based on the detected gender from the candidate’s name..

    Rules:
    - use comma-separated values.
    - End each skills line with a full stop.
    - Do not invent skills; only extract from CV.
    - Do Not add new categories.
    - If not found, return empty string.
    - Must return valid json only.

    professional_summary: If professional summary is not  found or more than 3 line then, generate a concise summary based on the CV content.
    experience_years: Calculate total years of professional experience from the experience section.

STRICT RULES:
- Respond with VALID JSON ONLY
- NO markdown, NO explanations, NO extra text
- If a value is missing, return empty string or empty array
- Every array must be syntactically correct
- Output must be directly parsable by JSON.parse()

JSON STRUCTURE:

{
  "name": "",
  "position": "",
  "professional_summary": "",
  "experience_years": "",
  "linkedin": "",
  "github": "",
  "skills": {
    "Backend": [],
    "Architecture": [],
    "Databases": [],
    "Cloud / DevOps": [],
    "Frontend": [],
    "AI / Tools": [],
    "Authentication": [],
    "Testing": [],
    "Version Control": [],
    "Soft Skills": [],
    "Project Management": [],
    "Operating Systems": [],
    "Build Tools": [],
    "Languages": []
  },
  "experience": [],
  "projects": [ 
    {
      "title": "",
      "tech": "",
      "description": []
    }
  ],
  "awards": [],
  "education": [],
  "certifications": [],
  "contact": {
    "email": "",
    "phone": "",
    "location": ""
  },
  "keywords": []
}

CV CONTENT:
${cvText}
`;

  const result = await model.generateContent(prompt);
  const raw = result.response.text();

  try {
    const cleaned = cleanGeminiOutput(raw);
    const jsonText = extractJSON(cleaned);
    const parsed = JSON.parse(jsonText);
    return { success: true, data: parsed };
  } catch (err) {
    return { success: false, error: "Invalid JSON", raw };
  }
}

/* ------------------- API ENDPOINT ------------------- */

app.post("/upload-cv", upload.single("cv"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });

  const filePath = req.file.path;
  const originalName = req.file.originalname;

  try {
    const text = await extractTextFromFile(filePath, originalName);
    await fs.unlink(filePath).catch(() => {});

    if (!text || text.length < 50) {
      return res.status(400).json({ error: "Could not extract text from CV" });
    }

    const parsed = await parseCVWithGemini(text);

    if (!parsed.success) {
      return res.status(500).json(parsed);
    }

    return res.json({
      success: true,
      extracted: parsed.data
    });

  } catch (err) {
    await fs.unlink(filePath).catch(() => {});
    return res.status(500).json({ error: "Server error", details: err.message });
  }
});

/* ------------------- TEST PAGE ------------------- */

app.get("/", (_, res) => {
  res.send(`
    <h2>Gemini CV Parser</h2>
    <form method="POST" enctype="multipart/form-data" action="/upload-cv">
      <input type="file" name="cv" />
      <button type="submit">Upload CV</button>
    </form>
  `);
});

/* ------------------- SERVER ------------------- */

/* -------------------------------------------------
   UTIL: Generate Portfolio HTML
-------------------------------------------------- */
function generatePortfolioHTML(data, theme = "dark") {
  console.log("Generating HTML with theme:", data);
  const skills = Object.values(data.skills || {})
    .flat()
    .map((s) => `<li>${s}</li>`)
    .join("");

  const experience = (data.experience || [])
    .map(
      (job) => `
      <div class="card">
        <h3>${job.role || ""} @ ${job.company || ""}</h3>
        <p>${job.start_date || ""} - ${job.end_date || "Present"}</p>
        <ul>
          ${(job.description || []).map((d) => `<li>${d}</li>`).join("")}
        </ul>
      </div>
    `
    )
    .join("");

  const projects = (data.projects || [])
    .map(
      (p) => `
      <div class="card">
        <h3>${p.title}</h3>
        <p><b>${p.tech || ""}</b></p>
        <p>${p.description || ""}</p>
      </div>
    `
    )
    .join("");

  return `
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${data.name || "Portfolio"}</title>

<style>
body {
  font-family: Arial, sans-serif;
  background: #0f172a;
  color: #e5e7eb;
  padding: 40px;
}
h1 { font-size: 36px; }
h2 { margin-top: 40px; }
.card {
  background: #020617;
  padding: 20px;
  border-radius: 12px;
  margin-bottom: 16px;
}
ul { padding-left: 20px; }
a { color: #38bdf8; }
</style>
</head>

<body>
  <h1>${data.name || ""}</h1>
  <h3>${data.position || ""}</h3>
  <p>${data.professional_summary || ""}</p>

  <h2>Skills</h2>
  <ul>${skills}</ul>

  <h2>Experience</h2>
  ${experience}

  <h2>Projects</h2>
  ${projects}

  <h2>Contact</h2>
  <p>Email: ${data.contact?.email || ""}</p>
  <p>Phone: ${data.contact?.phone || ""}</p>
  <p>Location: ${data.contact?.location || ""}</p>
</body>
</html>
`;
}

/* -------------------------------------------------
   DEPLOY PORTFOLIO API
-------------------------------------------------- */
app.post("/deploy-portfolio", async (req, res) => {
  try {
    const { data, theme } = req.body;

    if (!data?.extracted) {
      return res.status(400).json({ error: "Invalid portfolio data" });
    }

    // 1️⃣ Generate ID
    const id = crypto.randomBytes(6).toString("hex");
    const targetDir = path.join(PORTFOLIOS_DIR, `portfolio_${id}`);

    // 2️⃣ Create portfolio directory
    await fsExtra.ensureDir(targetDir);

    // 3️⃣ Fetch index.html from frontend URL
    const response = await fetch(`${FRONTEND_URL}/index.html`);
    if (!response.ok) {
      throw new Error(`Failed to fetch index.html: ${response.status}`);
    }
    let html = await response.text();

    // 4️⃣ Inject data into index.html
    const injectedScript = `
      <script>
        window.__PORTFOLIO_DATA__ = ${JSON.stringify(data)};
        window.__PORTFOLIO_THEME__ = "${theme}";
      </script>
    `;

    html = html.replace("</head>", `${injectedScript}</head>`);
    await fs.writeFile(path.join(targetDir, "index.html"), html);

    // 5️⃣ Public URL
    const publicUrl = `${req.protocol}://${req.get("host")}/p/${id}`;

    res.json({ success: true, deployUrl: publicUrl });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Deployment failed", details: err.message });
  }
});

/* --------------------------------------------------
   SERVE DEPLOYED PORTFOLIOS
--------------------------------------------------- */
app.use("/p/:id", (req, res, next) => {
  const dir = path.join(PORTFOLIOS_DIR, `portfolio_${req.params.id}`);
  const indexFile = path.join(dir, "index.html");

  // Proxy static assets from frontend URL
  if (req.path.match(/\.(js|css|png|jpg|jpeg|gif|svg|ico|woff|woff2)$/)) {
    const assetUrl = `${FRONTEND_URL}${req.path}`;
    fetch(assetUrl)
      .then(assetRes => {
        if (assetRes.ok) {
          res.set('Content-Type', assetRes.headers.get('content-type'));
          assetRes.body.pipe(res);
        } else {
          res.status(404).send('Asset not found');
        }
      })
      .catch(() => res.status(404).send('Asset not found'));
  } else {
    // Serve index.html for all other routes
    res.sendFile(indexFile, (err) => {
      if (err) res.status(404).send('Portfolio not found');
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Server running on port", PORT);
});
