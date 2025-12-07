import express from 'express';
import multer from 'multer';
import fs from 'fs/promises'
import path from 'path';
import mammoth from 'mammoth';
import 'dotenv/config';
import {OpenRouter} from '@openrouter/sdk';
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import cors from "cors";


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

const openRouter = new OpenRouter({
    apiKey : process.env.OPENROUTER_API_KEY
});


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


async function parseCVTextWithOpenRouter(cvText) {
    const systemPrompt = `You are highly accurate CV parsing assistant.
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

    Rule to generate professional summary:
    - Keep it under 50 words.
    - Focus on key skills, achievements, and career highlights.
    - Avoid generic statements; make it specific to the candidate's background.

    linkedin and github:
    - If LinkedIn or Github URLs are present in the CV, extract and include them in the contact section.
    - If not present, leave the fields empty.

    


    Output JSON Structure:


    {
  "profile_image": "",
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
  "experience": [
    {
      "company": "",
      "role": "",
      "start_date": "",
      "end_date": "",
      "description": ""
    }
  ],
  "projects": [
    {
      "title": "",
      "tech": "",
      "description": ""
    }
  ],
  "awards": [
    {
      "title": "",
      "company": "",
      "date": ""
    }
  ],

  "education": [
    {
      "degree": "",
      "institution": "",
      "start_date": "",
      "end_date": ""
    }
  ],
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

    const resp = await openRouter.chat.send({
        model: "openai/gpt-4.1-mini",
        messages: [
            { role: "system", content: [{ type: "text", text: systemPrompt }] },
            { role: "user", content: [{ type: "text", text: cvText }] }
        ],
        max_tokens: 2048,
        stream: false
    });

    let raw = resp.choices[0].message.content;  // FIXED

    // Extract JSON safely
    const firstBrace = raw.indexOf("{");
    const lastBrace = raw.lastIndexOf("}");

    if (firstBrace === -1 || lastBrace === -1) {
        return { success: false, error: "No JSON found", raw };
    }

    try {
        const jsonText = raw.slice(firstBrace, lastBrace + 1);
        const parsed = JSON.parse(jsonText);
        console.log("text",jsonText,parsed);
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

            const parseResult = await parseCVTextWithOpenRouter(text);

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