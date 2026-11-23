#!/usr/bin/env node
import fs from 'node:fs';import path from 'node:path';import {fileURLToPath} from 'node:url';import {spawnSync} from 'node:child_process';
import {readProject,loadProject} from './project.mjs';import {buildProject,buildSourceDrawing} from './build.mjs';
const root=fileURLToPath(new URL('..',import.meta.url)),args=process.argv.slice(2),command=args.shift();
function option(k){const i=args.indexOf(k);if(i<0)return;const v=args[i+1];if(!v||v.startsWith('--'))throw new Error('Missing value for '+k);args.splice(i,2);return v;}
const python=process.env.SPACE_PYTHON||([path.join(root,'.venv',process.platform==='win32'?'Scripts/python.exe':'bin/python')].find(p=>fs.existsSync(p)))||'python3';
function run(executable,argv){const r=spawnSync(executable,argv,{stdio:'inherit'});if(r.error)throw r.error;process.exitCode=r.status??1;}
try{
 if(command==='build'){const project=option('--project');if(!project)throw new Error('--project is required');const viewer=option('--viewer')||'white-model',out=option('--out'),model=option('--model');if(viewer==='designer'){const c=readProject(project);if(!c.project.spec)throw new Error('Designer requires project.spec (HouseSpec), no lossy automatic conversion.');const target=path.resolve(out||path.resolve(c.dir,c.project.output||'output'),'设计器.html');run(python,[path.join(root,'legacy/scripts/build.py'),path.resolve(c.dir,c.project.spec),'-o',target,...args]);}else{if(!['drawing','white-model'].includes(viewer))throw new Error('Unknown viewer');console.log((await buildProject(project,{viewer,out,model})).file);}}
 else if(command==='check'){const c=loadProject(option('--project'));console.log(JSON.stringify(c.report,null,2));if(!c.report.passed)process.exitCode=1;}
 else if(command==='sync'){const action=args.shift();if(action!=='check')throw new Error('Use sync check --manifest design-manifest.json');const manifest=option('--manifest');if(!manifest)throw new Error('--manifest is required');run(python,[path.join(root,'checks/design_sync.py'),manifest,...args]);}
 else if(command==='tools'){console.log(fs.readFileSync(path.join(root,'tools.json'),'utf8'));}
 else if(command==='run'){const name=args.shift(),registry=JSON.parse(fs.readFileSync(path.join(root,'tools.json'),'utf8')),tool=registry[name];if(!tool)throw new Error('Unknown tool. Use space.mjs tools');run(tool.runtime==='python'?python:process.execPath,[path.join(root,tool.entry),...args]);}
 else if(command==='cad'){const action=args.shift();if(action==='inspect')run(python,[path.join(root,'cad/read.py'),...args]);else if(action==='view'){const out=option('--out');if(!out)throw new Error('--out required');console.log(await buildSourceDrawing(args[0],out));}else throw new Error('Use cad inspect input.dxf --out folder or cad view source.json --out folder');}
 else if(command==='assets'){run(process.execPath,[path.join(root,'furniture/catalog-cli.mjs'),...args]);}
 else if(command==='serve'){run(process.execPath,[path.join(root,'cli/preview.mjs'),...args]);}
 else if(command==='pack'){const c=readProject(option('--project')),output=path.resolve(c.dir,c.project.output||'output');run(python,[path.join(root,'cli/pack.py'),output,...args]);}
 else {console.log('Space toolkit 0.1.0\n  build --project project.json [--viewer white-model|drawing|designer] [--out dir]\n  check --project project.json\n  sync check --manifest design-manifest.json\n  cad inspect drawing.dxf --out dir [--box x0 y0 x1 y1]\n  cad view source.json --out dir\n  assets search|add|inspect|list ...\n  run <tool-name> ...   /   tools\n  serve file.html [--port 8765]\n  pack --project project.json');if(command&&!['help','--help'].includes(command))process.exitCode=1;}
}catch(e){console.error('Error: '+e.message);process.exitCode=1;}
