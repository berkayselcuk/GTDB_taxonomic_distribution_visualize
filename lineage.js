/* lineage.optimized.js
 *
 * Implements: parallel JSON fetch, file‑picker TSV load + stream parse,
 * dense Uint8Array presence matrix with fixed ASM_COUNT stride, cached colour scales,
 * dynamic SVG resizing, all original UI: level picker, search, diff-genes, toggle-all.
 *
 * Requires D3 v7. IDs expected in HTML: #lineageChart, #loadTSV, #resetFilter,
 * #mapping-info, #levelSelector, #geneSelector, #toggleSelectAll,
 * #lineageSearch, #lineageOptions, #searchBtn, #diffGene1, #diffGene2, #useCounts, #addDiff
 */
(function(global){
  'use strict';

  // ── CONFIG ───────────────────────────────────────────────────────
  const JSON_URL    = 'GTDB214_lineage_ordered.json';
  const FIXED_WIDTH = 1500;
  const MARGINS     = { top: 32, right: 16, bottom: 32, left: 120 };
  const LEVEL_HEIGHT= 24, INNER_PAD = 1;
  const RUG_HEIGHT  = 12, RUG_PAD = 6;
  const BASE_GAP    = 10;

  // ── STATE ────────────────────────────────────────────────────────
  let originalRaw = [], raw = [], assemblies = [];
  const allLevels = ['phylum','class','order','family','genus'];
  let selectedLevels = ['phylum'];
  let totalInput = 0;
  let geneNames = [];
  let countMap = new Map();
  let matrix = null;
  let ASM_COUNT = 0;
  let asmIndex = new Map(), geneIndex = new Map();
  let xBand = null;
  let activeGenes = [];

  // ── CACHED COLOUR SCALES ─────────────────────────────────────────
  const COLOR_CACHE = {};
  function getColorScale(level, cats) {
    if (!COLOR_CACHE[level]) {
      const phi = 0.618033988749895;
      COLOR_CACHE[level] = d3.scaleOrdinal(cats, cats.map((_,i)=>
        d3.interpolateRainbow((i*phi)%1)
      ));
    }
    return COLOR_CACHE[level];
  }

  // ── SELECTORS ────────────────────────────────────────────────────
  const svg       = d3.select('#lineageChart').attr('width', FIXED_WIDTH);
  const plot      = svg.append('g').attr('transform',
                      `translate(${MARGINS.left},${MARGINS.top})`);
  const rugGrp    = plot.append('g').attr('class','rug-plot');
  const rugLbl    = plot.append('g').attr('class','rug-label');
  const tooltip   = d3.select('body').append('div')
                      .attr('class','tooltip').style('opacity',0);

  const loadBtn   = d3.select('#loadTSV');
  const resetBtn  = d3.select('#resetFilter');
  const levelSel  = d3.select('#levelSelector');
  const geneSel   = d3.select('#geneSelector');
  const toggleBtn = d3.select('#toggleSelectAll');
  const mapInfo   = d3.select('#mapping-info');
  const searchInp = d3.select('#lineageSearch');
  const searchBtn = d3.select('#searchBtn');
  const optList   = d3.select('#lineageOptions');
  const diff1Sel  = d3.select('#diffGene1');
  const diff2Sel  = d3.select('#diffGene2');
  const useCnt    = d3.select('#useCounts');
  const addDiffBtn= d3.select('#addDiff');

  // ── FILE PICKER FOR TSV ───────────────────────────────────────────
  function pickTSV(callback) {
    const input = document.createElement('input');
    input.type = 'file'; input.accept = '.tsv'; input.style.display = 'none';
    input.addEventListener('change', e => {
      const file = e.target.files[0]; if (!file) return;
      const reader = new FileReader();
      reader.onload = ev => callback(ev.target.result);
      reader.readAsText(file);
    });
    document.body.appendChild(input);
    input.click();
    document.body.removeChild(input);
  }

  // ── LOAD HANDLER ──────────────────────────────────────────────────
  loadBtn.on('click', () => {
    pickTSV(tsvText => {
      Promise.resolve()
        .then(() => d3.json(JSON_URL))
        .then(jsonData => {
          // JSON parse
          originalRaw = jsonData;
          raw = originalRaw.slice();
          assemblies = raw.map(d=>d.assembly);
          ASM_COUNT = assemblies.length;
          assemblies.forEach((a,i)=>asmIndex.set(a,i));

          // TSV parse
          const lines = tsvText.trim().split(/\r?\n/);
          const header = lines.shift().split('\t');
          const rows   = lines.filter(l=>l);
          totalInput = rows.length;
          geneNames = header.filter(c=>c.endsWith('_count'));
          geneNames.forEach((g,i)=>geneIndex.set(g,i));

          // init matrix and countMap
          matrix = new Uint8Array(geneNames.length * ASM_COUNT);
          countMap.clear();
          // streaming parse
          d3.tsvParseRows(rows.join('\n'), row => {
            const asm = row[0];
            if (!asmIndex.has(asm)) return;
            const aidx = asmIndex.get(asm);
            const cm = {};
            geneNames.forEach((g,gi)=>{
              const idx = header.indexOf(g);
              const cnt = +row[idx] || 0;
              cm[g] = cnt;
              if (cnt > 0) matrix[gi*ASM_COUNT + aidx] = 1;
            });
            countMap.set(asm, cm);
          });

          // setup
          updateMappingBanner();
          xBand = d3.scaleBand()
                   .domain(assemblies)
                   .range([0, FIXED_WIDTH - MARGINS.left - MARGINS.right])
                   .paddingInner(0);
          buildLevelSelector();
          buildGeneSelector();
          buildSearchDatalist(); bindSearch();
          populateDiffSelectors();
          resetBtn.on('click', ()=>{ resetFilter(); updateMappingBanner(); });
          toggleBtn.on('click', toggleAll);
          addDiffBtn.on('click', addDiffRows);
          drawLineage();
        })
        .catch(e => alert('Load error: ' + e));
    });
  });

  // ── UTILS ─────────────────────────────────────────────────────────
  function setSVGSize() {
    const h = MARGINS.top
            + selectedLevels.length * LEVEL_HEIGHT
            + (activeGenes.length ? BASE_GAP + activeGenes.length * (RUG_HEIGHT + RUG_PAD) : 0)
            + MARGINS.bottom;
    svg.attr('height', h);
  }

  function updateMappingBanner() {
    const matched = countMap.size;
    const pct = ((matched/totalInput)*100).toFixed(1);
    mapInfo.text(`Mapped ${matched} of ${totalInput} input assemblies (${pct}%)`);
  }

  function resetFilter() {
    raw = originalRaw.slice();
    assemblies = raw.map(d=>d.assembly);
    xBand.domain(assemblies);
    drawLineage(); updateRugs();
  }

  function filterAndRedraw(lv,cat) {
    raw = raw.filter(d=>d[lv]===cat);
    assemblies = raw.map(d=>d.assembly);
    xBand.domain(assemblies);
    drawLineage(); updateRugs();
  }

  // ── BUILD UI ─────────────────────────────────────────────────────
  function buildLevelSelector() {
    levelSel.html('');
    levelSel.append('span').text('Lineage levels: ');
    levelSel.selectAll('label').data(allLevels).enter().append('label')
      .text(d=>d)
      .append('input').attr('type','checkbox').attr('value',d=>d)
      .property('checked',d=>selectedLevels.includes(d))
      .on('change', ()=>{
        selectedLevels = levelSel.selectAll('input:checked').nodes().map(n=>n.value);
        if (!selectedLevels.length) {
          selectedLevels=['phylum'];
          levelSel.selectAll('input').property('checked',d=>d==='phylum');
        }
        drawLineage(); activeGenes.forEach((g,i)=>shiftRugRow(g,i));
      });
  }

  function buildGeneSelector() {
    geneSel.html('');
    geneSel.on('change',e=>{ if(e.target.matches("input[type='checkbox']")) onGeneCheckboxChange.call(e.target); });
    geneNames.forEach(g=>{
      geneSel.append('label').text(g.replace(/_count$/,''))
        .append('input').attr('type','checkbox').attr('value',g);
    });
  }

  function toggleAll() {
    const boxes = geneSel.selectAll("input[type='checkbox']");
    if (activeGenes.length) {
      boxes.property('checked',false);
      activeGenes.slice().forEach(removeRugRow);
      activeGenes = [];
    } else {
      boxes.property('checked',true);
      geneNames.forEach(g=>{ activeGenes.push(g); drawRugRow(g,activeGenes.length-1); });
    }
    setSVGSize();
    toggleBtn.text(activeGenes.length?'Deselect All':'Select All');
  }

  function buildSearchDatalist() {
    const cats = new Set();
    originalRaw.forEach(d=> allLevels.forEach(lv=>cats.add(d[lv])));
    optList.html('');
    optList.selectAll('option').data(Array.from(cats).sort()).enter()
      .append('option').attr('value',d=>d);
  }

  function bindSearch() {
    searchBtn.on('click',doSearch);
    searchInp.on('keypress',ev=>{ if(ev.key==='Enter') doSearch(); });
  }

  function doSearch(){
    const v=searchInp.property('value').trim(); if(!v) return;
    const lv=allLevels.find(l=>originalRaw.some(d=>d[l]===v));
    if(!lv) return alert('No lineage: '+v);
    filterAndRedraw(lv,v);
  }

  function populateDiffSelectors() {
    diff1Sel.html(''); diff2Sel.html('');
    geneNames.forEach(g=>{
      const txt=g.replace(/_count$/,'');
      diff1Sel.append('option').attr('value',g).text(txt);
      diff2Sel.append('option').attr('value',g).text(txt);
    });
  }

  function addDiffRows() {
    const g1=diff1Sel.property('value'), g2=diff2Sel.property('value');
    const useC=useCnt.property('checked');
    const n1=g1.replace(/_count$/,''), n2=g2.replace(/_count$/,'');
    const label1= useC?`${n1}>${n2}`:`${n1}-${n2}`;
    const label2= useC?`${n2}>${n1}`:`${n2}-${n1}`;
    const oldCount=geneNames.length;
    geneNames.push(label1,label2);
    geneIndex.set(label1,oldCount);
    geneIndex.set(label2,oldCount+1);
    // expand matrix
    const newM=new Uint8Array(geneNames.length*ASM_COUNT);
    newM.set(matrix);
    assemblies.forEach(a=>{
      const aidx=asmIndex.get(a);
      const cm=countMap.get(a)||{};
      const cnt1=cm[g1]||0, cnt2=cm[g2]||0;
      const p1 = useC? (cnt1>cnt2): (cnt1>0&&cnt2===0);
      const p2 = useC? (cnt2>cnt1): (cnt2>0&&cnt1===0);
      newM[ oldCount*ASM_COUNT + aidx ] = p1?1:0;
      newM[(oldCount+1)*ASM_COUNT + aidx] = p2?1:0;
      cm[label1]=p1; cm[label2]=p2;
      countMap.set(a,cm);
    });
    matrix=newM;
    [label1,label2].forEach(lbl=>{
      geneSel.append('label').text(lbl.replace(/_count$/,''))
        .append('input').attr('type','checkbox').attr('value',lbl).property('checked',true);
      activeGenes.push(lbl);
      drawRugRow(lbl,activeGenes.length-1);
    });
    populateDiffSelectors();
    setSVGSize();
    toggleBtn.text(activeGenes.length?'Deselect All':'Select All');
  }

  // ── DRAW ─────────────────────────────────────────────────────────
  function drawLineage(){
    plot.selectAll('.level').remove();
    const counts={};
    selectedLevels.forEach(lv=>counts[lv]=d3.rollup(raw,v=>v.length,d=>d[lv]));
    selectedLevels.forEach((lv,i)=>{
      const y=i*LEVEL_HEIGHT;
      const g=plot.append('g').attr('class','level')
                   .attr('transform',`translate(0,${y})`);
      const runs=[];
      let start=0, cat=raw[0][lv];
      for(let k=1;k<assemblies.length;k++){
        if(raw[k][lv]!==cat){ runs.push({cat,start,end:k-1}); cat=raw[k][lv]; start=k; }
      }
      runs.push({cat,start,end:assemblies.length-1});
      const scale=getColorScale(lv, Array.from(counts[lv].keys()));
    g.selectAll('rect').data(runs).join('rect')
      .attr('x',      d=> xBand(assemblies[d.start]))
      .attr('y',      0)
      .attr('width',  d=> xBand(assemblies[d.end]) + xBand.bandwidth() - xBand(assemblies[d.start]))
      .attr('height', LEVEL_HEIGHT - INNER_PAD)
      .attr('fill',   d=> scale(d.cat))
      .on('click',    (e,d)=> filterAndRedraw(lv, d.cat))
      .on('mouseover', (e,d) => {
        d3.select(e.currentTarget)
          .attr('stroke','#000').attr('stroke-width',1);
        tooltip.html(
          `<strong>${lv}</strong>: ${d.cat}<br/>Count: ${counts[lv].get(d.cat)}`
        )
        .style('opacity',1)
        .style('left', `${e.clientX+12}px`)
        .style('top',  `${e.clientY+12}px`);
      })
      .on('mousemove', e => {
        tooltip.style('left', `${e.clientX+12}px`)
               .style('top',  `${e.clientY+12}px`);
      })
      .on('mouseout', e => {
        d3.select(e.currentTarget).attr('stroke', null);
        tooltip.style('opacity',0);
      });

    g.append('text')
     .attr('x', -8)
     .attr('y', LEVEL_HEIGHT/2)
     .attr('dy','.35em')
     .attr('text-anchor','end')
     .text(lv);
  });

  setSVGSize();
}

  function updateRugs(){
    rugGrp.selectAll('*').remove(); rugLbl.selectAll('*').remove();
    const baseY = selectedLevels.length*LEVEL_HEIGHT + BASE_GAP;
    activeGenes.forEach((g,i)=>{
      const y = baseY + i*(RUG_HEIGHT+RUG_PAD);
      const gi = geneIndex.get(g);
      assemblies.forEach(a=>{
        const aidx = asmIndex.get(a);
        if(matrix[gi*ASM_COUNT + aidx]){
          rugGrp.append('rect')
            .attr('x',xBand(a)).attr('y',y)
            .attr('width',xBand.bandwidth()).attr('height',RUG_HEIGHT);
        }
      });
      rugLbl.append('text')
        .attr('x', -10).attr('y',y+RUG_HEIGHT/2).attr('dy','.35em')
        .attr('text-anchor','end')
        .text(g.replace(/_count$/,''));
    });
    setSVGSize();
  }

  function onGeneCheckboxChange(){
    const gene = this.value;
    if(this.checked){ activeGenes.push(gene); drawRugRow(gene,activeGenes.length-1); }
    else{ const idx = activeGenes.indexOf(gene); if(idx>-1){ activeGenes.splice(idx,1); removeRugRow(gene); activeGenes.forEach((g2,i)=>shiftRugRow(g2,i)); }}
    setSVGSize();
    toggleBtn.text(activeGenes.length?'Deselect All':'Select All');
  }

  function drawRugRow(gene,rowIndex){
    const y= selectedLevels.length*LEVEL_HEIGHT + BASE_GAP + rowIndex*(RUG_HEIGHT+RUG_PAD);
    const gi=geneIndex.get(gene);
    assemblies.forEach(a=>{
      const aidx=asmIndex.get(a);
      if(matrix[gi*ASM_COUNT + aidx]){
        rugGrp.append('rect')
          .attr('data-gene',gene)
          .attr('x',xBand(a)).attr('y',y)
          .attr('width',xBand.bandwidth()).attr('height',RUG_HEIGHT);
      }
    });
    rugLbl.append('text')
      .attr('data-gene',gene)
      .attr('x',-10).attr('y',y+RUG_HEIGHT/2).attr('dy','.35em')
      .attr('text-anchor','end')
      .text(gene.replace(/_count$/,''));
  }

  function removeRugRow(gene){
    rugGrp.selectAll(`rect[data-gene="${gene}"]`).remove();
    rugLbl.selectAll(`text[data-gene="${gene}"]`).remove();
  }

  function shiftRugRow(gene,newIdx){
    const y= selectedLevels.length*LEVEL_HEIGHT + BASE_GAP + newIdx*(RUG_HEIGHT+RUG_PAD);
    rugGrp.selectAll(`rect[data-gene="${gene}"]`).transition().attr('y',y);
    rugLbl.selectAll(`text[data-gene="${gene}"]`)
      .transition().attr('x',-10).attr('y',y+RUG_HEIGHT/2);
  }

  // ── EXPOSE ────────────────────────────────────────────────────────
  global.LineageVis = { reload: ()=>loadBtn.node().click(), filter: drawLineage };

})(window);
