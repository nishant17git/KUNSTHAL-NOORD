import React, { useState, useEffect, useRef } from 'react';

// --- CONFIG & CONSTANTS ---
const BATCH_SIZE = 150; 
const MAX_RETRIES = 5;
const NAVARASAS = [
  "Shringara", "Hasya", "Karuna", "Raudra", "Veera", 
  "Bhayanaka", "Bibhatsa", "Adbhuta", "Shanta"
];

const MODEL_PRIORITY = [
  "gemini-3.5-flash",
  "gemini-3-flash",
  "gemini-3.1-flash-lite"
];

const POEM_SCHEMA = {
  type: "ARRAY",
  items: {
    type: "OBJECT",
    properties: {
      source_id: { type: "STRING" },
      id: { type: "STRING" },
      title_en: { type: "STRING" },
      title_transliteration: { type: "STRING" },
      alt_titles: { type: "ARRAY", items: { type: "STRING" } },
      rasa_category: { type: "STRING", enum: NAVARASAS },
      secondary_rasa: { type: "ARRAY", items: { type: "STRING" } },
      tags: { type: "ARRAY", items: { type: "STRING" } },
      themes: { type: "ARRAY", items: { type: "STRING" } },
      stanza_structure: { type: "STRING" },
      meter: { type: "STRING" },
      rhyme_scheme: { type: "STRING" },
      glossary: {
        type: "ARRAY",
        items: {
          type: "OBJECT",
          properties: {
            word: { type: "STRING" },
            meaning: { type: "STRING" }
          },
          required: ["word", "meaning"]
        }
      },
      footnotes: { type: "ARRAY", items: { type: "STRING" } },
      historical_context: { type: "STRING" },
      difficulty: { type: "STRING", enum: ["beginner", "intermediate", "advanced"] },
      content_warnings: { type: "ARRAY", items: { type: "STRING" } }
    },
    required: [
      "source_id", "id", "title_en", "title_transliteration", "alt_titles", 
      "rasa_category", "secondary_rasa", "tags", "themes", "stanza_structure", 
      "meter", "rhyme_scheme", "glossary", "footnotes", "historical_context", 
      "difficulty", "content_warnings"
    ]
  }
};

const MASTER_PROMPT = `
You are a scholar of Hindi and Urdu poetry, working on a curated poetry
database for a public-facing website. You will be given a JSON array of
poems in Devanagari script, each with a source_id, a title, an optional
poet name, and the poem text.

For EACH poem in the input array, produce ONE corresponding object in the
output array (same order, same count — do not skip, merge, or add poems).

For each poem, analyze the text itself (not just the title) and provide:

- id: a URL-safe slug derived from the poet name and title.
- title_en: an accurate, natural English translation of the title.
- title_transliteration: IAST-style Latin transliteration of the title.
- alt_titles: any other titles this poem is commonly known by, if you recognize the poem; otherwise an empty array. Do not guess.
- rasa_category: the single dominant rasa based on the poem's actual content and tone.
- secondary_rasa: any other rasas present, as an array (can be empty).
- tags: 3-8 concrete, specific tags actually present in the poem.
- themes: 2-5 higher-level thematic statements.
- stanza_structure: a short factual description of the stanza pattern actually observed.
- meter: the poetic meter/form if identifiable; null if you cannot determine it with confidence.
- rhyme_scheme: the actual rhyme pattern observed; null if not determinable.
- glossary: 2-6 entries for words a general educated Hindi reader would likely need explained (word + meaning).
- footnotes: any historical/mythological/cultural references in the poem. Empty array if none.
- historical_context: 1-3 sentences of context about when/why this kind of poem was likely composed.
- difficulty: "beginner", "intermediate", or "advanced".
- content_warnings: array of any real content concerns actually present in the poem.

Respond ONLY with a valid JSON array matching the schema. Accuracy matters more than completeness.
`;

