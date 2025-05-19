/* lineage.js – fixed-size plot with:
   • contiguous lineage blocks
   • level picker
   • incremental gene-presence rugs (preserves toggle/add order)
   • click-to-filter + reset
   • search / autocomplete
   • diff-of-two genes saved as real genes
   • pre-filter & mapping-rate banner  ← NEW
*/

(() => {
  /* ─── CONFIG ───────────────────────────────────────────────────── */
  const jsonFile   = "GTDB214_lineage_ordered.json";
  const allLevels  = ["phylum","class","order","family","genus"];
  const fixedWidth = 1500;
  const levelH     = 24, innerPad = 1;
  const rugH       = 12, rugPad = 6;
  const leftPad    = 120, baseGap = 10;
  
  /* ─── STATE ─────────────────────────────────────────────────────── */
  let originalRaw, raw, geneData;
  let colorScale, assemblies, xBand;
  let selectedLevels = ["phylum"];
  let presence, geneNames, countMap;
  let activeGenes = []; // keep toggled order

  /* ─── DOM HOOKS ─────────────────────────────────────────────────── */
  const svg       = d3.select("#lineageChart").attr("width", fixedWidth);
  const plot      = svg.append("g").attr("transform",`translate(${leftPad},20)`);
  const rugGrp    = plot.append("g").attr("class","rug-plot");
  const rugLbl    = plot.append("g").attr("class","rug-label");
  const tooltip   = d3.select("body").append("div").attr("class","tooltip");

  const pathInp   = d3.select("#geneTsvPath");
  const loadBtn   = d3.select("#loadGenes");
  const pickBtn   = d3.select("#selectLocalTSV");
  const resetBtn  = d3.select("#resetFilter");
  const levelSel  = d3.select("#levelSelector");
  const geneSel   = d3.select("#geneSelector");
  const searchInp = d3.select("#lineageSearch");
  const searchBtn = d3.select("#searchBtn");
  const diff1Sel   = d3.select("#diffGene1");
  const diff2Sel   = d3.select("#diffGene2");
  const useCnt     = d3.select("#useCounts");
  const addDiffBtn = d3.select("#addDiff");

  /* ─── FILE-PICKER HELPERS ───────────────────────────────────────── */
  function pickTSV(cb){
    const inp = Object.assign(document.createElement("input"),{
      type:"file",accept:".tsv,text/tab-separated-values",style:"display:none"
    });
    inp.onchange = e=>{
      const f=e.target.files[0];
      if(!f) return;
      const r=new FileReader();
      r.onload = ev=>cb(d3.tsvParse(ev.target.result));
      r.readAsText(f);
    };
    document.body.appendChild(inp); inp.click(); inp.remove();
  }

  /* ─── LOAD & INIT ───────────────────────────────────────────────── */
  pickBtn.on("click",()=>
    pickTSV(gd=>
      d3.json(jsonFile).then(j=>{
        originalRaw = raw = j;
        geneData    = gd;
        init();
      })
    )
  );

  loadBtn.on("click",()=>{
    const p = pathInp.property("value").trim();
    if(p){
      Promise.all([d3.json(jsonFile),d3.tsv(p)])
        .then(([j,gd])=>{
          originalRaw = raw = j;
          geneData    = gd;
          init();
        })
        .catch(e=>alert("Load error: "+e));
    } else {
      pickBtn.dispatch("click");
    }
  });

  /* ─── RESET FILTER (keeps mapping filter) ───────────────────────── */
  resetBtn.on("click",()=>{
    raw = originalRaw;

    // recompute matched set & banner
    const totalInput = geneData.length;
    const matchedAssemblies = originalRaw
      .map(d=>d.assembly)
      .filter(a=>presence.has(a));
    const matchedCount = matchedAssemblies.length;
    d3.select("#mapping-info")
      .text(`Mapped ${matchedCount} of ${totalInput} input assemblies (${(matchedCount/totalInput*100).toFixed(1)}%)`);

    raw        = originalRaw.filter(d => presence.has(d.assembly));
    assemblies = matchedAssemblies;
    xBand.domain(assemblies);

    drawLineage();
    updateRugs();
  });

  /* ─── FILTER & REDRAW (lineage click/search) ────────────────────── */
  function filterAndRedraw(lv,cat){
    raw        = raw.filter(r=>r[lv]===cat);
    assemblies = raw.map(r=>r.assembly);
    xBand.domain(assemblies);
    drawLineage();
    updateRugs();
  }

  /* ─── INIT (build scales, UI, first draw) ───────────────────────── */
  function init(){
    /* ── colour scales by level ── */
    colorScale = {};
    const phi = 0.618033988749895;
    allLevels.forEach(lv=>{
      const seen = new Set(), cats = [];
      originalRaw.forEach(d=>{
        if(!seen.has(d[lv])){
          seen.add(d[lv]);
          cats.push(d[lv]);
        }
      });
      colorScale[lv] = d3.scaleOrdinal(cats, cats.map((_,i)=>d3.interpolateRainbow((i*phi)%1)));
    });

    /* ── presence & count maps from TSV ── */
    geneNames = geneData.columns.filter(c=>c.endsWith("_count"));
    presence  = new Map();
    countMap  = new Map();
    geneData.forEach(d=>{
      const p = {}, c = {};
      geneNames.forEach(g=>{
        p[g] = +d[g] > 0;
        c[g] = +d[g];
      });
      presence.set(d.assembly, p);
      countMap.set(d.assembly, c);
    });

    /* ── PRE-FILTER to matched assemblies + banner ── */
    const totalInput        = geneData.length;
    const matchedAssemblies = originalRaw
      .map(d=>d.assembly)
      .filter(a=>presence.has(a));
    const matchedCount = matchedAssemblies.length;
    const pct = (matchedCount/totalInput*100).toFixed(1);
    d3.select("#mapping-info")
      .text(`Mapped ${matchedCount} of ${totalInput} input assemblies (${pct}%)`);

    raw        = originalRaw.filter(d => presence.has(d.assembly));
    assemblies = matchedAssemblies;
    xBand = d3.scaleBand()
              .domain(assemblies)
              .range([0, fixedWidth-leftPad-40])
              .paddingInner(0);

    activeGenes = [];  // fresh start

    /* ── build UIs ── */
    buildLevelSelector();
    buildGeneSelector();
    buildSearchDatalist();
    bindSearch();
    populateDiffSelectors();
    addDiffBtn.on("click",()=>{
      const g1 = diff1Sel.property("value"),
            g2 = diff2Sel.property("value"),
            c  = useCnt.property("checked");
      addDiffRows(g1, g2, c);
    });

    drawLineage();
    // no full rebuild of rugs here; each gene toggle draws its own row
  }

  /* ─── LEVEL CHECKBOX UI ─────────────────────────────────────────── */
  function buildLevelSelector(){
    levelSel.selectAll("*").remove();
    levelSel.append("span").text("Lineage levels:");
    levelSel.selectAll("label")
      .data(allLevels)
      .enter().append("label")
        .text(d=>d)
      .append("input")
        .attr("type","checkbox")
        .attr("value",d=>d)
        .property("checked",d=>selectedLevels.includes(d))
        .on("change",()=>{
          selectedLevels = levelSel.selectAll("input:checked").nodes().map(n=>n.value);
          if(!selectedLevels.length){
            selectedLevels=["phylum"];
            levelSel.selectAll("input").property("checked",d=>d==="phylum");
          }
          drawLineage();
          // shift all existing rug rows to new y-positions
          activeGenes.forEach((g,i)=> shiftRugRow(g,i));
        });
  }

  /* ─── GENE CHECKBOX UI (incremental) ───────────────────────────── */
  function onGeneCheckboxChange(){
    const gene = this.value;
    if(this.checked){
      activeGenes.push(gene);
      drawRugRow(gene, activeGenes.length - 1);
    } else {
      const idx = activeGenes.indexOf(gene);
      if(idx > -1){
        activeGenes.splice(idx, 1);
        removeRugRow(gene);
        activeGenes.forEach((g2,i)=> shiftRugRow(g2, i));
      }
    }
    // update overall SVG height
    svg.attr("height",
      baseGap
      + selectedLevels.length * levelH
      + activeGenes.length * (rugH + rugPad)
      + 20
    );
  }

  function buildGeneSelector(){
    geneSel.selectAll("*").remove();
    geneSel.selectAll("label")
      .data(geneNames)
      .enter().append("label")
        .text(d=>d.replace(/_count$/,""))
      .append("input")
        .attr("type","checkbox")
        .attr("value",d=>d)
        .on("change", onGeneCheckboxChange);
  }

  /* ─── SEARCH BOX (autocomplete) ─────────────────────────────────── */
  function buildSearchDatalist(){
    const allCats = new Set();
    allLevels.forEach(lv=>colorScale[lv].domain().forEach(c=>allCats.add(c)));
    d3.select("#lineageOptions").selectAll("option")
      .data(Array.from(allCats).sort())
      .enter().append("option")
      .attr("value",d=>d);
  }
  function bindSearch(){
    searchBtn.on("click",doSearch);
    searchInp.on("keypress",ev=>{ if(ev.key==="Enter") doSearch(); });
  }
  function doSearch(){
    const v = searchInp.property("value").trim();
    if(!v) return;
    const lv = allLevels.find(l=>colorScale[l].domain().includes(v));
    if(!lv) return alert("No lineage: "+v);
    filterAndRedraw(lv, v);
  }

  /* ─── DRAW LINEAGE BLOCKS ───────────────────────────────────────── */
  function drawLineage(){
    plot.selectAll(".level").remove();
    const counts = {};
    selectedLevels.forEach(lv=>{
      counts[lv] = d3.rollup(raw, v=>v.length, d=>d[lv]);
    });
    selectedLevels.forEach((lv,i)=>{
      const y = i * levelH;
      const g = plot.append("g").attr("class","level").attr("transform",`translate(0,${y})`);
      const runs = [];
      let start = 0, cat = raw[0][lv];
      for(let k = 1; k < assemblies.length; k++){
        if(raw[k][lv] !== cat){
          runs.push({cat, start, end: k - 1});
          cat = raw[k][lv];
          start = k;
        }
      }
      runs.push({cat, start, end: assemblies.length - 1});
      g.selectAll("rect").data(runs).enter().append("rect")
        .attr("x", d=>xBand(assemblies[d.start]))
        .attr("y", 0)
        .attr("width", d=>{
          const first = xBand(assemblies[d.start]),
                last  = xBand(assemblies[d.end]) + xBand.bandwidth();
          return last - first;
        })
        .attr("height", levelH - innerPad)
        .attr("fill", d=>colorScale[lv](d.cat))
        .on("click", (e,d)=>filterAndRedraw(lv, d.cat))
        .on("mouseover", (e,d)=>{
          d3.select(e.currentTarget).attr("stroke","#000").attr("stroke-width",1);
          tooltip.html(`<strong>${lv}</strong>: ${d.cat}<br/>Assemblies: ${counts[lv].get(d.cat)}`)
                 .style("left",  (e.clientX+12)+"px")
                 .style("top",   (e.clientY+12)+"px")
                 .style("opacity",1);
        })
        .on("mousemove", e=>{
          tooltip.style("left",(e.clientX+12)+"px")
                 .style("top",(e.clientY+12)+"px");
        })
        .on("mouseout", e=>{
          d3.select(e.currentTarget).attr("stroke",null);
          tooltip.style("opacity",0);
        });
      g.append("text")
        .attr("x",-8).attr("y",levelH/2).attr("dy",".35em")
        .attr("text-anchor","end")
        .text(lv);
    });
  }

  /* ─── FULL-RUG REBUILD (for filters/resets) ───────────────────────── */
  function updateRugs(){
    rugGrp.selectAll("*").remove();
    rugLbl.selectAll("*").remove();
    const baseY = selectedLevels.length * levelH + baseGap;
    activeGenes.forEach((g,i)=>{
      const y = baseY + i*(rugH + rugPad);
      assemblies.filter(a=>presence.get(a)[g]).forEach(a=>{
        rugGrp.append("rect")
          .attr("x",      xBand(a))
          .attr("y",      y)
          .attr("width",  xBand.bandwidth())
          .attr("height", rugH);
      });
      rugLbl.append("text")
        .attr("x", -50)
        .attr("y", y + rugH/2)
        .attr("dy", ".35em")
        .text(g.replace(/_count$/,""));
    });
    svg.attr("height",
      baseGap
      + selectedLevels.length * levelH
      + activeGenes.length * (rugH + rugPad)
      + 20
    );
  }

  /* ─── INCREMENTAL RUG HELPERS ───────────────────────────────────── */
  function drawRugRow(gene, rowIndex){
    const y = selectedLevels.length * levelH + baseGap + rowIndex*(rugH + rugPad);
    assemblies.filter(a=>presence.get(a)[gene]).forEach(a=>{
      rugGrp.append("rect")
        .attr("data-gene", gene)
        .attr("x",      xBand(a))
        .attr("y",      y)
        .attr("width",  xBand.bandwidth())
        .attr("height", rugH);
    });
    rugLbl.append("text")
      .attr("data-gene", gene)
      .attr("x", -50)
      .attr("y", y + rugH/2)
      .attr("dy", ".35em")
      .text(gene.replace(/_count$/,""));
  }

  function removeRugRow(gene){
    rugGrp.selectAll(`rect[data-gene="${gene}"]`).remove();
    rugLbl.selectAll(`text[data-gene="${gene}"]`).remove();
  }

  function shiftRugRow(gene, newRowIndex){
    const y = selectedLevels.length * levelH + baseGap + newRowIndex*(rugH + rugPad);
    rugGrp.selectAll(`rect[data-gene="${gene}"]`)
      .transition().attr("y", y);
    rugLbl.selectAll(`text[data-gene="${gene}"]`)
      .transition().attr("y", y + rugH/2);
  }

  /* ─── DIFF-GENE SYNTHETICS ──────────────────────────────────────── */
  function addDiffRows(g1,g2,useC){
    const n1 = g1.replace(/_count$/,""), n2 = g2.replace(/_count$/,"");
    const label1 = useC ? `${n1}>${n2}` : `${n1}-${n2}`;
    const label2 = useC ? `${n2}>${n1}` : `${n2}-${n1}`;
    geneNames.push(label1, label2);

    assemblies.forEach(a=>{
      const p  = presence.get(a), cm = countMap.get(a);
      p[label1] = useC ? cm[g1] > cm[g2] : (p[g1] && !p[g2]);
      p[label2] = useC ? cm[g2] > cm[g1] : (p[g2] && !p[g1]);
    });

    [label1,label2].forEach(lbl=>{
      geneSel.append("label")
        .text(lbl.replace(/_count$/,""))
      .append("input")
        .attr("type","checkbox")
        .attr("value",lbl)
        .property("checked", true)
        .on("change", onGeneCheckboxChange);
      activeGenes.push(lbl);
      drawRugRow(lbl, activeGenes.length - 1);
    });

    svg.attr("height",
      baseGap
      + selectedLevels.length * levelH
      + activeGenes.length * (rugH + rugPad)
      + 20
    );
  }

  /* ─── NEW: populateDiffSelectors ───────────────────────────────── */
  function populateDiffSelectors(){
    diff1Sel.selectAll("option").remove();
    diff2Sel.selectAll("option").remove();
    geneNames.forEach(g=>{
      const txt = g.replace(/_count$/,"");
      diff1Sel.append("option").attr("value",g).text(txt);
      diff2Sel.append("option").attr("value",g).text(txt);
    });
  }

})(); // IIFE end
