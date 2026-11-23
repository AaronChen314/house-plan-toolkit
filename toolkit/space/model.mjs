/** Millimetres; plan X right/Y down; heights positive upward. No project constants. */
export function pointInRing(x,y,ring){let inside=false;for(let i=0,j=ring.length-1;i<ring.length;j=i++){const [xi,yi]=ring[i],[xj,yj]=ring[j];if((yi>y)!==(yj>y)&&x<(xj-xi)*(y-yi)/(yj-yi)+xi)inside=!inside}return inside}
export function pointInPoly(x,y,p){return pointInRing(x,y,p.outer)&&!(p.holes||[]).some(h=>pointInRing(x,y,h))}
export function boundsOf(polys){const ps=polys.flatMap(p=>p.outer);if(!ps.length)return [0,0,0,0];return ps.reduce((b,p)=>[Math.min(b[0],p[0]),Math.min(b[1],p[1]),Math.max(b[2],p[0]),Math.max(b[3],p[1])],[Infinity,Infinity,-Infinity,-Infinity])}
export function resolveLevels(data,slab=data.defaults.slab){
 const cache=new Map(),active=new Set();
 function solve(id,field){const key=id+':'+field;if(cache.has(key))return cache.get(key);if(active.has(key))throw new Error('Cyclic height relation: '+key);
 const f=data.floors.find(f=>f.id===id);if(!f)throw new Error('Unknown floor: '+id);active.add(key);const v=expression(f[field]);if(!Number.isFinite(v))throw new Error('Unknown or invalid '+key);cache.set(key,v);active.delete(key);return v;}
 function expression(e){if(typeof e==='number')return e;if(!e||typeof e!=='object')return NaN;return (e.floorId?solve(e.floorId,e.field||'elevation'):0)+(e.valueMm??0)+(e.slabFactor??0)*slab;}
 const levels=data.floors.map(f=>({id:f.id,elevation:solve(f.id,'elevation'),clearHeight:solve(f.id,'clearHeight'),wallHeight:f.wallHeight===undefined?solve(f.id,'clearHeight'):expression(f.wallHeight),slab:expression(f.slabThickness??{slabFactor:1})}));
 return {levels,byId:Object.fromEntries(levels.map(l=>[l.id,l])),expression};
}
function intersects(a,b){
 if(a.outer.some(p=>pointInPoly(...p,b))||b.outer.some(p=>pointInPoly(...p,a)))return true;
 const cross=(p,q,r)=>(q[0]-p[0])*(r[1]-p[1])-(q[1]-p[1])*(r[0]-p[0]);
 for(let i=0;i<a.outer.length;i++)for(let j=0;j<b.outer.length;j++){const p=a.outer[i],q=a.outer[(i+1)%a.outer.length],r=b.outer[j],s=b.outer[(j+1)%b.outer.length];if(cross(p,q,r)*cross(p,q,s)<0&&cross(r,s,p)*cross(r,s,q)<0)return true}return false;
}
export function furnitureHeight(data,f,it,resolved){
 if(it.cabinetRole!=='full')return it.heightMm;
 const base=resolved.byId[f.id].elevation,limits=[resolved.byId[f.id].clearHeight];
 for(const id of f.ceilingFromFloorIds||[]){const other=data.floors.find(x=>x.id===id),l=resolved.byId[id];if(!other||!l)throw new Error('Unknown ceiling floor: '+id);
  if(l.elevation>base&&other.slab.some(p=>it.footprint.some(q=>intersects(p,q))))limits.push(l.elevation-l.slab-base);}
 for(const zone of f.ceilingZones||[]){if(zone.footprint.some(p=>it.footprint.some(q=>intersects(p,q))))limits.push(resolved.expression(zone.top)-base);}
 return Math.min(...limits)-(it.baseMm||0)-(it.topGapMm||0);
}
export function prepareModel(input){const data=structuredClone(input);data.defaults={slab:150,...data.defaults};data.view={explodeGapMm:3500,cutWallMm:1400,...data.view};
 const normalizePoly=p=>{if(p&&Array.isArray(p.outer))p.holes??=[]};
 for(const f of data.floors||[]){for(const k of ['walls','columns','slab','outdoor','doors','windowOpenings','furniture','trace','walkEntries','guards','treads','ceilingZones'])f[k]??=[];f.windows=f.windowOpenings.map(w=>w.footprint);for(const k of ['walls','columns','slab','outdoor','roofSlab'])for(const p of f[k]||[])normalizePoly(p);for(const t of f.treads)normalizePoly(t.polygon||t);for(const z of f.ceilingZones)for(const p of z.footprint||[])normalizePoly(p);for(const w of f.windowOpenings)normalizePoly(w.footprint);for(const it of f.furniture)for(const p of it.footprint||[])normalizePoly(p);
  for(const it of [...f.furniture,...f.doors,...f.windowOpenings]){it.sourceHandles??=[];it.heightFrom??='unknown';it.baseMm??=0;it.detail??=[];if(it.footprint&&Array.isArray(it.footprint))it.bounds??=boundsOf(it.footprint);}
 }
 const bounds=boundsOf(data.floors.flatMap(f=>[...f.slab,...f.outdoor]));data.view.centerMm??=[(bounds[0]+bounds[2])/2,(bounds[1]+bounds[3])/2];return data;}