// --- HELPER FUNCTIONS ---
const normalizeWhitespace = (str) => (str || "").replace(/\s+/g, " ").trim();
const normalizeTextBody = (str) => {
  if (!str) return "";
  let s = str.normalize("NFC");
  s = s.replace(/\n{3,}/g, "\n\n");
  return s.split("\n").map(line => line.replace(/\s+$/, "")).join("\n").trim();
};

const splitTitlePoet = (rawTitle) => {
  const cleaned = normalizeWhitespace(rawTitle).normalize("NFC");
  if (!cleaned.includes("/")) return [cleaned, null];
  const lastSlash = cleaned.lastIndexOf("/");
  const titlePart = normalizeWhitespace(cleaned.substring(0, lastSlash));
  const poetPart = normalizeWhitespace(cleaned.substring(lastSlash + 1));
  return [titlePart, poetPart || null];
};

const normalizePoetName = (raw) => {
  if (!raw) return "";
  let s = raw.replace(/["'‘’“”]/g, "");
  return normalizeWhitespace(s);
};

const slugifyPoet = (name) => {
  let ascii = name.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase();
  if (ascii) return ascii;
  let code = Array.from(name.replace(/\s+/g, '')).map(c => c.charCodeAt(0).toString(16)).join('');
  return 'poet-' + code.substring(0, 24);
};

const splitPartSuffix = (title) => {
  const match = title.match(/^(.*?)-(\d+)\s*$/);
  if (!match) return [title, null];
  return [match[1].trim(), parseInt(match[2], 10)];
};

const computeReadingTimeSec = (text) => {
  if (!text) return 15;
  const wordCount = text.split(/\s+/).length;
  const seconds = Math.round((wordCount / 100) * 60);
  return Math.max(seconds, 15);
};

// --- MAIN APP COMPONENT ---
export default function App() {
  const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [rawFile, setRawFile] = useState(null);
  
  const [status, setStatus] = useState("idle"); 
  const [logs, setLogs] = useState([]);
  
  const [cleanedData, setCleanedData] = useState([]);
  const [cleaningReport, setCleaningReport] = useState({});
  const [enrichedData, setEnrichedData] = useState([]);
  const [progress, setProgress] = useState({ current: 0, total: 0 });

  const logsEndRef = useRef(null);
  const stopRequested = useRef(false);

  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs]);

  const addLog = (msg, type = "info") => {
    const timestamp = new Date().toLocaleTimeString();
    setLogs(prev => [...prev, { time: timestamp, msg, type }]);
  };

  const handleFileUpload = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    
    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        const json = JSON.parse(event.target.result);
        setRawFile(json);
        addLog(`Loaded ${json.length} rows from ${file.name}`);
      } catch (err) {
        addLog(`Failed to parse JSON: ${err.message}`, "error");
      }
    };
    reader.readAsText(file);
  };

  // --- STAGE 0: CLEANING ---
  const runCleaning = () => {
    if (!rawFile) return;
    setStatus("cleaning");
    addLog("Starting Stage 0: Data Cleaning & Normalization");

    setTimeout(() => {
      let report = {
        total_input_rows: rawFile.length,
        no_poet_separator: 0,
        whitespace_normalized: 0,
        exact_duplicates_removed: 0,
        multi_part_groups_linked: 0,
        distinct_poets: 0
      };

      const seenExact = new Set();
      const poetNamesSeen = new Map();
      const cleaned = [];

      rawFile.forEach((row, i) => {
        const rawTitle = row.Title || "";
        const rawText = row.Text || "";

        const [titleOnly, poetRaw] = splitTitlePoet(rawTitle);
        const text = normalizeTextBody(rawText);

        if (titleOnly !== (rawTitle.split("/")[0] || "").trim() || rawText !== text) {
          report.whitespace_normalized++;
        }

        let poetId = null;
        if (!poetRaw) {
          report.no_poet_separator++;
        } else {
          const poetNorm = normalizePoetName(poetRaw);
          poetId = slugifyPoet(poetNorm);
          poetNamesSeen.set(poetNorm, (poetNamesSeen.get(poetNorm) || 0) + 1);
        }

        const dedupKey = `${titleOnly.toLowerCase()}|||${text}`;
        if (seenExact.has(dedupKey)) {
          report.exact_duplicates_removed++;
          return;
        }
        seenExact.add(dedupKey);

        const sourceId = `src_${String(i + 1).padStart(6, '0')}`;
        cleaned.push({
          source_id: sourceId,
          title_raw: titleOnly,
          title_devanagari: titleOnly,
          poet_name_raw: poetRaw,
          poet_id: poetId,
          text: text,
          related_poem_ids: []
        });
      });

      const groups = {};
      cleaned.forEach(poem => {
        const [base, partNum] = splitPartSuffix(poem.title_devanagari);
        if (partNum !== null) {
          const key = `${poem.poet_id}_${base}`;
          if (!groups[key]) groups[key] = [];
          groups[key].push({ partNum, sourceId: poem.source_id });
        }
      });

      const bySourceId = {};
      cleaned.forEach(p => bySourceId[p.source_id] = p);

      Object.values(groups).forEach(members => {
        if (members.length < 2) return;
        report.multi_part_groups_linked++;
        const ids = members.sort((a, b) => a.partNum - b.partNum).map(m => m.sourceId);
        ids.forEach(sid => {
          bySourceId[sid].related_poem_ids = ids.filter(x => x !== sid);
        });
      });

      report.distinct_poets = poetNamesSeen.size;

      setCleanedData(cleaned);
      setCleaningReport(report);
      addLog(`Cleaning complete. Kept ${cleaned.length} unique poems.`);
      setStatus("idle");
    }, 100); 
  };

  // --- STAGE 1: ENRICHMENT ---
  const delay = (ms) => new Promise(res => setTimeout(res, ms));

  const validatePoem = (poem) => {
    const requiredStrings = ["id", "title_devanagari", "language", "script"];
    for (let field of requiredStrings) {
      if (typeof poem[field] !== 'string' || !poem[field].trim()) throw new Error(`Missing string: ${field}`);
    }
    const rasa = poem.rasa_category;
    if (rasa) {
      const normalizedRasa = rasa.charAt(0).toUpperCase() + rasa.slice(1).toLowerCase();
      if (!NAVARASAS.includes(normalizedRasa)) throw new Error(`Invalid Navarasa: ${rasa}`);
      poem.rasa_category = normalizedRasa;
    }
    return poem;
  };

  const applyLocalDefaults = (modelPoem, sourcePoem) => {
    const stanzas = sourcePoem.text ? [sourcePoem.text] : [];
    const nowIso = new Date().toISOString();

    return {
      id: modelPoem.id,
      schema_version: 1,
      poet_id: sourcePoem.poet_id,
      painting_id: null,
      title_devanagari: sourcePoem.title_devanagari,
      title_en: modelPoem.title_en,
      title_transliteration: modelPoem.title_transliteration,
      alt_titles: modelPoem.alt_titles || [],
      rasa_category: modelPoem.rasa_category,
      secondary_rasa: modelPoem.secondary_rasa || [],
      tags: modelPoem.tags || [],
      themes: modelPoem.themes || [],
      stanzas: stanzas,
      stanza_structure: modelPoem.stanza_structure,
      meter: modelPoem.meter,
      rhyme_scheme: modelPoem.rhyme_scheme,
      language: "hindi",
      script: "devanagari",
      transliteration_iast: null,
      glossary: modelPoem.glossary || [],
      footnotes: modelPoem.footnotes || [],
      historical_context: modelPoem.historical_context,
      reading_time_sec: computeReadingTimeSec(sourcePoem.text),
      difficulty: modelPoem.difficulty,
      content_warnings: modelPoem.content_warnings || [],
      related_poem_ids: sourcePoem.related_poem_ids || [],
      is_published: false,
      is_draft: true,
      source_id: sourcePoem.source_id,
      poet_name_raw: sourcePoem.poet_name_raw,
      stats: { view_count: 0, favourite_count: 0, average_completion: 0 },
      embedding: null,
      embedding_model: null,
      audio: { recitation_url: null, duration_sec: null, narrator: null, license: null },
      video_url: null,
      featured_until: null,
      created_at: nowIso,
      updated_at: nowIso,
      contributors: [{ role: "curator", name: "Infinity Classes" }],
      notes_internal: ""
    };
  };

  const fetchGemini = async (chunk, modelName) => {
    const payload = chunk.map(p => ({
      source_id: p.source_id,
      title_devanagari: p.title_devanagari,
      poet_name: p.poet_name_raw,
      text: p.text
    }));

    const prompt = MASTER_PROMPT + "\n\nHere is the poem dataset:\n\n" + JSON.stringify(payload, null, 2);
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`;
    
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.2,
          responseMimeType: "application/json",
          responseSchema: POEM_SCHEMA
        }
      })
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`API Error ${response.status}: ${err}`);
    }

    const data = await response.json();
    const resultText = data.candidates?.[0]?.content?.parts?.[0]?.text;
    
    if (!resultText) throw new Error("Empty response from API");
    return JSON.parse(resultText);
  };

  const processChunk = async (chunk) => {
    let attempt = 0;
    let backoff = 2000;

    while (attempt < MAX_RETRIES) {
      if (stopRequested.current) return [];
      attempt++;
      
      for (const modelName of MODEL_PRIORITY) {
        if (stopRequested.current) return [];
        try {
          addLog(`Attempting batch via ${modelName}...`, 'info');
          const generated = await fetchGemini(chunk, modelName);
          
          const bySourceId = {};
          chunk.forEach(p => bySourceId[p.source_id] = p);
          
          const validated = [];
          for (let modelPoem of generated) {
            const sourcePoem = bySourceId[modelPoem.source_id];
            if (!sourcePoem) continue;
            const merged = applyLocalDefaults(modelPoem, sourcePoem);
            validated.push(validatePoem(merged));
          }
          return validated; 
        } catch (err) {
          addLog(`${modelName} failed: ${err.message}`, 'warn');
        }
      }

      addLog(`All models failed on Attempt ${attempt}/${MAX_RETRIES}. Backing off...`, 'error');
      if (attempt >= MAX_RETRIES) return []; 
      await delay(backoff);
      backoff *= 2;
    }
    return [];
  };

  const runEnrichment = async () => {
    if (!apiKey) {
      addLog("API Key is required to run enrichment.", "error");
      return;
    }

    setStatus("enriching");
    stopRequested.current = false;
    addLog(`Starting enrichment pipeline. Batch size: ${BATCH_SIZE}`);
    setProgress(prev => ({ ...prev, total: cleanedData.length }));

    const currentResults = [...enrichedData]; 
    
    for (let i = enrichedData.length; i < cleanedData.length; i += BATCH_SIZE) {
      if (stopRequested.current) {
        addLog("Enrichment halted by user.", "warn");
        break;
      }

      const chunk = cleanedData.slice(i, i + BATCH_SIZE);
      addLog(`Processing poems ${i + 1} to ${Math.min(i + BATCH_SIZE, cleanedData.length)}...`);
      
      const validatedBatch = await processChunk(chunk);
      
      if (stopRequested.current) {
        if (validatedBatch.length > 0) {
           currentResults.push(...validatedBatch);
           setEnrichedData([...currentResults]);
        }
        addLog("Enrichment halted by user.", "warn");
        break;
      }

      if (validatedBatch.length > 0) {
        currentResults.push(...validatedBatch);
        setEnrichedData([...currentResults]);
        setProgress({ current: currentResults.length, total: cleanedData.length });
      } else {
        addLog(`Batch failed after retries. Moving to next.`, 'error');
      }
      
      if (i + BATCH_SIZE < cleanedData.length && !stopRequested.current) {
        addLog("Waiting 12 seconds to respect API rate limits (5 RPM)...", "info");
        await delay(12000); 
      }
    }

    if (!stopRequested.current) {
      addLog(`Enrichment complete. Successfully processed ${currentResults.length} poems.`);
    }
    setStatus("stopped");
  };

  const handleStop = () => {
    stopRequested.current = true;
    addLog("Stop signal sent. Halting after current batch finishes...", "warn");
    setStatus("stopped");
  };

  const downloadJson = (data, filename) => {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="min-h-screen bg-[#F0F0F0] text-black font-sans selection:bg-black selection:text-white p-4 md:p-8 flex flex-col">
      
      {/* Main App Container - Modern Grid */}
      <div className="flex-1 w-full max-w-[1600px] mx-auto bg-white border-[6px] border-black shadow-[16px_16px_0px_0px_rgba(0,0,0,1)] grid grid-cols-1 lg:grid-cols-12 flex-col">
        
        {/* Header (Full Width) */}
        <header className="lg:col-span-12 border-b-[6px] border-black p-8 md:p-12 flex flex-col md:flex-row justify-between md:items-end bg-white">
          <div>
            <h1 className="text-5xl md:text-7xl font-black uppercase tracking-tighter leading-none mb-2">
              Pipeline
            </h1>
            <p className="text-xl font-bold uppercase tracking-widest text-neutral-500">
              Kavita.json Processing System
            </p>
          </div>
          <div className="mt-6 md:mt-0 px-6 py-2 bg-black text-white font-black text-2xl uppercase tracking-widest">
            v2.0.4
          </div>
        </header>

        {/* Section 1: Configuration */}
        <section className="lg:col-span-4 border-b-[6px] lg:border-b-0 lg:border-r-[6px] border-black bg-white p-8 md:p-12 flex flex-col">
          <div className="mb-10">
            <span className="bg-black text-white font-black uppercase text-xl px-4 py-2 inline-block mb-6">
              1. Setup
            </span>
          </div>
          
          <div className="space-y-8 flex-1">
            <div>
              <label className="block text-sm font-black uppercase tracking-widest mb-3">Gemini API Key</label>
              <div className="flex border-[4px] border-black">
                <input
                  type={showKey ? "text" : "password"}
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder="AIzaSy..."
                  className="w-full p-4 outline-none font-mono text-lg bg-neutral-100 focus:bg-white transition-colors"
                />
                <button 
                  onClick={() => setShowKey(!showKey)}
                  className="px-6 bg-black text-white hover:bg-neutral-800 font-black uppercase border-l-[4px] border-black transition-colors"
                >
                  {showKey ? "Hide" : "Show"}
                </button>
              </div>
            </div>

            <div>
              <label className="block text-sm font-black uppercase tracking-widest mb-3">Source File</label>
              <input
                type="file"
                accept=".json"
                onChange={handleFileUpload}
                className="w-full font-bold file:mr-6 file:py-4 file:px-8 file:border-[4px] file:border-black file:bg-black file:text-white file:font-black file:uppercase hover:file:bg-neutral-800 file:cursor-pointer file:transition-colors cursor-pointer border-[4px] border-black p-2 bg-neutral-100"
              />
            </div>
          </div>
        </section>

        {/* Section 2: Execution */}
        <section className="lg:col-span-4 border-b-[6px] lg:border-b-0 lg:border-r-[6px] border-black bg-[#0044FF] p-8 md:p-12 flex flex-col text-white">
          <div className="mb-10">
            <span className="bg-white text-[#0044FF] font-black uppercase text-xl px-4 py-2 inline-block mb-6">
              2. Run
            </span>
          </div>
          
          <div className="space-y-6 flex-1">
            <button
              onClick={runCleaning}
              disabled={!rawFile || status === "cleaning" || status === "enriching"}
              className="w-full py-6 px-8 text-left border-[4px] border-black bg-white text-black font-black text-2xl uppercase flex justify-between items-center hover:translate-x-2 transition-transform disabled:opacity-50 disabled:hover:translate-x-0"
            >
              <span>Clean</span>
              <span className="text-4xl leading-none">→</span>
            </button>

            <button
              onClick={runEnrichment}
              disabled={cleanedData.length === 0 || !apiKey || status === "enriching"}
              className="w-full py-6 px-8 text-left border-[4px] border-black bg-[#FFDF00] text-black font-black text-2xl uppercase flex justify-between items-center hover:translate-x-2 transition-transform disabled:opacity-50 disabled:hover:translate-x-0 shadow-[6px_6px_0px_0px_black]"
            >
              <span>Enrich</span>
              <span className="text-4xl leading-none">{status === "enriching" ? "..." : "→"}</span>
            </button>

            {status === "enriching" && (
              <button
                onClick={handleStop}
                className="w-full py-6 px-8 border-[4px] border-black bg-[#FF2A00] text-white font-black text-2xl uppercase hover:bg-black transition-colors shadow-[6px_6px_0px_0px_black]"
              >
                Stop Pipeline
              </button>
            )}
          </div>

          {/* Progress Indicator */}
          {progress.total > 0 && (
            <div className="mt-8 bg-black p-6 border-[4px] border-black">
              <div className="flex justify-between text-sm font-black uppercase tracking-widest mb-3">
                <span>Completed</span>
                <span>{progress.current} / {progress.total}</span>
              </div>
              <div className="w-full h-4 bg-white relative">
                <div 
                  className="absolute top-0 bottom-0 left-0 bg-[#00C455] transition-all duration-300 ease-out"
                  style={{ width: `${(progress.current / progress.total) * 100}%` }}
                ></div>
              </div>
            </div>
          )}
        </section>

        {/* Section 3: Artifacts (Always active if data exists) */}
        <section className="lg:col-span-4 bg-[#FFDF00] p-8 md:p-12 flex flex-col">
          <div className="mb-10">
            <span className="bg-black text-[#FFDF00] font-black uppercase text-xl px-4 py-2 inline-block mb-6">
              3. Output
            </span>
          </div>
          
          <div className="space-y-6 flex-1 flex flex-col justify-end">
            <button
              onClick={() => downloadJson(cleanedData, "clean_poems.json")}
              disabled={cleanedData.length === 0}
              className="w-full py-5 px-6 border-[4px] border-black bg-white text-black font-black text-lg uppercase hover:bg-neutral-100 transition-colors disabled:opacity-40"
            >
              Download Clean JSON
            </button>
            <button
              onClick={() => downloadJson(cleaningReport, "cleaning_report.json")}
              disabled={Object.keys(cleaningReport).length === 0}
              className="w-full py-5 px-6 border-[4px] border-black bg-white text-black font-black text-lg uppercase hover:bg-neutral-100 transition-colors disabled:opacity-40"
            >
              Download Report
            </button>
            <button
              onClick={() => downloadJson(enrichedData, "enriched_poems.json")}
              disabled={enrichedData.length === 0}
              className="w-full py-8 px-6 border-[4px] border-black bg-[#00C455] text-black font-black text-2xl uppercase hover:bg-[#00A045] transition-colors disabled:opacity-40 shadow-[6px_6px_0px_0px_black]"
            >
              Get Final JSON
            </button>
          </div>
        </section>

        {/* Console / Terminal (Full Width Bottom) */}
        <section className="lg:col-span-12 border-t-[6px] border-black bg-black text-white h-[350px] flex flex-col">
          <div className="border-b-[4px] border-neutral-800 px-8 py-4">
            <h3 className="font-black uppercase tracking-widest text-lg text-neutral-400">Terminal Output</h3>
          </div>
          <div className="flex-1 overflow-y-auto p-8 font-mono text-base space-y-3">
            {logs.length === 0 ? (
              <div className="text-neutral-600 font-bold uppercase">System standby...</div>
            ) : (
              logs.map((log, idx) => (
                <div key={idx} className="flex gap-6">
                  <span className="text-neutral-500 shrink-0">[{log.time}]</span>
                  <span className={
                    log.type === 'error' ? 'text-[#FF2A00] font-bold' : 
                    log.type === 'warn' ? 'text-[#FFDF00] font-bold' : 
                    'text-white'
                  }>
                    {log.msg}
                  </span>
                </div>
              ))
            )}
            <div ref={logsEndRef} />
          </div>
        </section>

      </div>
    </div>
  );
}


```
