import { useMemo, useRef, useState } from "react";

/**
 * React/Vite – Simvaliderare + Lagkappväljare för Tempus "Statistikrapport Individuell" (.csv)
 *
 * Steg:
 * 1) Ladda upp & Validera
 * 2) Välj lagkapp, klass och åldersklasser (multi-select)
 * 3) Klicka "Visa alla simmare" → lista med relevanta tider och möjlighet att välja simmare
 */

export default function App() {
  const [rawText, setRawText] = useState("");
  const [rows, setRows] = useState([]);
  const [headers, setHeaders] = useState([]);
  const [errors, setErrors] = useState([]);
  const [warnings, setWarnings] = useState([]);
  const [validated, setValidated] = useState(false);
  const [bestBySwimmer, setBestBySwimmer] = useState({});
  const [summary, setSummary] = useState(null);

  // UI-val
  const [relayType, setRelayType] = useState(""); // 4x50 frisim, 4x100 frisim, 4x200 frisim, 4x50 medley, 4x100 medley
  const [relayClass, setRelayClass] = useState(""); // Herr | Dam | Mix
  const [selectedAges, setSelectedAges] = useState([]); // multi-select ages
  const [showSwimmersBox, setShowSwimmersBox] = useState(false);
  const [selectedSwimmers, setSelectedSwimmers] = useState(new Set());

  const fileRef = useRef(null);

  function handleFile(e) {
    const f = e.target.files?.[0];
    resetState();
    if (!f) return;
    const reader = new FileReader();
    reader.onload = (ev) => setRawText(String(ev.target?.result || ""));
    reader.readAsText(f, "utf-8");
  }

  function resetState() {
    setRows([]); setHeaders([]); setErrors([]); setWarnings([]);
    setValidated(false); setBestBySwimmer({}); setSummary(null);
    setRelayType(""); setRelayClass(""); setSelectedAges([]);
    setShowSwimmersBox(false); setSelectedSwimmers(new Set());
  }

  function detectDelimiter(sample) {
    const sc = (sample.match(/;/g) || []).length;
    const cc = (sample.match(/,/g) || []).length;
    return sc >= cc ? ";" : ",";
  }

  // CSV-split med citatstöd
  function smartSplit(line, delimiter) {
    const cols = []; let cur = ""; let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') { inQuotes = !inQuotes; continue; }
      if (ch === delimiter && !inQuotes) { cols.push(cur.trim()); cur = ""; }
      else { cur += ch; }
    }
    cols.push(cur.trim());
    return cols.map((s) => s.replace(/^"|"$/g, "").trim());
  }

  // Hitta tabellhuvud (hoppa över preamble) och parsa
  function findTableStartAndParse(text) {
    const delimiter = detectDelimiter(text.slice(0, 2000));
    const lines = text.replace(/\r\n?/g, "\n").split("\n");

    let headerIdx = -1;
    for (let i = 0; i < lines.length; i++) {
      const L = lines[i];
      if (/(Simidrottare|Namn)/.test(L) && /Gren/.test(L) && /Tid/.test(L)) { headerIdx = i; break; }
    }
    const allLines = headerIdx >= 0 ? lines.slice(headerIdx) : lines;
    if (!allLines.length) return { headers: [], rows: [] };

    const hdrs = smartSplit(allLines[0], delimiter);
    const headerSet = new Set(hdrs.map((h) => h.trim()));

    const body = allLines.slice(1)
      .map((ln) => smartSplit(ln, delimiter))
      .filter((cols) => cols.some((c) => (c || "").trim().length > 0))
      // Filtrera bort insprängda rubrikrader i body
      .filter((cols) => {
        let headerHits = 0; for (const c of cols) if (headerSet.has((c || "").trim())) headerHits++;
        return headerHits < 3 && (cols[0] || "").trim() !== "Placering";
      });

    const rows = body.map((cols) => {
      const obj = {};
      hdrs.forEach((h, i) => { obj[h.trim()] = (cols[i] ?? "").trim(); });
      return obj;
    });

    return { headers: hdrs, rows };
  }

  function normalizeHeaderName(name) {
    return String(name).toLowerCase().replace(/\s+/g, " ")
      .replaceAll("å","a").replaceAll("ä","a").replaceAll("ö","o");
  }

  function pickColumn(headers, candidates) {
    const normMap = new Map(headers.map((h) => [normalizeHeaderName(h), h]));
    for (const c of candidates) {
      const norm = normalizeHeaderName(c);
      if (normMap.has(norm)) return normMap.get(norm);
      for (const [k, v] of normMap.entries()) if (k.includes(norm)) return v;
    }
    return null;
  }

  // Normalisering av event → nycklar
  function normStr(s) {
    return String(s||"").toLowerCase()
      .replaceAll("å","a").replaceAll("ä","a").replaceAll("ö","o")
      .replace(/\s+/g," ").trim();
  }

  function normalizeEvent(e) {
    const s = normStr(e)
      .replace(/meter|m\.|m /g, "m ")
      .replace(/\s+/g, " ");
    // distans
    const has50 = /(^|\s)50\s*m/.test(s) || /\b50m\b/.test(s);
    const has100 = /(^|\s)100\s*m/.test(s) || /\b100m\b/.test(s);
    const has200 = /(^|\s)200\s*m/.test(s) || /\b200m\b/.test(s);

    // simsätt
    const isFree = /frisim|freestyle/.test(s);
    const isBack = /rygg|ryggsim|backstroke/.test(s);
    const isBreast = /bröst|brost|breast/.test(s);
    const isFly = /fjäril|fjaril|butterfly/.test(s);

    if (has50 && isFree) return "frisim_50";
    if (has100 && isFree) return "frisim_100";
    if (has200 && isFree) return "frisim_200";
    if (has100 && isBack) return "rygg_100";
    if (has100 && isBreast) return "brost_100";
    if (has100 && isFly) return "fjaril_100";
    return null; // annat ignoreras för listkolumnerna
  }

  function parseTimeToSeconds(str) {
    if (!str) return NaN;
    const s = String(str).trim().replace(/,/g, ".");
    const clean = s.replace(/[^0-9:\.]/g, "");
    if (!clean) return NaN;
    const parts = clean.split(":");
    if (parts.length === 1) return parseFloat(parts[0]);
    if (parts.length === 2) return parseInt(parts[0], 10) * 60 + parseFloat(parts[1]);
    const h = parseInt(parts[0],10)||0, m = parseInt(parts[1],10)||0;
    return h*3600 + m*60 + parseFloat(parts.slice(2).join(":"));
  }

  function secondsToTimeStr(sec) {
    if (!isFinite(sec)) return "";
    const m = Math.floor(sec / 60); const s = sec - m * 60;
    return `${m}:${s.toFixed(2).padStart(5, "0")}`;
  }

  function normalizeGender(val) {
    const s = String(val || "").toLowerCase();
    if (!s) return "";
    if (["dam","kvinna","f","female","flicka","flickor"].some(x => s.includes(x))) return "Dam";
    if (["herr","man","m","male","pojke","pojkar"].some(x => s.includes(x))) return "Herr";
    if (s === "k") return "Dam";
    if (s === "h") return "Herr";
    return "";
  }

  function onValidate() {
    setErrors([]); setWarnings([]); setValidated(false);
    setBestBySwimmer({}); setSummary(null);
    setShowSwimmersBox(false); setSelectedSwimmers(new Set());

    if (!rawText) { setErrors(["Ingen fil inläst. Ladda upp en CSV först."]); return; }

    const { headers: hdrs, rows } = findTableStartAndParse(rawText);
    setHeaders(hdrs); setRows(rows);

    if (hdrs.length === 0 || rows.length === 0) { setErrors(["Kunde inte hitta tabell i filen."]); return; }

    // Kolumner
    const nameCol   = pickColumn(hdrs, ["Simidrottare","Namn","Simmare","Namn på simmare","Simmarens namn"]);
    const eventCol  = pickColumn(hdrs, ["Gren","Simgren","Distans"]);
    const timeCol   = pickColumn(hdrs, ["Tid","Resultat","Sluttid"]);
    const genderCol = pickColumn(hdrs, ["Kön","Kon","Gender","K"]);
    const ageCol    = pickColumn(hdrs, ["Ålder vid loppet","Alder vid loppet","Ålder idag","Alder idag","Ålder","Alder"]);
    const bornCol   = pickColumn(hdrs, ["Född","Fodd","Födelseår","Fodelsear"]);
    const dateCol   = pickColumn(hdrs, ["Datum","Tävlingsdatum","Tavlingsdatum"]);

    const missing = [];
    if (!nameCol)  missing.push("Namn/Simidrottare");
    if (!eventCol) missing.push("Gren");
    if (!timeCol)  missing.push("Tid");
    if (missing.length) { setErrors([`Saknar obligatoriska kolumner: ${missing.join(", ")}`]); return; }

    // Bygg bästa tider + lagra kön/ålder och normaliserade nycklar
    const best = {}; // name -> { gender, age, best:{label->{sec,str}}, nbest:{key->{sec,str}} }

    rows.forEach((r) => {
      const name = (r[nameCol]||"").trim();
      const gren = (r[eventCol]||"").trim();
      const tidRaw = (r[timeCol]||"").trim();
      const konRaw = genderCol ? (r[genderCol]||"").trim() : "";

      if (!name && !gren && !tidRaw) return; // tom rad
      const sec = parseTimeToSeconds(tidRaw);
      let alder = ageCol ? Number(String(r[ageCol]).replace(/[^0-9]/g, "")) : NaN;
      if (!isFinite(alder)) {
        const by = bornCol ? Number(String(r[bornCol]).slice(0,4)) : NaN;
        const dy = dateCol ? Number(String(r[dateCol]).slice(0,4)) : NaN;
        if (isFinite(by) && isFinite(dy)) alder = dy - by;
      }

      if (!best[name]) best[name] = { gender: konRaw || "", age: isFinite(alder)?alder:"", best: {}, nbest: {} };

      const nkey = normalizeEvent(gren);
      if (name && gren && isFinite(sec)) {
        if (!best[name].best[gren] || sec < best[name].best[gren].timeSec) {
          best[name].best[gren] = { timeSec: sec, timeStr: secondsToTimeStr(sec) };
        }
        if (nkey) {
          if (!best[name].nbest[nkey] || sec < best[name].nbest[nkey].timeSec) {
            best[name].nbest[nkey] = { timeSec: sec, timeStr: secondsToTimeStr(sec) };
          }
        }
        if (!best[name].gender && konRaw) best[name].gender = konRaw;
        if (!best[name].age && isFinite(alder)) best[name].age = alder;
      }
    });

    const genders = Object.values(best).map((b) => normalizeGender(b.gender));
    const dam = genders.filter((g) => g === "Dam").length;
    const herr = genders.filter((g) => g === "Herr").length;

    setBestBySwimmer(best);
    setValidated(true);
    setSummary({ swimmers: Object.keys(best).length, dam, herr });
  }

  // Ålderslista till multi-select
  const availableAges = useMemo(() => {
    const s = new Set();
    Object.values(bestBySwimmer).forEach((b) => { if (b.age !== "" && Number.isFinite(b.age)) s.add(b.age); });
    return Array.from(s).sort((a,b)=>a-b);
  }, [bestBySwimmer]);

  // Filtrering på klass och ålder
  const filteredSwimmers = useMemo(() => {
    const list = Object.entries(bestBySwimmer).map(([name, data]) => ({ name, ...data }));
    const ages = new Set(selectedAges.map(Number));
    return list.filter(({ gender, age }) => {
      const g = normalizeGender(gender);
      const passClass = !relayClass || relayClass === "Mix" || g === relayClass;
      const passAge = ages.size === 0 || (Number.isFinite(age) && ages.has(age));
      return passClass && passAge;
    }).sort((a,b)=>a.name.localeCompare(b.name, "sv"));
  }, [bestBySwimmer, relayClass, selectedAges]);

  // Vilka tider ska visas beroende på lagkapp
  function requiredEventKeys(rt) {
    const s = normStr(rt);
    if (/4x50\s*frisim/.test(s))  return ["frisim_50"];
    if (/4x100\s*frisim/.test(s)) return ["frisim_100"];
    if (/4x200\s*frisim/.test(s)) return ["frisim_200"];
    if (/4x50\s*medley/.test(s))  return ["rygg_100","brost_100","fjaril_100","frisim_100"]; // visar 100 som referens
    if (/4x100\s*medley/.test(s)) return ["rygg_100","brost_100","fjaril_100","frisim_100"];
    return [];
  }
  const reqKeys = requiredEventKeys(relayType);

  function labelForKey(k) {
    switch (k) {
      case "frisim_50": return "50 frisim";
      case "frisim_100": return "100 frisim";
      case "frisim_200": return "200 frisim";
      case "rygg_100": return "100 rygg";
      case "brost_100": return "100 bröst";
      case "fjaril_100": return "100 fjäril";
      default: return k;
    }
  }

  function toggleSelect(name) {
    setSelectedSwimmers(prev => {
      const n = new Set(prev);
      if (n.has(name)) n.delete(name); else n.add(name);
      return n;
    });
  }

  return (
    <div style={{ maxWidth: 1100, margin: "0 auto", padding: 16 }}>
      <h1 style={{ fontSize: 24, fontWeight: 700, marginBottom: 12 }}>Simvaliderare – Tempus CSV (lagkapp)</h1>
      <p style={{ marginBottom: 12 }}>
        1) Ladda upp och <strong>Validera fil</strong>. 2) Välj lagkapp, klass & ålder. 3) Klicka <em>Visa alla simmare</em>.
      </p>

      <div style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 12 }}>
        <input ref={fileRef} type="file" accept=".csv" onChange={handleFile} />
        <button onClick={onValidate} disabled={!rawText} style={btnStyle}>Validera fil</button>
      </div>

      {validated && (
        <div style={{ marginTop: 8 }}>
          {errors.length === 0 ? (
            <div>
              <h2 style={{ fontSize: 18, fontWeight: 600, marginBottom: 8 }}>OK</h2>
              <ul style={{ marginBottom: 12 }}>
                <li>Simmare: {summary?.swimmers ?? 0}</li>
                <li>Dam: {summary?.dam ?? 0}</li>
                <li>Herr: {summary?.herr ?? 0}</li>
              </ul>

              {/* Val för lagkapp/klass/ålder */}
              <div style={cardBox}>
                <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr 2fr", gap: 12 }}>
                  <div>
                    <label className="block" style={labelStyle}>Lagkapp</label>
                    <select value={relayType} onChange={(e)=>setRelayType(e.target.value)} style={selectStyle}>
                      <option value="">Välj typ…</option>
                      {["4x50 frisim","4x100 frisim","4x200 frisim","4x50 medley","4x100 medley"]
                        .map((t)=> <option key={t} value={t}>{t}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="block" style={labelStyle}>Klass</label>
                    <select value={relayClass} onChange={(e)=>setRelayClass(e.target.value)} style={selectStyle}>
                      <option value="">Välj klass…</option>
                      {["Herr","Dam","Mix"].map((c)=> <option key={c} value={c}>{c}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="block" style={labelStyle}>Åldersklasser (håll Ctrl/Cmd för fler)</label>
                    <select
                      multiple
                      value={selectedAges.map(String)}
                      onChange={(e)=>{
                        const vals = Array.from(e.target.selectedOptions).map(o=>Number(o.value));
                        setSelectedAges(vals);
                      }}
                      style={{...selectStyle, height: 96}}
                    >
                      {availableAges.map((a)=> <option key={a} value={a}>{a} år</option>)}
                    </select>
                  </div>
                </div>

                <div style={{ marginTop: 12, display: 'flex', alignItems: 'center', gap: 12 }}>
                  <button
                    style={btnStyle}
                    onClick={() => setShowSwimmersBox(true)}
                    disabled={!relayType}
                    title={!relayType ? "Välj lagkapp" : "Visa filtrerade simmare"}
                  >
                    Visa alla simmare
                  </button>
                  {reqKeys.length > 0 && (
                    <span style={{ fontSize: 12, opacity: 0.8 }}>
                      Visar kolumner: {reqKeys.map(labelForKey).join(', ')}
                    </span>
                  )}
                </div>
              </div>

              {showSwimmersBox && (
                <div style={{ ...cardBox, marginTop: 12 }}>
                  <h3 style={{ fontSize: 16, fontWeight: 600, marginBottom: 8 }}>Simmare</h3>

                  <div style={{ border: "1px solid #eee", borderRadius: 8, padding: 8, maxHeight: 420, overflow: "auto" }}>
                    <table className="min-w-full border-collapse">
                      <thead>
                        <tr>
                          <th className="border px-2 py-1 text-left">Välj</th>
                          <th className="border px-2 py-1 text-left">Namn</th>
                          <th className="border px-2 py-1 text-left">Kön</th>
                          <th className="border px-2 py-1 text-left">Ålder</th>
                          {reqKeys.map((k)=> (
                            <th key={k} className="border px-2 py-1 text-left">{labelForKey(k)}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {filteredSwimmers.map(({ name, gender, age, nbest }) => {
                          const g = normalizeGender(gender);
                          return (
                            <tr key={name}>
                              <td className="border px-2 py-1">
                                <input type="checkbox" checked={selectedSwimmers.has(name)} onChange={()=>toggleSelect(name)} />
                              </td>
                              <td className="border px-2 py-1 whitespace-nowrap">{name}</td>
                              <td className="border px-2 py-1 whitespace-nowrap">{g || ""}</td>
                              <td className="border px-2 py-1 whitespace-nowrap">{Number.isFinite(age) ? age : ""}</td>
                              {reqKeys.map((k)=> (
                                <td key={k} className="border px-2 py-1 whitespace-nowrap">{nbest?.[k]?.timeStr || ""}</td>
                              ))}
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>

                  <div style={{ marginTop: 8, fontSize: 12, opacity: 0.8 }}>
                    Valda simmare: {selectedSwimmers.size}
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div style={noteBox("#fff1f0", "#a8071a")}>
              ❌ Fel
              <ul>
                {errors.slice(0, 25).map((e, i) => (<li key={i}>{e}</li>))}
                {errors.length > 25 && <li>…och {errors.length - 25} fler fel</li>}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const btnStyle = {
  border: "1px solid #ccc",
  background: "#111",
  color: "#fff",
  padding: "8px 12px",
  borderRadius: 8,
  cursor: "pointer",
};

const selectStyle = { border: "1px solid #ccc", padding: 8, borderRadius: 8, width: "100%" };
const labelStyle = { fontSize: 12, opacity: 0.8, marginBottom: 4 };
const cardBox = { border: "1px solid #eee", borderRadius: 12, padding: 12, background: "#fafafa" };

function noteBox(bg, color) {
  return { background: bg, color, border: `1px solid ${color}33`, padding: 12, borderRadius: 8, marginTop: 8 };
}

