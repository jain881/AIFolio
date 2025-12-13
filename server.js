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
const BUILD_DIR = path.join(ROOT, "react-build"); // or dist
const PORTFOLIOS_DIR = path.join(ROOT, "portfolios");
const EMAIL_MAPPING_FILE = path.join(ROOT, "email-portfolio-mapping.json");
const VIEW_TRACKING_FILE = path.join(ROOT, "view-tracking.json");

async function getViewTracking() {
  try {
    const data = await fs.readFile(VIEW_TRACKING_FILE, "utf8");
    return JSON.parse(data);
  } catch (err) {
    return {};
  }
}

async function saveViewsTracking(tracking) {
  await fs.writeFile(
    VIEW_TRACKING_FILE,
    JSON.stringify(tracking, null, 2),
    "utf8"
  );
}

async function incrementViewCount(portfolioId, req) {
  const tracking = await getViewTracking();
  if (!tracking[portfolioId]) {
    tracking[portfolioId] = {
      totalViews: 0,
      uniqueViews: 0,
      lastViewed: null,
      ipAddresses: [],
      viewHistory: [],
    };
  }
  // ipAddress = req.ip;
  tracking[portfolioId].totalViews++;
  tracking[portfolioId].uniqueViews++;
  tracking[portfolioId].lastViewed = new Date().toISOString();
  // tracking[portfolioId].ipAddresses.push(ipAddress);
  tracking[portfolioId].viewHistory.push({
    timestamp: new Date().toISOString(),
    ip: req.headers["x-forwarded-for"] || "unknown",
  });
  await saveViewTracking(tracking);
  return tracking[portfolioId];
}
async function saveViewTracking(tracking) {
  await fs.writeFile(
    VIEW_TRACKING_FILE,
    JSON.stringify(tracking, null, 2),
    "utf8"
  );
}
/* ------------------- PDF TEXT EXTRACTION ------------------- */

const getEmailMapping = async () => {
  try {
    const data = await fs.readFile(EMAIL_MAPPING_FILE, "utf8");
    return JSON.parse(data);
  } catch (err) {
    return {};
  }
};

async function saveEmailMapping(mapping) {
  await fs.writeFile(
    EMAIL_MAPPING_FILE,
    JSON.stringify(mapping, null, 2),
    "utf8"
  );
}
async function extractPDF(filePath) {
  const pdf = await getDocument(filePath).promise;
  let fullText = "";
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    const pageText = content.items.map((item) => item.str).join(" ");
    fullText += pageText + "\n";
  }
  return fullText;
}

/* ------------------- FILE TEXT EXTRACTOR ------------------- */

async function extractTextFromFile(filePath, originalName) {
  const ext = path.extname(originalName).toLowerCase();

  if (ext === ".pdf") return await extractPDF(filePath);
  if (ext === ".docx")
    return (await mammoth.extractRawText({ path: filePath })).value;
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
    model: "models/gemini-2.5-flash",
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
      extracted: parsed.data,
    });
  } catch (err) {
    await fs.unlink(filePath).catch(() => {});
    return res
      .status(500)
      .json({ error: "Server error", details: err.message });
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

/* -------------------------------------------------
   DEPLOY PORTFOLIO API
-------------------------------------------------- */
app.post("/deploy-portfolio", async (req, res) => {
  try {
    const { data, theme } = req.body;

    if (!data?.extracted) {
      return res.status(400).json({ error: "Invalid portfolio data" });
    }

    const userEmail = data.extracted.contact.email.toLowerCase().trim();

    if (!userEmail) {
      return res
        .status(400)
        .json({ error: "Email is required to create a portfolio" });
    }

    const emailMapping = await getEmailMapping();

    if (emailMapping[userEmail]) {
      const existingId = emailMapping[userEmail];
      const existingDir = path.join(PORTFOLIOS_DIR, `portfolio_${existingId}`);
      try {
        await fs.access(existingDir);
        const existingUrl = `${req.protocol}://${req.get(
          "host"
        )}/p/${existingId}`;
        return res.json({
          success: true,
          deployUrl: existingUrl,
          message: "Portfolio already exists for this email",
          isExisting: true,
        });
      } catch {
        delete emailMapping[userEmail];
      }
    }
    // 1️⃣ Generate ID
    const id = crypto.randomBytes(6).toString("hex");
    const targetDir = path.join(PORTFOLIOS_DIR, `portfolio_${id}`);

    // 2️⃣ Copy React build
    await fsExtra.copy(BUILD_DIR, targetDir);

    // 3️⃣ Inject data into index.html
    const indexPath = path.join(targetDir, "index.html");
    let html = await fs.readFile(indexPath, "utf8");

    const injectedScript = `
      <script>
        window.__PORTFOLIO_DATA__ = ${JSON.stringify(data)};
        window.__PORTFOLIO_THEME__ = "${theme}";
      </script>
    `;

    html = html.replace("</head>", `${injectedScript}</head>`);
    await fs.writeFile(indexPath, html);

    emailMapping[userEmail] = id;
    await saveEmailMapping(emailMapping);
    // 4️⃣ Public URL
    const publicUrl = `${req.protocol}://${req.get("host")}/p/${id}`;

    res.json({ success: true, deployUrl: publicUrl, isExisting: false });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err });
  }
});

/* --------------------------------------------------
   SERVE DEPLOYED PORTFOLIOS
--------------------------------------------------- */
app.use("/p/:id", async (req, res, next) => {
  const portfolioId = req.params.id;
  const dir = path.join(PORTFOLIOS_DIR, `portfolio_${req.params.id}`);
  const indexFile = path.join(dir, "index.html");

  if (
    req.path === `/p/${portfolioId}` ||
    req.path === `/p/${portfolioId}/` ||
    !req.path.includes(".")
  ) {
    try {
      await incrementViewCount(portfolioId, req);
    } catch (err) {
      console.error(err);
    }
  }

  // Try serving static assets first
  express.static(dir)(req, res, () => {
    // Fallback to index.html (VERY IMPORTANT)
    res.sendFile(indexFile);
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Server running on port", PORT);
});
