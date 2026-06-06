const fs=require('fs');
const path=require('path');
const p=path.join(process.cwd(),'node_modules','@mastra','core','dist','chunk-UHFTI24X.cjs');
const s=fs.readFileSync(p,'utf8');
console.log('path', p);
console.log('exports.Agent', s.indexOf('exports.Agent'));
console.log('Object.defineProperty', s.indexOf('Object.defineProperty(exports, "Agent")'));
console.log('exports.Agent=', s.indexOf('exports.Agent='));
