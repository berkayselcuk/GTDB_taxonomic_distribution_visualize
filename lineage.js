/* lineage.js — v3.0  (normalisation + helper fixes + “Differences” panel)
 * =======================================================================
 * ❶  Width‑normalisation per lineage level or globally (unchanged)
 * ❷  All helper utilities from the original code are kept intact
 * ❸  New “Differences” panel (#diffSelector) shows synthetic rows created
 *     with the “Add Diff” button, while the Select/Deselect‑All button
 *     still controls every check‑box across BOTH panels.
 *
 *  Requires:  D3 v7+  and a small HTML addition:
 *  --------------------------------------------------------
 */

(function (global) {
  'use strict';

  /* ────────────────────────────────────────────────────────
     CONFIG & CONSTANTS
     ------------------------------------------------------- */
  const JSON_URL     = 'GTDB214_lineage_ordered.json';
  const FIXED_WIDTH  = 1500;
  const MARGINS      = { top: 32, right: 16, bottom: 32, left: 120 };
  const LEVEL_HEIGHT = 24, INNER_PAD = 1;
  const RUG_HEIGHT   = 12, RUG_PAD = 6;
  const BASE_GAP     = 10;
  const GOLDEN       = 0.618033988749895;         /* colour spacing */

  /* ────────────────────────────────────────────────────────
     GLOBAL STATE
     ------------------------------------------------------- */
  let originalRaw = [],      // full lineage JSON
      raw = [],              // currently visible subset
      assemblies = [];

  const allLevels      = ['phylum', 'class', 'order', 'family', 'genus'];
  let   selectedLevels = ['phylum'];

  let totalInput   = 0;      // TSV line count
  let geneNames    = [];     // regular + diff rows
  let matrix       = null;   // flattened  (genes × assemblies)
  let ASM_COUNT    = 0;

  const countMap  = new Map();   // assembly  -> { gene:count }
  const asmIndex  = new Map();   // assembly  -> idx
  const geneIndex = new Map();   // geneRow   -> idx

  /* layout map: assembly → {x,w} */
  const coordMap = new Map();
  const widthMap = new Map();

  /* normalisation mode */
  let normalizeLevel = null;     // null | rankName | '__ALL__'
  let xBand = null;              // cached scale when proportional

  /* ────────────────────────────────────────────────────────
     SVG & TOOLTIP
     ------------------------------------------------------- */
  const COLOR_CACHE = {};
  const svg  = d3.select('#lineageChart').attr('width', FIXED_WIDTH);
  const plot = svg.append('g')
                  .attr('transform',
                         `translate(${MARGINS.left},${MARGINS.top})`);
  const rugGrp = plot.append('g').attr('class', 'rug-plot');
  const rugLbl = plot.append('g').attr('class', 'rug-label');
  const tooltip = d3.select('body').append('div')
                    .attr('class', 'tooltip').style('opacity', 0);

  /* ────────────────────────────────────────────────────────
     UI SELECTORS  (regular + new panel)
     ------------------------------------------------------- */
  const loadBtn    = d3.select('#loadTSV');
  const resetBtn   = d3.select('#resetFilter');
  const levelSel   = d3.select('#levelSelector');
  const geneSel    = d3.select('#geneSelector');   // “Genes”
  const diffSelCt  = d3.select('#diffSelector');   // NEW panel
  const toggleBtn  = d3.select('#toggleSelectAll');

  const mapInfo    = d3.select('#mapping-info');
  const searchInp  = d3.select('#lineageSearch');
  const searchBtn  = d3.select('#searchBtn');
  const optList    = d3.select('#lineageOptions');

  const diff1Sel   = d3.select('#diffGene1');
  const diff2Sel   = d3.select('#diffGene2');
  const useCnt     = d3.select('#useCounts');
  const addDiffBtn = d3.select('#addDiff');

  const normSel    = d3.select('#normalizeLevel');
  const normBtn    = d3.select('#applyNormalize');
  const resetWidthBTN = d3.select('#ResetWidth');

  /* ────────────────────────────────────────────────────────
     UTILS
     ------------------------------------------------------- */
  function getColorScale(lv, cats) {
    if (!COLOR_CACHE[lv]) {
      COLOR_CACHE[lv] = d3.scaleOrdinal(
        cats,
        cats.map((_, i) => d3.interpolateRainbow((i * GOLDEN) % 1))
      );
    }
    return COLOR_CACHE[lv];
  }
  const getX = asm => coordMap.get(asm);
  const getW = asm => widthMap.get(asm);

  function pickTSV(cb) {
    const ip = Object.assign(document.createElement('input'), {
      type:'file', accept:'.tsv', style:'display:none'
    });
    ip.addEventListener('change', e => {
      const f = e.target.files[0];
      if (!f) return;
      const r = new FileReader();
      r.onload = ev => cb(ev.target.result);
      r.readAsText(f);
    });
    document.body.appendChild(ip); ip.click(); document.body.removeChild(ip);
  }

  /* ────────────────────────────────────────────────────────
     LAYOUT ENGINE
     ------------------------------------------------------- */
  function buildLayout() {
    coordMap.clear(); widthMap.clear();

    const totalW = FIXED_WIDTH - MARGINS.left - MARGINS.right;

    if (!normalizeLevel) {                           /* proportional */
      xBand = d3.scaleBand().domain(assemblies)
               .range([0, totalW]).paddingInner(0);
      assemblies.forEach(a => {
        coordMap.set(a, xBand(a));
        widthMap.set(a, xBand.bandwidth());
      });
      return;
    }
    if (normalizeLevel === '__ALL__') {              /* equal genome */
      const w = totalW / assemblies.length;
      assemblies.forEach((a,i) => {
        coordMap.set(a, i*w); widthMap.set(a,w);
      });
      return;
    }
    /* equal‑width per category at chosen rank */
    const runs = [], lvl = normalizeLevel;
    let start=0, cat=raw[0][lvl];
    for (let k=1;k<assemblies.length;k++){
      if (raw[k][lvl]!==cat){ runs.push({cat,start,end:k-1});
                              cat=raw[k][lvl]; start=k; }
    }
    runs.push({cat,start,end:assemblies.length-1});
    const segW = totalW / runs.length;
    runs.forEach((run,ri)=>{
      const arr = assemblies.slice(run.start, run.end+1);
      const w = segW / arr.length;
      arr.forEach((a,idx)=>{
        coordMap.set(a, ri*segW + idx*w); widthMap.set(a, w);
      });
    });
  }

  /* ────────────────────────────────────────────────────────
     SVG size helper
     ------------------------------------------------------- */
  function setSVGSize() {
    const h = MARGINS.top
            + selectedLevels.length * LEVEL_HEIGHT
            + (activeGenes.length
                ? BASE_GAP + activeGenes.length*(RUG_HEIGHT+RUG_PAD) : 0)
            + MARGINS.bottom;
    svg.attr('height', h);
  }

  /* ────────────────────────────────────────────────────────
     DATA‑MAPPING banner
     ------------------------------------------------------- */
  function updateMappingBanner() {
    const matched = countMap.size;
    const pct = totalInput? ((matched/totalInput)*100).toFixed(1):'0.0';
    mapInfo.text(`Mapped ${matched} of ${totalInput} input assemblies (${pct}%)`);
  }

  /* ────────────────────────────────────────────────────────
     FILTER & REFLOW
     ------------------------------------------------------- */
  function resetFilter() {
    raw = originalRaw.slice();
    assemblies = raw.map(d=>d.assembly);
    buildLayout(); drawLineage(); updateRugs();
  }
  function filterAndRedraw(lv,cat) {
    raw = raw.filter(d=>d[lv]===cat);
    assemblies = raw.map(d=>d.assembly);
    buildLayout(); drawLineage(); updateRugs();
  }

  /* ────────────────────────────────────────────────────────
     CONTROL BUILDERS
     ------------------------------------------------------- */
  function buildLevelSelector() {
    levelSel.html('');
    levelSel.append('span').text('Lineage levels: ');
    levelSel.selectAll('label')
      .data(allLevels)
      .enter().append('label')
        .text(d=>d)
        .append('input')
          .attr('type','checkbox').attr('value',d=>d)
          .property('checked',d=>selectedLevels.includes(d))
          .on('change',()=>{
            selectedLevels = levelSel.selectAll('input:checked')
                                     .nodes().map(n=>n.value);
            if(!selectedLevels.length){
              selectedLevels=['phylum'];
              levelSel.selectAll('input')
                      .property('checked',d=>d==='phylum');
            }
            drawLineage(); activeGenes.forEach((g,i)=>shiftRugRow(g,i));
          });
  }

  /* hook the same on‑change handler to any container */
  function hookCheckboxContainer(sel){
    sel.on('change',e=>{
      if(e.target.matches("input[type='checkbox']"))
        onGeneCheckboxChange.call(e.target);
    });
  }

  function buildGeneSelector(){
    geneSel.html('');
    geneNames.forEach(g=>{
      geneSel.append('label')
        .text(g.replace(/_count$/,''))
        .append('input').attr('type','checkbox').attr('value',g);
    });
    hookCheckboxContainer(geneSel);
  }
  hookCheckboxContainer(diffSelCt);     // Differences panel

  /* SEARCH helpers */
  function buildSearchDatalist(){
    const cats = new Set();
    originalRaw.forEach(d=>allLevels.forEach(lv=>cats.add(d[lv])));
    optList.html('');
    optList.selectAll('option')
      .data(Array.from(cats).sort())
      .enter().append('option').attr('value',d=>d);
  }
  function doSearch(){
    const v = searchInp.property('value').trim();
    if(!v) return;
    const lv = allLevels.find(l=>originalRaw.some(d=>d[l]===v));
    if(!lv) return alert('No lineage category: '+v);
    filterAndRedraw(lv,v);
  }
  function bindSearch(){
    searchBtn.on('click',doSearch);
    searchInp.on('keypress',e=>{ if(e.key==='Enter')doSearch();});
  }

  /* DIFF‑SELECT helper */
  function populateDiffSelectors(){
    diff1Sel.html(''); diff2Sel.html('');
    geneNames.forEach(g=>{
      const txt=g.replace(/_count$/,'');
      diff1Sel.append('option').attr('value',g).text(txt);
      diff2Sel.append('option').attr('value',g).text(txt);
    });
  }

  /* ────────────────────────────────────────────────────────
     ADD DIFFERENCE ROWS
     ------------------------------------------------------- */
  function addDiffRows(){
    const g1=diff1Sel.property('value'),
          g2=diff2Sel.property('value'),
          useC = useCnt.property('checked');
    if(!g1||!g2||g1===g2) return;

    const oldN = geneNames.length;
    const label = (a,b)=>`${a.replace(/_count$/,'')}${useC?'>':'-'}${b.replace(/_count$/,'')}`;
    const name1=label(g1,g2), name2=label(g2,g1);

    geneNames.push(name1,name2);
    geneIndex.set(name1,oldN); geneIndex.set(name2,oldN+1);

    /* grow matrix */
    const newM = new Uint8Array(geneNames.length*ASM_COUNT);
    newM.set(matrix);

    assemblies.forEach(a=>{
      const ai = asmIndex.get(a);
      const cm = countMap.get(a)||{};
      const c1 = cm[g1]||0, c2 = cm[g2]||0;
      const p1 = useC? (c1>c2):(c1>0&&c2===0);
      const p2 = useC? (c2>c1):(c2>0&&c1===0);
      newM[oldN*ASM_COUNT + ai]       = p1?1:0;
      newM[(oldN+1)*ASM_COUNT + ai]   = p2?1:0;
      cm[name1]=p1; cm[name2]=p2;
      countMap.set(a,cm);
    });
    matrix=newM;

    /* append check‑boxes into Differences panel */
    [name1,name2].forEach(lbl=>{
      diffSelCt.append('label')
        .text(lbl)
        .append('input').attr('type','checkbox')
          .attr('value',lbl).property('checked',true);
      activeGenes.push(lbl);
      drawRugRow(
        lbl,
        activeGenes.length-1,
        selectedLevels.length*LEVEL_HEIGHT+BASE_GAP
      );
    });

    populateDiffSelectors(); setSVGSize();
    toggleBtn.text(activeGenes.length?'Deselect All':'Select All');
  }

  /* ────────────────────────────────────────────────────────
     NORMALISATION CONTROLS
     ------------------------------------------------------- */
  function initNormaliseControls(){
    normSel.html('');
    normSel.append('option').attr('value','').text('— choose level —');
    allLevels.forEach(lv=>normSel.append('option')
                                 .attr('value',lv).text(lv));

    normBtn.on('click',()=>{
      const lv=normSel.property('value');
      normalizeLevel=lv||null;
      buildLayout(); drawLineage(); updateRugs();
    });
    resetWidthBTN.on('click',()=>{
      normalizeLevel=null; normSel.property('value','');
      buildLayout(); drawLineage(); updateRugs();
    });
  }

  /* ────────────────────────────────────────────────────────
     DRAW LINEAGE BLOCKS
     ------------------------------------------------------- */
  function drawLineage(){
    plot.selectAll('.level').remove();
    if(!raw.length) return;

    const counts={};
    selectedLevels.forEach(lv=>{
      counts[lv]=d3.rollup(raw,v=>v.length,d=>d[lv]);
    });

    selectedLevels.forEach((lv,i)=>{
      const y=i*LEVEL_HEIGHT;
      const g=plot.append('g')
                  .attr('class','level')
                  .attr('transform',`translate(0,${y})`);

      const runs=[], lvl=lv;
      let start=0, cat=raw[0][lvl];
      for(let k=1;k<assemblies.length;k++){
        if(raw[k][lvl]!==cat){
          runs.push({cat,start,end:k-1});
          cat=raw[k][lvl]; start=k;
        }
      }
      runs.push({cat,start,end:assemblies.length-1});

      const scale=getColorScale(lv,Array.from(counts[lv].keys()));
      g.selectAll('rect')
       .data(runs)
       .join('rect')
        .attr('x',d=>getX(assemblies[d.start]))
        .attr('y',0)
        .attr('width',d=>getX(assemblies[d.end])+getW(assemblies[d.end])-
                         getX(assemblies[d.start]))
        .attr('height',LEVEL_HEIGHT-INNER_PAD)
        .attr('fill',d=>scale(d.cat))
        .on('click',(_,d)=>filterAndRedraw(lv,d.cat))
        .on('mouseover',(e,d)=>{
          d3.select(e.currentTarget).attr('stroke','#000').attr('stroke-width',1);
          tooltip.html(`<strong>${lv}</strong>: ${d.cat}<br/>Count: ${counts[lv].get(d.cat)}`)
                 .style('opacity',1)
                 .style('left',`${e.clientX+12}px`)
                 .style('top',`${e.clientY+12}px`);
        })
        .on('mousemove',e=>{
          tooltip.style('left',`${e.clientX+12}px`)
                 .style('top',`${e.clientY+12}px`);
        })
        .on('mouseout',e=>{
          d3.select(e.currentTarget).attr('stroke',null);
          tooltip.style('opacity',0);
        });

      g.append('text')
        .attr('x',-8).attr('y',LEVEL_HEIGHT/2)
        .attr('dy','.35em').attr('text-anchor','end').text(lv);
    });
    setSVGSize();
  }

  /* ────────────────────────────────────────────────────────
     RUG PLOTS
     ------------------------------------------------------- */
  const activeGenes = [];

  function drawRugRow(gene,idx,baseY){
    const y=baseY+idx*(RUG_HEIGHT+RUG_PAD);
    const gi=geneIndex.get(gene);
    if(gi===undefined) return;
    assemblies.forEach(a=>{
      const ai=asmIndex.get(a);
      if(matrix[gi*ASM_COUNT+ai]){
        rugGrp.append('rect')
          .attr('data-gene',gene)
          .attr('x',getX(a)).attr('y',y)
          .attr('width',getW(a)).attr('height',RUG_HEIGHT);
      }
    });
    rugLbl.append('text')
      .attr('data-gene',gene)
      .attr('x',-10).attr('y',y+RUG_HEIGHT/2)
      .attr('dy','.35em').attr('text-anchor','end')
      .text(gene.replace(/_count$/,''));
  }
  function updateRugs(){
    rugGrp.selectAll('*').remove(); rugLbl.selectAll('*').remove();
    const baseY=selectedLevels.length*LEVEL_HEIGHT+BASE_GAP;
    activeGenes.forEach((g,i)=>drawRugRow(g,i,baseY));
    setSVGSize();
  }
  function removeRugRow(g){
    rugGrp.selectAll(`rect[data-gene=\"${g}\"]`).remove();
    rugLbl.selectAll(`text[data-gene=\"${g}\"]`).remove();
  }
  function shiftRugRow(g,newIdx){
    const y=selectedLevels.length*LEVEL_HEIGHT+BASE_GAP+
            newIdx*(RUG_HEIGHT+RUG_PAD);
    rugGrp.selectAll(`rect[data-gene=\"${g}\"]`).attr('y',y);
    rugLbl.selectAll(`text[data-gene=\"${g}\"]`).attr('y',y+RUG_HEIGHT/2);
  }

  /* checkbox change */
  function onGeneCheckboxChange(){
    const gene=this.value;
    if(this.checked){
      if(!activeGenes.includes(gene)){
        activeGenes.push(gene);
        drawRugRow(gene,activeGenes.length-1,
                   selectedLevels.length*LEVEL_HEIGHT+BASE_GAP);
      }
    }else{
      const i=activeGenes.indexOf(gene);
      if(i>-1){
        activeGenes.splice(i,1); removeRugRow(gene);
        activeGenes.forEach((g,j)=>shiftRugRow(g,j));
      }
    }
    setSVGSize();
    toggleBtn.text(activeGenes.length?'Deselect All':'Select All');
  }

  /* ────────────────────────────────────────────────────────
     SELECT / DESELECT ALL  — handles both panels
     ------------------------------------------------------- */
  function toggleAll(){
    const boxes=d3.selectAll(
      '#geneSelector input[type=\"checkbox\"], #diffSelector input[type=\"checkbox\"]'
    );
    if(activeGenes.length){                 /* deselect all */
      boxes.property('checked',false);
      activeGenes.slice().forEach(removeRugRow);
      activeGenes.length=0;
    }else{                                  /* select all */
      boxes.property('checked',true);
      boxes.nodes().forEach(n=>{
        const g=n.value;
        if(!activeGenes.includes(g)){
          activeGenes.push(g);
          drawRugRow(
            g, activeGenes.length-1,
            selectedLevels.length*LEVEL_HEIGHT+BASE_GAP
          );
        }
      });
    }
    setSVGSize();
    toggleBtn.text(activeGenes.length?'Deselect All':'Select All');
  }

  /* ────────────────────────────────────────────────────────
     INITIALISATION
     ------------------------------------------------------- */
  loadBtn.on('click',()=>{
    pickTSV(tsvText=>{
      Promise.resolve()
        .then(()=>d3.json(JSON_URL))
        .then(jsonData=>{
          /* lineage json */
          originalRaw=jsonData; raw=originalRaw.slice();
          assemblies=raw.map(d=>d.assembly);
          ASM_COUNT=assemblies.length;
          assemblies.forEach((a,i)=>asmIndex.set(a,i));

          /* TSV */
          const lines=tsvText.trim().split(/\r?\n/);
          const header=lines.shift().split('\t');
          const rows=lines.filter(Boolean);
          totalInput=rows.length;

          geneNames=header.filter(h=>h.endsWith('_count'));
          geneNames.forEach((g,i)=>geneIndex.set(g,i));

          matrix=new Uint8Array(geneNames.length*ASM_COUNT);
          countMap.clear();

          d3.tsvParseRows(rows.join('\n'),row=>{
            const asm=row[0];
            if(!asmIndex.has(asm)) return;
            const ai=asmIndex.get(asm);
            const cm={};
            geneNames.forEach((g,gi)=>{
              const idx=header.indexOf(g); const cnt=+row[idx]||0;
              cm[g]=cnt;
              if(cnt>0) matrix[gi*ASM_COUNT+ai]=1;
            });
            countMap.set(asm,cm);
          });

          /* UI */
          buildLevelSelector();
          buildGeneSelector();
          buildSearchDatalist();
          bindSearch();
          populateDiffSelectors();
          initNormaliseControls();

          resetBtn.on('click',()=>{resetFilter();updateMappingBanner();});
          toggleBtn.on('click',toggleAll);
          addDiffBtn.on('click',addDiffRows);

          updateMappingBanner();
          normalizeLevel=null;
          buildLayout(); drawLineage();
        })
        .catch(e=>alert('Load error: '+e));
    });
  });

  /* ────────────────────────────────────────────────────────
     EXPORT
     ------------------------------------------------------- */
  global.LineageVis={
    reload: ()=>loadBtn.node().click(),
    filter: drawLineage,
    normalise: lvl=>{
      normalizeLevel=lvl||null;
      buildLayout(); drawLineage(); updateRugs();
    }
  };

})(window);
