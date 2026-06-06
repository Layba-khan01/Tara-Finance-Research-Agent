const fs=require('fs');
const path=require('path');
const p=path.join(process.cwd(),'node_modules','@mastra','core','dist','chunk-UHFTI24X.cjs');
const s=fs.readFileSync(p,'utf8');
const idx = s.indexOf('methodType: "generate"', 1200000);
console.log(idx);
console.log(s.slice(idx-200, idx+300));
