import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
export function packAssets(data,catalogPath){const ids=[...new Set(data.floors.flatMap(f=>f.furniture.map(i=>i.assetId).filter(Boolean)))];if(!ids.length)return {models:{}};if(!catalogPath)throw new Error('Furniture bindings require an asset catalog');const cat=JSON.parse(fs.readFileSync(catalogPath,'utf8')),models={};
 for(const id of ids){const m=cat.models[id];if(!m)throw new Error('Unknown asset: '+id);const file=path.resolve(path.dirname(catalogPath),m.file),buf=fs.readFileSync(file);models[id]={size:m.size,license:m.license,source:m.source,credit:m.credit,sha256:crypto.createHash('sha256').update(buf).digest('hex'),b64:buf.toString('base64')};}return {models};}