export function validateModel(data){const issues=[],issue=(severity,code,object,message)=>issues.push({severity,code,object,message});
 if(data.schema!=='space-model/v1')issue('error','schema','document','Expected space-model/v1');
 if(data.units!=='mm')issue('error','units','document','Only explicit millimetres supported');
 if(!data.projectId)issue('error','project-id','document','projectId is required for isolated settings');
 if(!Array.isArray(data.floors)||!data.floors.length)return {passed:false,issues:[...issues,{severity:'error',code:'floors',message:'At least one floor is required'}]};
 const ids=new Set();let resolved;
 for(const f of data.floors){if(!f.id||ids.has(f.id))issue('error','floor-id',f.id,'Missing or duplicate floor id');ids.add(f.id);}
 try{resolved=resolveLevels(data)}catch(e){issue('error','height-relations','document',e.message)}
 const polyCheck=(p,id)=>{if(!p||!Array.isArray(p.outer)||p.outer.length<3){issue('error','polygon',id,'Missing polygon ring');return;}
 for(const ring of [p.outer,...(p.holes||[])]){if(ring.some(p=>!Array.isArray(p)||p.length!==2||p.some(v=>!Number.isFinite(v))))issue('error','coordinates',id,'Invalid coordinates');}}
 for(const f of data.floors){const names=new Set();for(const key of ['slab','outdoor','walls','columns','roofSlab','treads'])for(const [i,p] of (f[key]||[]).entries())polyCheck(p.polygon||p,f.id+':'+key+':'+i);for(const [i,z] of f.ceilingZones.entries()){for(const p of z.footprint||[])polyCheck(p,f.id+':ceiling:'+i);if(resolved)try{if(!Number.isFinite(resolved.expression(z.top)))throw new Error('Invalid local ceiling top')}catch(e){issue('error','ceiling-height',f.id+':ceiling:'+i,e.message)}}
  const l=resolved?.byId[f.id];if(l&&(l.clearHeight<=0||l.wallHeight<=0||l.slab<=0))issue('error','height',f.id,'Height and slab must be positive');
  for(const ref of [...(f.ceilingFromFloorIds||[]),...(f.stairsTo?[f.stairsTo]:[])])if(!ids.has(ref))issue('error','floor-reference',f.id,'Unknown floor '+ref);
  if(f.treads?.length&&!f.stairsTo)issue('error','stairs-target',f.id,'Treads require stairsTo');
  for(const it of [...(f.furniture||[]),...(f.doors||[]),...(f.windowOpenings||[])]){
   const id=f.id+':'+it.id;if(!it.id||names.has(it.id))issue('error','object-id',id,'Missing or duplicate object id');names.add(it.id);
   if(it.heightFrom==='unknown')issue('warning','height-source',id,'Vertical source not specified');
   if(it.kind==='window'){if(!(it.headMm>it.sillMm&&it.sillMm>=0))issue('error','window-height',id,'Head must be above sill');polyCheck(it.footprint,id);}
   else if(it.kind==='door'){for(const key of ['hinge','closedEnd','openEnd'])if(!Array.isArray(it[key])||it[key].length!==2||it[key].some(v=>!Number.isFinite(v)))issue('error','door-geometry',id,'Missing '+key);if(!(it.heightMm>0&&it.thicknessMm>0))issue('error','door-height',id,'Positive door height/thickness required');}
   else {for(const p of it.footprint||[])polyCheck(p,id);if(!it.footprint?.length)issue('error','furniture-footprint',id,'Footprint required');if(it.cabinetRole!=='full'&&!Number.isFinite(it.heightMm))issue('error','unknown-height',id,'Supply an explicit height or preview assumption');}
   if(l){try{const h=it.kind==='window'?it.headMm:it.kind==='door'?it.heightMm:furnitureHeight(data,f,it,resolved)+(it.baseMm||0);if(h<=0||h>l.clearHeight+1)issue('warning','clearance',id,'Component height conflicts with clear height');}catch(e){issue('error','component-relations',id,e.message)}}
  }
  for(const e of f.walkEntries||[])if(!f.slab.concat(f.outdoor||[]).some(p=>pointInPoly(...e.point,p)))issue('error','entry-support',f.id+':'+e.name,'Walk entry is outside floor support');
 }
 return {passed:!issues.some(i=>i.severity==='error'),issues};}
