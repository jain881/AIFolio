import express from 'express';
import multer from 'multer';
import fs from 'fs/promises'
import path from 'path';
import mammoth from 'mammoth';
import 'dotenv/config';
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import cors from "cors";
import { GoogleGenerativeAI } from '@google/generative-ai';


async function extractPDF(filePath)
{
    const pdf = await getDocument(filePath).promise;
    let fullText ='';
    for(let i=1;i<=pdf.numPages;i++)
    {
        const page = await pdf.getPage(i);
        const content = await page.getTextContent();
        const pageText = content.items.map((item) => item.str).join("");
        fullText += pageText + "\n";
    }
    return fullText;
}



const app = express();
const upload =  multer({dest:"uploads/"});
app.use(cors())

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);


async function extractTextFromFile(filePath,originalName) {
    const ext = path.extname(originalName).toLowerCase();
     if (ext === ".pdf") {
       return await extractPDF(filePath);
    }

    if (ext === ".docx") {
        const res = await mammoth.extractRawText({ path: filePath });
        return res.value;
    }

    if (ext === ".txt") {
        return await fs.readFile(filePath, "utf8");
    }
     try{
        return await fs.readFile(filePath,"utf8");
     }
     catch(e){
        return "";
     }

    
}


async function parseCVTextWithGemini(cvText) {
  const model = genAI.getGenerativeModel({
  model: "models/gemini-2.5-flash"
  });

  const prompt = `
You are a highly accurate CV parsing assistant.
You must extract structured data from the CV and respond ONLY in valid JSON.

Extract:
- name
- position
- professional_summary
- experience_years
- linkedin
- github
- skills (grouped exactly as below)
- experience
- projects
- awards
- education
- certifications
- contact
- keywords

Skills format MUST be exactly:

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
}

Rules:
- Do NOT invent data
- If not found, return empty string or empty array
- JSON ONLY, no explanation
- professional_summary max 50 words

CV CONTENT:
${cvText}
`;

  const result = await model.generateContent(prompt);
  const raw = result.response.text();

  const firstBrace = raw.indexOf("{");
  const lastBrace = raw.lastIndexOf("}");

  if (firstBrace === -1 || lastBrace === -1) {
    return { success: false, error: "No JSON found", raw };
  }

  try {
    const jsonText = raw.slice(firstBrace, lastBrace + 1);
    const parsed = JSON.parse(jsonText);
    return { success: true, parsed, raw };
  } catch (err) {
    return { success: false, error: "Invalid JSON", raw };
  }
}


    // ednpoint
    app.post("/upload-cv",upload.single("cv"),async(req,res) => {
        if(!req.file) return res.statue(400).json({
            error:"No File Uploaded"
        });

        const filepath = req.file.path;
        const originalName = req.file.originalname;

        try{
            const text = await extractTextFromFile(filepath,originalName);

            if(!text || text.trim().length < 20){
                await fs.unlink(filepath).catch(() => {});
                return res.status(400).json({ error: "Could not extract text from file or file is empty." });
            }

            const parseResult = await parseCVTextWithGemini(text);

            await fs.unlink(filepath).catch(() => {});
            const cvUploaded = {
                fileName: filepath,
                uploadDate: new Date(),
                originalName  : originalName,
                downloadLink : `/download/${req.file.filename}`

            }

            if(!parseResult.success)
            {
                 return res.status(500).json({ error: parseResult.error, raw: parseResult.raw });

            }
            return res.json({extracted:parseResult.parsed,raw:parseResult.raw,cvUploaded});

        }
        catch (err) {
            await fs.unlink(filepath).catch(() => {});
            console.error(err);
            return res.status(500).json({ error: "Server error", details: String(err) });
        }
});

app.get("/", (req, res) => {
  res.send(`<h2>CV Extractor</h2>
  <form method="POST" enctype="multipart/form-data" action="/upload-cv">
    <input type="file" name="cv" accept=".pdf,.docx,.txt" />
    <button type="submit">Upload CV</button>
  </form>`);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));