import fs from 'node:fs';import path from 'node:path';import {fileURLToPath} from 'node:url';import {build} from 'esbuild';import crypto from 'node:crypto';import {loadProject} from './project.mjs';import {packAssets} from '../furniture/pack.mjs';
const root=fileURLToPath(new URL('..',import.meta.url));
const safeJSON=x=>JSON.stringify(x).replace(/</g,'\\u003c');
export async function buildProject(projectFile,options={}){const ctx=loadProject(projectFile,options),{data,report}=ctx;const out=path.resolve(options.out||ctx.output);if(!report.passed)throw new Error('Model validation failed: '+JSON.stringify(report.issues));fs.mkdirSync(out,{recursive:true});
 const viewer=options.viewer||'white-model',furn=viewer==='white-model'?packAssets(data,ctx.catalog):{models:{}};
 const js=await build({entryPoints:[path.join(root,'viewers',viewer,'viewer.js')],bundle:true,minify:true,format:'iife',write:false});
 const template=fs.readFileSync(path.join(root,'viewers',viewer,'template.html'),'utf8');
 const replacements={__FURN__:safeJSON(furn),__DATA__:safeJSON(data),__JS__:js.outputFiles[0].text.replace(/<\/script/gi,'<\\/script')};
 const html=template.replace(/__FURN__|__DATA__|__JS__/g,token=>replacements[token]);
 const file=path.join(out,viewer==='white-model'?'白模.html':'平面核对.html');
 // Preserve previous generated artifact before a rebuild; project overrides are loaded separately.
 if(fs.existsSync(file)&&fs.readFileSync(file,'utf8')!==html){const b=path.join(out,'history',new Date().toISOString().replace(/[:.]/g,'-'));fs.mkdirSync(b,{recursive:true});for(const n of [path.basename(file),'model.json',viewer+'-build-report.json','validation.json','furniture-credits.json'])if(fs.existsSync(path.join(out,n)))fs.copyFileSync(path.join(out,n),path.join(b,n));}
 fs.writeFileSync(file,html);fs.writeFileSync(path.join(out,'model.json'),JSON.stringify(data));fs.writeFileSync(path.join(out,'validation.json'),JSON.stringify(report,null,2));
 const assets=Object.fromEntries(Object.entries(furn.models).map(([id,{b64,...metadata}])=>[id,metadata]));
 if(viewer==='white-model')fs.writeFileSync(path.join(out,'furniture-credits.json'),JSON.stringify(assets,null,2));fs.writeFileSync(path.join(out,viewer+'-build-report.json'),JSON.stringify({toolkitVersion:'0.1.0',projectId:data.projectId,viewer,html:path.basename(file),sourceModel:ctx.project.model,sourceSha256:crypto.createHash('sha256').update(fs.readFileSync(ctx.modelPath)).digest('hex'),floors:data.floors.length,furniture:data.floors.reduce((n,f)=>n+f.furniture.length,0),assets:Object.keys(assets),validation:report},null,2));return {file,out,data};}

export async function buildSourceDrawing(sourceFile,outDir){const input=JSON.parse(fs.readFileSync(sourceFile,'utf8'));if(input.schema!=='cad-source/v1')throw new Error('Expected cad-source/v1');const data={projectId:'source-review',name:input.source.file+' · 原图核对',floors:[{id:'source',name:'原图',trace:input.entities.filter(e=>e.points?.length>1).map(e=>({points:e.points,handle:e.id,source:e})),texts:input.entities.filter(e=>e.text&&e.at)}]};
 const js=await build({entryPoints:[path.join(root,'viewers/drawing/viewer.js')],bundle:true,minify:true,format:'iife',write:false});const template=fs.readFileSync(path.join(root,'viewers/drawing/template.html'),'utf8');const values={__DATA__:safeJSON(data),__JS__:js.outputFiles[0].text.replace(/<\/script/gi,'<\\/script')};fs.mkdirSync(outDir,{recursive:true});const file=path.join(outDir,'原图核对.html');fs.writeFileSync(file,template.replace(/__DATA__|__JS__/g,t=>values[t]));return file;}
