const fs=require('fs');
const path=require('path');
const p=path.join(process.cwd(),'node_modules','@mastra','core','dist','chunk-UHFTI24X.cjs');
const s=fs.readFileSync(p,'utf8');
let idx=0;
while(true){
  idx=s.indexOf('methodType: "generate"', idx);
  if(idx===-1) break;
  console.log('idx', idx);
  console.log(s.slice(idx-120, idx+200));
  idx += 1;
}
