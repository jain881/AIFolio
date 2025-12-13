import express from "express";
import multer from "multer";
import fs from "fs/promises";
import path from "path";
import mammoth from "mammoth";
import cors from "cors";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { GoogleGenerativeAI } from "@google/generative-ai";
import "dotenv/config";

/* ------------------- BASIC SETUP ------------------- */

const app = express();
const upload = multer({ dest: "uploads/" });
app.use(cors());
app.use(express.json());

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

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
      "description": ""
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Server running on port", PORT);
});
