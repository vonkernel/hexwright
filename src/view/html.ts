/** The shell only — data comes from /api/graph, logic from /client.js. */
export const shell = (): string => `<!doctype html>
<meta charset="utf-8"><title>hexwright</title>
<style>
 *{box-sizing:border-box} body{margin:0;font:13px -apple-system,Helvetica,sans-serif;
   background:#0e1116;color:#e6edf3;display:flex;height:100vh;overflow:hidden}
 #side{width:340px;flex:none;background:#161b22;border-right:1px solid #30363d;
   padding:16px 18px;overflow-y:auto}
 #cy{flex:1;background:#0e1116}
 h1{font-size:15px;margin:0 0 4px} #ref{color:#6e7681;font-size:10.5px;word-break:break-all}
 .sub{color:#8b949e;font-size:11px;margin-bottom:14px;line-height:1.5}
 .sub .d{padding-left:11px;margin:1px 0 6px;color:#7d8590;line-height:1.55;
   border-left:1px solid #30363d} .sub b{color:#adbac7;font-weight:600}
 h2{font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:#8b949e;
   margin:16px 0 7px;border-top:1px solid #30363d;padding-top:12px}
 label{display:flex;align-items:center;gap:7px;padding:3px 0;cursor:pointer;font-size:12px}
 label:hover{color:#fff} input[type=checkbox]{accent-color:#58a6ff;margin:0}
 label i{display:inline-block;width:14px;border-top:2px solid #8b949e;vertical-align:4px;
   margin:0 3px 0 1px;flex:none} label i.d{border-top-style:dashed}
 .sw{width:11px;height:11px;flex:none} .n{margin-left:auto;color:#6e7681;font-size:10px}
 button{background:#21262d;color:#c9d1d9;border:1px solid #30363d;border-radius:5px;
   padding:5px 9px;font-size:11px;cursor:pointer;margin:2px 3px 2px 0}
 button:hover{background:#30363d} button.on{background:#1f6feb;border-color:#1f6feb;color:#fff}
 #stat{margin:0 0 10px;padding:7px 9px;background:#1c2128;border-radius:5px;
   color:#8b949e;font-size:11px}
 #deltaBox{background:#1c2128;border:1px solid #30363d;border-radius:6px;padding:9px;
   margin:9px 0;font-size:11px;line-height:1.7;display:none}
 .k{display:inline-block;width:9px;height:9px;border:2px solid #f0883e;border-radius:2px;
   vertical-align:-1px;margin-right:4px}
 .k2{display:inline-block;width:11px;border-top:2px dashed #a371f7;vertical-align:4px;
   margin-right:4px}
 .lg{font-size:10.5px;color:#8b949e;line-height:1.9;margin-top:4px}
 #info{position:fixed;right:14px;top:14px;background:#161b22ee;border:1px solid #30363d;
   border-radius:7px;padding:11px 13px;max-width:360px;font-size:12px;display:none;line-height:1.6}
 #info table{border-collapse:collapse;width:100%;margin-top:7px}
 #info td{padding:3px 0;vertical-align:top;font-size:11.5px}
 #info td:first-child{color:#8b949e;width:88px;white-space:nowrap}
 #info .ih{font-size:13px;font-weight:600;color:#58a6ff;border-bottom:1px solid #30363d;
   padding-bottom:6px}
 #info .mut{color:#6e7681;font-size:10.5px}
 #info .x{float:right;cursor:pointer;color:#8b949e;font-size:16px;line-height:1;padding:0 2px}
 #info .x:hover{color:#fff}
 #info .hint{color:#6e7681;font-size:10px;margin-top:8px;border-top:1px solid #30363d;padding-top:6px}
 .dirbar{display:flex;gap:4px;margin:9px 0 6px;border-top:1px solid #30363d;padding-top:9px}
 .dirb{flex:1;margin:0;font-size:10.5px;padding:4px 2px}
 .lks{max-height:250px;overflow-y:auto;margin:0 -3px}
 .lk{display:flex;align-items:center;gap:4px;padding:3px 5px;border-radius:4px;
   cursor:pointer;font-size:11.5px;white-space:nowrap;overflow:hidden}
 .lk:hover{background:#21262d} .lk .ar{color:#58a6ff;flex:none;width:11px}
 .lk .rel{margin-left:auto;color:#6e7681;font-size:9.5px;flex:none;padding-left:6px}
 .lk .sig{white-space:normal;font-family:ui-monospace,Menlo,monospace;font-size:10.5px;
   line-height:1.5;color:#8b949e} .lk .sig b{color:#79c0ff;font-weight:600}
</style>
<div id="side">
 <h1 id="title">…</h1>
 <div id="ref"></div>
 <div class="sub" style="margin-top:6px">Color = domain · Saturation = hexagonal position</div>
 <div id="deltaBox"><div id="delta"></div></div>
 <div id="stat"></div>

 <h2>View</h2>
 <button id="pcore">Core only</button><button id="pall">All</button>
 <label style="margin-top:9px"><input type=checkbox id="deltaOnly">
  <b style="color:#f0883e">Branch delta only</b></label>
 <div class="sub" style="margin:4px 0 0"><div class="d">independent of the component filter —
  combine it with <b>Core only</b></div></div>

 <h2>Layout</h2>
 <button id="bhex">Hexagonal</button><button id="bgrid">Grid</button>
 <div class="sub" style="margin:8px 0 0">
  <b>Hexagonal</b><div class="d">concentric rings per domain —
   Entity → Service → UseCase → Port → DTO·VO</div>
  <b>Grid</b><div class="d">list-like. both are fixed coordinates, so branches stay comparable.</div></div>
 <div style="margin-top:10px;border-top:1px solid #30363d;padding-top:10px">
  <button id="borg" style="width:100%;margin:0">⚡ Organic re-layout</button></div>
 <div class="sub" style="margin:6px 0 0"><div class="d">re-packs on every filter change.
  On <b>Hexagonal</b> it moves the <b>domain boxes</b> — the concentric rings inside each
  domain stay intact. On <b>Grid</b> it is a free-form force layout over the nodes.
  Off = keep the fixed coordinates above.</div></div>

 <h2>Edges</h2>
 <label><input type=checkbox id="showId">Show value-type edges</label>
 <label><input type=checkbox id="crossOnly">Cross-domain edges only</label>
 <div class="sub" style="margin:6px 0 0"><b>Identifier edges</b><div class="d">references like
  FamilyId·UserId — a shared coordinate system, not coupling. Hidden by default.</div></div>

 <h2>Edge types</h2>
 <label><input type=checkbox class=rf value="DEPENDS_ON" checked>
  <i></i>DEPENDS_ON <span class="mut">straight · open V</span><span class="n" id="cDEPENDS_ON"></span></label>
 <label><input type=checkbox class=rf value="REFERENCES" checked>
  <i class="d"></i>REFERENCES <span class="mut">by id · fine dots</span><span class="n" id="cREFERENCES"></span></label>
 <label><input type=checkbox class=rf value="IMPLEMENTS" checked>
  <i class="d"></i>IMPLEMENTS <span class="mut">curved · long dash</span><span class="n" id="cIMPLEMENTS"></span></label>
 <label><input type=checkbox class=rf value="EXTENDS" checked>
  <i class="d"></i>EXTENDS <span class="mut">curved · short dash</span><span class="n" id="cEXTENDS"></span></label>
 <div style="margin-top:10px;border-top:1px solid #30363d;padding-top:10px">
  <button id="bviol" style="width:100%;margin:0">⚠ Violations only</button></div>
 <div class="sub" style="margin:6px 0 0"><div class="d">combines with the filters above —
  keeps only the nodes and edges a violation runs through. Turns on <b>Organic</b>
  while active; switching it off restores exactly what you had.</div></div>
 <div class="lg">
  <b style="color:#f85149">Design violation</b> — thick red<span class="n" id="cviol"></span><br>
  · cross-domain Entity access<br>· Entity leaked into a contract<br>
  · inbound adapter touching an Entity<br>· application → adapter back-reference<br>
  <span style="color:#f0883e">■</span> added &nbsp;<span style="color:#a371f7">■</span> modified
 </div>

 <h2>Components</h2><div id="comps"></div>
 <h2>Domains</h2>
 <button id="allDomOn">All</button><button id="allDomOff">None</button>
 <div id="doms"></div>
</div>
<div id="cy"></div><div id="info"></div>
<script src="/client.js"></script>
`;
