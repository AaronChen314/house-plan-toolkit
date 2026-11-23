import * as THREE from 'three';
import {OrbitControls} from 'three/addons/controls/OrbitControls.js';
import {GLTFExporter} from 'three/addons/exporters/GLTFExporter.js';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {validateOverrides} from '../../space/dimensions.mjs';
import {resolveLevels,furnitureHeight as resolveFurnitureHeight,pointInRing,pointInPoly} from '../../space/model.mjs';
const data=JSON.parse(document.getElementById('model-data').textContent),$=s=>document.querySelector(s);
const [centerX,centerY]=data.view.centerMm.map(v=>v/1000);
let resolved=resolveLevels(data);
const escapeHTML=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const scene=new THREE.Scene();scene.background=new THREE.Color('#e9ecee');
const camera=new THREE.PerspectiveCamera(40,1,.05,250),renderer=new THREE.WebGLRenderer({antialias:true,preserveDrawingBuffer:true});
renderer.setPixelRatio(Math.min(devicePixelRatio,2));renderer.setClearColor('#e9ecee');renderer.outputColorSpace=THREE.SRGBColorSpace;renderer.toneMapping=THREE.ACESFilmicToneMapping;renderer.toneMappingExposure=.95;renderer.localClippingEnabled=true;
$('#canvas').append(renderer.domElement);renderer.domElement.setAttribute('aria-label','建筑白模三维预览');
const controls=new OrbitControls(camera,renderer.domElement);controls.enableDamping=true;controls.maxPolarAngle=Math.PI*.94;controls.minDistance=.15;controls.maxDistance=90;
scene.add(new THREE.HemisphereLight(0xffffff,0x8b979e,1.3));const sun=new THREE.DirectionalLight(0xffffff,2.1);sun.position.set(-12,25,15);scene.add(sun);const fill=new THREE.DirectionalLight(0xffffff,.7);fill.position.set(15,10,-10);scene.add(fill);const interiorLight=new THREE.AmbientLight(0xffffff,.8);interiorLight.visible=false;scene.add(interiorLight);
const model=new THREE.Group();model.name=data.name;scene.add(model);
const wallMat=new THREE.MeshStandardMaterial({color:0xfafaf7,roughness:.9,metalness:0,side:THREE.DoubleSide});
const slabMat=new THREE.MeshStandardMaterial({color:data.view.floorFinish||0xbec7cd,roughness:1,side:THREE.DoubleSide});
const glassMat=new THREE.MeshStandardMaterial({color:0xc8d4da,roughness:.2,transparent:true,opacity:.22,depthWrite:false,side:THREE.DoubleSide});
const lineMat=new THREE.LineBasicMaterial({color:0x89949b,transparent:true,opacity:.6});
const edgeMat=new THREE.LineBasicMaterial({color:0x646f76,transparent:true,opacity:.55});
let mode='exploded',selection='all',rootGroups=[],low=true,roof=false,trace=false,section=false,furniture=true,slabMm=data.defaults.slab,exporting=false;
let furnReal=true,furnColor=Boolean(data.view.furnitureColor);
let openingModels=true,doorOpen=1,doorObstacles=[];
const dimKey='space-toolkit:'+data.projectId+':dimensions:v1';
let dimensionOverrides={...data.overrides};
try{const current=localStorage.getItem(dimKey);if(current===null){for(const key of data.view.legacyStorageKeys||[])dimensionOverrides={...JSON.parse(localStorage.getItem(key)||'{}'),...dimensionOverrides}}else dimensionOverrides={...dimensionOverrides,...JSON.parse(current)}}catch{}
for(const [key,aliases] of Object.entries(data.overrideAliases||{}))if(dimensionOverrides[key])for(const alias of aliases)dimensionOverrides[alias]??={...dimensionOverrides[key]};
const dimId=(f,it)=>f.id+':'+it.id;
function dimensionItem(f,it){return {...it,...(dimensionOverrides[dimId(f,it)]||{})}}
function furnitureHeight(f,it){return resolveFurnitureHeight(data,f,it,resolved)}

const FURN=JSON.parse((document.getElementById('furn-glb')||{}).textContent||'{"models":{}}');
function shape(p){const s=new THREE.Shape(p.outer.map(([x,y])=>new THREE.Vector2(x/1000,-y/1000)));for(const h of p.holes)s.holes.push(new THREE.Path(h.map(([x,y])=>new THREE.Vector2(x/1000,-y/1000))));return s}
function extrude(p,z,height,mat,group,name,outline=true){if(height<=0)return;const geom=new THREE.ExtrudeGeometry(shape(p),{depth:height/1000,bevelEnabled:false,curveSegments:8});geom.rotateX(-Math.PI/2);geom.translate(-centerX,z/1000,-centerY);const mesh=new THREE.Mesh(geom,mat);mesh.name=name;group.add(mesh);if(!outline)return mesh;const edges=new THREE.LineSegments(new THREE.EdgesGeometry(geom,25),edgeMat);edges.name=name+'边线';group.add(edges);return mesh}
function rect(x0,y0,x1,y1){return {outer:[[x0,y0],[x1,y0],[x1,y1],[x0,y1]],holes:[]}}
function line(points,g,mat=lineMat){const geom=new THREE.BufferGeometry().setFromPoints(points.map(([x,y,z])=>new THREE.Vector3(x/1000-centerX,z/1000,y/1000-centerY)));const l=new THREE.Line(geom,mat);g.add(l);return l}
function addGuard(g,x0,y0,x1,y1,guardHeight=1100){const len=Math.hypot(x1-x0,y1-y0),n=Math.max(1,Math.ceil(len/1000)),height=low?Math.min(guardHeight,data.view.cutWallMm):guardHeight;for(let i=0;i<=n;i++){const x=x0+(x1-x0)*i/n,y=y0+(y1-y0)*i/n;extrude(rect(x-15,y-15,x+15,y+15),0,height,wallMat,g,'预览栏杆立柱')}line([[x0,y0,height],[x1,y1,height]],g,edgeMat)}
/* ---------- 家具真模型（GLB）----------
   GLB 是米制、底面居中、前脸朝 +Z；白模的家具占地仍以 model.json 的 bounds/footprint 为准，
   所以这里只做“按占地缩放 + 靠背朝墙/朝外”的摆放，碰撞和漫游判定继续用 model.json，不受影响。 */
const glbCache=new Map();let glbRebuildTimer=0;
function loadFurn(id){
 const hit=glbCache.get(id);if(hit!==undefined)return hit;
 const m=FURN.models[id];if(!m){glbCache.set(id,null);return null}
 glbCache.set(id,null);
 const bin=Uint8Array.from(atob(m.b64),c=>c.charCodeAt(0)).buffer;
 new GLTFLoader().parseAsync(bin,'').then(gltf=>{
  const src=gltf.scene,bb=new THREE.Box3().setFromObject(src),size=bb.getSize(new THREE.Vector3());
  const max=Math.max(size.x,size.y,size.z),u=max>100?.001:max>12?.01:1;
  const inner=new THREE.Group();inner.add(src);inner.scale.setScalar(u);
  const c=bb.getCenter(new THREE.Vector3());
  inner.position.set(-c.x*u,-bb.min.y*u,-c.z*u);
  src.traverse(o=>{if(o.isMesh)o.userData.assetGeometry=true});
  const wrap=new THREE.Group();wrap.add(inner);
  wrap.userData.size=[size.x*u*1000,size.y*u*1000,size.z*u*1000];
  glbCache.set(id,wrap);
  clearTimeout(glbRebuildTimer);glbRebuildTimer=setTimeout(()=>{if(furnReal&&!exporting)rebuild()},60);
 }).catch(err=>{console.warn('[家具模型] 解析失败 '+id,err)});
 return null;
}
// 标签 → 模型：只映射形体对得上的（柜体、洁具、设备、圆几、圆餐桌、吧椅、工作台仍走白块）
function furnModelId(item){return item.assetId||null;}
/** 背面（-Z）应朝向哪个平面方向：床/沙发/床头柜靠最近的墙；椅子背朝最近桌子的反方向 */
function furnFacing(item,floor){
 if(typeof item.facing==='number')return [-Math.sin(item.facing),-Math.cos(item.facing)];
 if(Array.isArray(item.facing))return item.facing;
 if(item.kind==='bed'&&item.headSide)return item.headSide==='maxX'?[1,0]:[-1,0];
 const cx=(item.bounds[0]+item.bounds[2])/2,cy=(item.bounds[1]+item.bounds[3])/2;
 const half=Math.max(item.bounds[2]-item.bounds[0],item.bounds[3]-item.bounds[1])/2;
 if(item.kind==='chair'){
  let best=null,bestD=Infinity;
  for(const t of floor.furniture){
   if(t.kind!=='table'&&t.kind!=='dining'&&!(item.seatRole==='bar'&&t.cabinetRole==='bar'))continue;
   const tx=(t.bounds[0]+t.bounds[2])/2,ty=(t.bounds[1]+t.bounds[3])/2,d=Math.hypot(tx-cx,ty-cy);
   if(d<bestD&&d<2200){bestD=d;best=[(cx-tx)/d,(cy-ty)/d]}
  }
  if(best)return best;
 }
 for(const [dx,dy] of [[1,0],[-1,0],[0,1],[0,-1]]){
  for(let r=half+120;r<=half+900;r+=60){
   if(floor.walls.some(p=>nearPoly(cx+dx*r,cy+dy*r,p,70)))return [dx,dy];
  }
 }
 return [0,-1];
}
function furnRealMesh(item,floor){
 if(!furnReal)return false;
 const id=furnModelId(item);if(!id)return false;
 const src=loadFurn(id);if(!src)return false;
 const size=src.userData.size,group=new THREE.Group();
 const [x0,y0,x1,y1]=item.bounds,w=x1-x0,d=y1-y0;
 const [dx,dy]=furnFacing(item,floor);
 // 让背面(-Z)朝向 (dx,dy)：rotation.y=θ 时背面方向是 (-sinθ,-cosθ)
 const th=typeof item.facing==='number'?item.facing:Math.round(Math.atan2(-dx,-dy)/(Math.PI/2))*(Math.PI/2);
 const swap=Math.abs(Math.round(th/(Math.PI/2)))%2===1;
 const [width,depth]=item.assetSizeMm ?? [swap?d:w,swap?w:d];
 const fit=width/size[0],fitZ=depth/size[2];
 const sy=Math.max((item.modelHeightMm??item.heightMm)/size[1],item.minAssetHeightScale??0); // 白模的高度是预览假设，托底避免床/矮几被压扁
 const mesh=src.clone(true);
 mesh.traverse(o=>{if(o.isMesh)o.material=!furnColor?furnitureMat:($('#palette').value==='warm'?(Array.isArray(o.material)?o.material.map(styledMaterial):styledMaterial(o.material)):o.material)});
 mesh.scale.set(fit,sy,fitZ);
 group.add(mesh);
 // 程序化几何是直接按平面坐标生成的（group 在原点），GLB 是居中模型，必须自己摆到占地中心
 group.position.set((x0+x1)/2/1000-centerX, (item.baseMm||0)/1000, (y0+y1)/2/1000-centerY);
 group.rotation.y=th;
 group.name=item.label;
 group.userData={furniture:true,itemId:item.id,sourceHandles:item.sourceHandles,heightFrom:item.heightFrom,glb:id};
 return group;
}
const furnitureMat=new THREE.MeshStandardMaterial({color:0xe5e1d9,roughness:.95,side:THREE.DoubleSide});
const cushionMat=new THREE.MeshStandardMaterial({color:0xf5f2eb,roughness:1,side:THREE.DoubleSide});

const woodMat=new THREE.MeshStandardMaterial({color:0xb49a78,roughness:.85});
const frameMat=new THREE.MeshStandardMaterial({color:0x696a65,roughness:.65});
const styledCache=new Map();
function styledMaterial(m){if(styledCache.has(m.uuid))return styledCache.get(m.uuid);const c=m.clone(),n=m.name.toLowerCase();
 c.color.set(/oak|walnut|wood|timber/.test(n)?0xb49a78:/steel|black|metal/.test(n)?0x555753:/fabric|linen|soft|plum|mustard|cushion/.test(n)?0xe1d8c9:0xd4c5ad);c.roughness=.85;styledCache.set(m.uuid,c);return c;}
function beamBetween(a,b,z,h,thick,mat,g,name){const dx=b[0]-a[0],dy=b[1]-a[1],l=Math.hypot(dx,dy),nx=-dy/l*thick/2,ny=dx/l*thick/2;
 const p={outer:[[a[0]+nx,a[1]+ny],[b[0]+nx,b[1]+ny],[b[0]-nx,b[1]-ny],[a[0]-nx,a[1]-ny]],holes:[]};extrude(p,z,h,mat,g,name);return p;}
function windowMesh(w,g,bh){const [x0,y0,x1,y1]=w.bounds,wide=x1-x0>=y1-y0,sill=Math.min(w.sillMm,bh),head=Math.min(w.headMm,bh);
 extrude(w.footprint,0,sill,wallMat,g,w.label+'窗下墙');if(bh>head&&!w.freestanding)extrude(w.footprint,head,bh-head,wallMat,g,w.label+'窗上墙');
 if(!openingModels||head<=sill)return;
 const a=wide?[x0,(y0+y1)/2]:[(x0+x1)/2,y0],b=wide?[x1,(y0+y1)/2]:[(x0+x1)/2,y1],len=Math.hypot(b[0]-a[0],b[1]-a[1]);
 const win=new THREE.Group();win.name=w.label;win.userData={opening:'window',sourceHandles:w.sourceHandles,sillMm:sill,headMm:w.headMm,heightFrom:w.heightFrom};g.add(win);
 beamBetween(a,b,sill,head-sill,12,glassMat,win,'玻璃');beamBetween(a,b,sill,45,60,frameMat,win,'窗下框');beamBetween(a,b,Math.max(sill,head-45),45,60,frameMat,win,'窗上框');
 const count=Math.max(1,Math.ceil(len/1300));for(let i=0;i<=count;i++){const x=a[0]+(b[0]-a[0])*i/count,y=a[1]+(b[1]-a[1])*i/count;extrude(rect(x-23,y-23,x+23,y+23),sill,head-sill,frameMat,win,'窗竖框')}
}
function doorMesh(d,g,bh,f){const h=Math.min(d.heightMm,bh),a=d.hinge,b=d.closedEnd,dx=b[0]-a[0],dy=b[1]-a[1],length=Math.hypot(dx,dy);
 const door=new THREE.Group();door.name=d.label;door.userData={opening:'door',sourceHandles:d.sourceHandles,heightMm:d.heightMm,heightFrom:d.heightFrom};g.add(door);
 if(bh>d.heightMm&&!d.freestanding)beamBetween(a,b,d.heightMm,bh-d.heightMm,d.thicknessMm,wallMat,door,'门头墙');if(!openingModels)return;
 if(d.slideMm){
  const travel=d.slideMm.map(v=>v*doorOpen);
  const panel=beamBetween([a[0]+travel[0],a[1]+travel[1]],[b[0]+travel[0],b[1]+travel[1]],10,h-10,40,d.glazed?glassMat:(furnColor?woodMat:furnitureMat),door,'移门');
  doorObstacles.push({floor:data.floors.indexOf(f),height:d.heightMm,poly:panel});
  return;
 }
 const paired=f.doors.some(other=>other.id!==d.id&&Math.hypot(other.closedEnd[0]-b[0],other.closedEnd[1]-b[1])<65);
 for(const p of paired?[a]:[a,b])beamBetween([p[0]-dx/length*25,p[1]-dy/length*25],[p[0]+dx/length*25,p[1]+dy/length*25],0,h,d.thicknessMm,frameMat,door,'门套竖框');
 if(!low)beamBetween(a,b,h-45,45,d.thicknessMm,frameMat,door,'门套上框');
 const closed=Math.atan2(dy,dx),opened=Math.atan2(d.openEnd[1]-a[1],d.openEnd[0]-a[0]);let delta=Math.atan2(Math.sin(opened-closed),Math.cos(opened-closed));
 const angle=closed+delta*doorOpen,end=[a[0]+Math.cos(angle)*(length-40),a[1]+Math.sin(angle)*(length-40)],mat=d.glazed?glassMat:(furnColor?woodMat:furnitureMat);
 const poly=beamBetween(a,end,12,h-24,38,mat,door,d.glazed?'玻璃门扇':'木门扇');
 beamBetween(a,end,12,65,45,frameMat,door,'门扇下框');if(!low)beamBetween(a,end,h-55,45,45,frameMat,door,'门扇上框');
 for(const p of [a,end])extrude(rect(p[0]-20,p[1]-20,p[0]+20,p[1]+20),12,h-24,d.glazed?frameMat:mat,door,'门扇边框');
 const hx=a[0]+(end[0]-a[0])*.86,hy=a[1]+(end[1]-a[1])*.86;extrude(rect(hx-45,hy-28,hx+45,hy+28),990,24,frameMat,door,'门把手');
 doorObstacles.push({floor:data.floors.indexOf(f),height:d.heightMm,poly});
}

const finishColors={walnut:0x836044,oak:0xb99772,veneer:0xa48060,interior:0x725443,
 ivory:0xdacbb4,stone:0xd6cbb6,ceramic:0xf0eee8,metal:0x656764,screen:0x303536,
 fabric:0xb7a18b,linen:0xd8cab7,leather:0x95674d,rug:0xb6ab99};
const finishMaterials=Object.fromEntries(Object.entries(finishColors).map(([name,color])=>
 [name,new THREE.MeshStandardMaterial({color,roughness:name==='ceramic'?.28:.78,side:THREE.DoubleSide})]));
function furnitureMesh(original,g,floor){
 const adjusted=dimensionItem(floor,original);const item={...adjusted,heightMm:furnitureHeight(floor,adjusted)};
 const cutCabinet=item.kind==='cabinet'&&low&&data.view.cutCabinets!==false;
 const physicalHeight=item.heightMm;
 if(cutCabinet)item.heightMm=Math.min(data.view.cutWallMm,item.heightMm);

 const real=furnRealMesh(item,floor);if(real){g.add(real);return}
 const group=new THREE.Group();group.name=item.label;group.userData={furniture:true,itemId:item.id,sourceHandles:item.sourceHandles,heightFrom:item.heightFrom,cabinetRole:item.cabinetRole,heightMm:item.heightMm};g.add(group);const [x0,y0,x1,y1]=item.bounds,w=x1-x0,d=y1-y0,h=item.heightMm,base=item.baseMm;
 const part=(p,z,height,mat=(furnColor?woodMat:furnitureMat))=>extrude(p,z+base,height,mat,group,item.label);
 const inset=(a,b,c,e)=>rect(a,b,c,e);
 if(item.parts?.length){
  for(const piece of item.parts){
   const bottom=piece.bottom*physicalHeight,top=Math.min(piece.top*physicalHeight,h);
   const mat=piece.finish==='glass'?glassMat:(furnColor?finishMaterials[piece.finish]:furnitureMat);
   extrude(piece.footprint,base+bottom,top-bottom,mat,group,piece.name||item.label,false);
  }
  return;
 }
 if(item.kind==='bed'){
  for(const p of item.footprint){part(p,80,260);part(p,340,220,cushionMat)}
  const right=item.headSide==='maxX',hx=right?x1-80:x0;part(rect(hx,y0,hx+80,y1),50,1050);
  for(let n=0;n<2;n++){const px=right?x1-530:x0+120;part(rect(px,y0+d*(.08+n*.47),px+400,y0+d*(.43+n*.47)),560,100,cushionMat)}
 }else if(item.kind==='table'||item.kind==='chair'){
  const seat=item.kind==='chair'?450:h-55;for(const p of item.footprint)part(p,seat,55);
  for(const fx of [.25,.75])for(const fy of [.25,.75]){const x=x0+w*fx,y=y0+d*fy;part(rect(x-22,y-22,x+22,y+22),0,seat)}
  if(item.kind==='chair')part(rect(x0+w*.12,y0+d*.08,x1-w*.12,y0+d*.08+45),480,h-480);
 }else if(item.kind==='sofa'){
  for(const p of item.footprint){part(p,80,330);part(p,410,120,cushionMat)}
  if(w>d){part(rect(x0,y0,x1,y0+100),480,h-480);for(let i=1;i<Math.max(2,Math.round(w/800));i++){const x=x0+w*i/Math.max(2,Math.round(w/800));line([[x,y0+120,535],[x,y1,535]],group,edgeMat)}}
  else{part(rect(x1-100,y0,x1,y1),480,h-480);for(let i=1;i<Math.max(2,Math.round(d/800));i++){const y=y0+d*i/Math.max(2,Math.round(d/800));line([[x0,y,535],[x1-100,y,535]],group,edgeMat)}}
 }else if(item.kind==='toilet'){
  for(const p of item.footprint)part(p,0,400,cushionMat);part(rect(x0,y0,x0+w*.3,y1),350,370,cushionMat);
 }else if(item.kind==='basin'){
  for(const p of item.footprint){part(p,0,h-60);part(p,h-60,60,cushionMat)}
 }else {for(const p of item.footprint)part(p,0,h);if(item.kind==='cabinet'){
  const n=Math.max(1,Math.round(Math.max(w,d)/500));for(let i=1;i<n;i++){if(w>d){const x=x0+w*i/n;line([[x,y1+2,30],[x,y1+2,h-30]],group,edgeMat)}else{const y=y0+d*i/n;line([[x1+2,y,30],[x1+2,y,h-30]],group,edgeMat)}}
 }}
 // Original plan outlines on the top retain finer source detail than the simplified elevation.
 const z=base+(item.kind==='bed'?565:item.kind==='sofa'?535:item.kind==='chair'?507:h+3);
 for(const points of item.detail)line(points.map(([x,y])=>[x,y,z]),group,edgeMat);
}

function clear(){doorObstacles=[];for(const g of rootGroups){g.traverse(o=>{if(o.geometry&&!o.userData.assetGeometry)o.geometry.dispose()});model.remove(g)}rootGroups=[]}
function rebuild(){const previousLevel=window.whiteModel?.state?.elevations?.[floorIndex()];clear();slabMm=Number($('#slab').value);resolved=resolveLevels(data,slabMm);const elevations=resolved.levels.map(l=>l.elevation),clearHeights=resolved.levels.map(l=>l.clearHeight);
for(let i=0;i<data.floors.length;i++){const f=data.floors[i],g=new THREE.Group();g.name=f.name;g.userData={floor:f.id,elevationMm:elevations[i],clearHeightMm:clearHeights[i]};g.position.y=elevations[i]/1000+(mode==='exploded'?i*data.view.explodeGapMm/1000:0);g.visible=selection==='all'||selection===f.id||(data.view.groups?.find(x=>x.id===selection)?.floorIds.includes(f.id));rootGroups.push(g);model.add(g);
const wh=low?Math.min(data.view.cutWallMm,clearHeights[i]):clearHeights[i];
// Explicit per-floor wall envelope, independent of display clipping.
const bh=Math.min(wh,resolved.levels[i].wallHeight),floorSlab=resolved.levels[i].slab;
for(const p of f.slab)extrude(p,-floorSlab,floorSlab,slabMat,g,'楼板');
for(const p of f.outdoor)extrude(p,-floorSlab,floorSlab,slabMat,g,'花园地面（源图边界）');
for(const p of f.walls)extrude(p,0,bh,wallMat,g,'墙体（源图轮廓）');
for(const zone of f.ceilingZones){
 if(!zone.beam)continue;
 const bottom=resolved.expression(zone.top)-elevations[i];
 for(const p of zone.footprint)extrude(p,bottom,bh-bottom,wallMat,g,zone.label||'梁');
}
for(const p of f.columns)extrude(p,0,bh,wallMat,g,'柱（源图轮廓）');
for(const w of f.windowOpenings||[])windowMesh(dimensionItem(f,w),g,bh);
for(const d of f.doors||[])doorMesh(dimensionItem(f,d),g,bh,f);
if(furniture)for(const item of f.furniture)furnitureMesh(item,g,f);
// Source 2D detail remains available without inventing furniture heights.
if(trace){const pts=[];for(const t of f.trace)for(let k=1;k<t.points.length;k++){for(const p of [t.points[k-1],t.points[k]])pts.push(p[0]/1000-centerX,.012,p[1]/1000-centerY)}const geom=new THREE.BufferGeometry();geom.setAttribute('position',new THREE.Float32BufferAttribute(pts,3));const wire=new THREE.LineSegments(geom,lineMat);wire.name='原平面线稿';g.add(wire)}
if(f.stairsTo){const rise=resolved.byId[f.stairsTo].elevation-elevations[i],steps=f.treads;for(let k=0;k<steps.length;k++){const z=steps[k].heightMm??(k+1)*rise/steps.length;extrude(steps[k].polygon||steps[k],z-90,90,wallMat,g,'示意踏步 '+(k+1))}}
for(const guard of f.guards)addGuard(g,...guard.a,...guard.b,guard.heightMm);
if(roof&&f.roofSlab?.length){for(const p of f.roofSlab)extrude(p,clearHeights[i],floorSlab,slabMat,g,'顶板（预览）')}

}
$('#levels').innerHTML=data.floors.map((f,i)=>`<div><span>${escapeHTML(f.name)}</span><b>${(elevations[i]/1000).toFixed(3)} m</b></div>`).join('');$('#clearHeights').innerHTML=data.floors.map((f,i)=>`<div>${escapeHTML(f.name)}净高 ${(clearHeights[i]/1000).toFixed(3)} m</div>`).join('');$('#slabValue').textContent=slabMm+' mm';updateClip();
window.whiteModel.state={mode,selection,slabMm,elevations,clearHeights,low,roof,trace,furniture,furnReal,furnColor};

model.updateMatrixWorld(true);supports=[];model.traverse(o=>{if(o.isMesh&&/^(楼板|花园地面|示意踏步|顶板)/.test(o.name))supports.push(o)});if(walkMode&&previousLevel!==undefined){walkFoot+=(elevations[floorIndex()]-previousLevel)/1000;camera.position.y=walkFoot+walkEye;}
}
function fit(top=false){const bb=new THREE.Box3();for(const g of rootGroups)if(g.visible)bb.union(new THREE.Box3().setFromObject(g));if(bb.isEmpty())return;const center=bb.getCenter(new THREE.Vector3()),size=bb.getSize(new THREE.Vector3()),radius=size.length()/2;const dist=radius/Math.sin(THREE.MathUtils.degToRad(camera.fov/2))*1.05;controls.target.copy(center);camera.position.copy(center).add(new THREE.Vector3(...(top?[.001,1,.001]:(data.view.orbitDirection||[1.05,.9,1.25]))).normalize().multiplyScalar(dist));camera.near=.05;camera.far=300;camera.updateProjectionMatrix();controls.update()}
function updateClip(){const n=Number($('#cut').value);$('#cutValue').textContent=n===100?'完整':n+'%';const b=new THREE.Box3().setFromObject(model),h=b.min.y+(b.max.y-b.min.y)*n/100;renderer.clippingPlanes=n===100?[]:[new THREE.Plane(new THREE.Vector3(0,-1,0),h)];if(section)renderer.clippingPlanes.push(new THREE.Plane(new THREE.Vector3(-1,0,-1).normalize(),0));}

function resize(){const r=$('#canvas').getBoundingClientRect();renderer.setSize(r.width,r.height);camera.aspect=r.width/r.height;camera.updateProjectionMatrix()}
const ro=new ResizeObserver(resize);ro.observe($('#canvas'));
function choose(id){if(walkMode){if(data.floors.some(f=>f.id===id)){setupPlaces(id);enterWalk(id);return}else exitWalk()}selection=id;$('#floors').querySelectorAll('button').forEach(b=>b.classList.toggle('active',b.dataset.floor===id));rebuild();fit()}
for(const f of [{id:'all',name:'全部楼层'},...(data.view.groups||[]),...data.floors]){const b=document.createElement('button');b.dataset.floor=f.id;b.textContent=f.name;b.className=f.id==='all'?'active':'';b.onclick=()=>choose(f.id);$('#floors').append(b)}
$('#furniture').onchange=e=>{furniture=e.target.checked;rebuild()};
$('#furnReal').onchange=e=>{furnReal=e.target.checked;rebuild()};
$('#furnColor').onchange=e=>{furnColor=e.target.checked;rebuild()};
$('#palette').onchange=()=>rebuild();
$('#openingModels').onchange=e=>{openingModels=e.target.checked;rebuild()};
$('#doorOpen').oninput=e=>{doorOpen=+e.target.value/100;rebuild()};
$('#mode').onchange=e=>{mode=e.target.value;rebuild();fit()};$('#low').onchange=e=>{low=e.target.checked;rebuild()};$('#roof').onchange=e=>{roof=e.target.checked;rebuild()};$('#trace').onchange=e=>{trace=e.target.checked;rebuild()};$('#slab').oninput=()=>{rebuild()};$('#cut').oninput=updateClip;$('#section').onchange=e=>{section=e.target.checked;updateClip()};$('#fit').onclick=()=>fit();$('#top').onclick=()=>fit(true);
$('#basementView').hidden=!data.view.groups?.length;$('#basementView').textContent='查看组合空间';$('#basementView').onclick=()=>{mode='stacked';$('#mode').value=mode;low=false;$('#low').checked=false;choose(data.view.groups[0].id)};

const reset=()=>{if(walkMode)exitWalk();furniture=true;$('#furniture').checked=true;furnReal=true;$('#furnReal').checked=true;furnColor=Boolean(data.view.furnitureColor);$('#furnColor').checked=furnColor;mode='exploded';selection='all';low=true;roof=false;trace=false;section=false;$('#section').checked=false;$('#mode').value=mode;$('#low').checked=true;$('#roof').checked=false;$('#trace').checked=false;$('#slab').value=data.defaults.slab;$('#cut').value=100;choose('all')};$('#reset').onclick=reset;
function save(name,blob){const u=URL.createObjectURL(blob),a=document.createElement('a');a.href=u;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(u),1000)}
$('#png').onclick=()=>{renderer.render(scene,camera);renderer.domElement.toBlob(b=>save(data.projectId+'-白模.png',b))};
$('#glb').onclick=async()=>{if(exporting)return;exporting=true;$('#glb').textContent='正在导出…';try{const copy=model.clone(true);copy.name=data.name;const levels=resolved.levels.map(l=>l.elevation);copy.children.forEach((g,i)=>{g.position.y=levels[i]/1000;g.visible=true});const result=await new GLTFExporter().parseAsync(copy,{binary:true,onlyVisible:true});save(data.projectId+'-白模.glb',new Blob([result],{type:'model/gltf-binary'}));}catch(e){$('#status').textContent='Export failed: '+e.message;console.error(e)}finally{exporting=false;$('#glb').textContent='导出 GLB'}};
let walkMode=false,walkFloor=data.floors[0].id,walkFoot=0,walkYaw=0,walkPitch=0,walkEye=1.65,savedView=null;
const pressed=new Set(),groundRay=new THREE.Raycaster(),upRay=new THREE.Raycaster();let supports=[];
const pointer={active:false,x:0,y:0};
function applyLook(){camera.rotation.order='YXZ';camera.rotation.set(walkPitch,walkYaw,0)}
function floorIndex(id=walkFloor){return data.floors.findIndex(f=>f.id===id)}
function setupPlaces(id){const f=data.floors.find(f=>f.id===id)||data.floors[0];$('#walkFloor').value=f.id;$('#walkRoom').replaceChildren();for(const entry of f.walkEntries){const o=document.createElement('option');o.value=entry.name;o.textContent=entry.name;$('#walkRoom').append(o)}const desired=f.walkEntries[0];$('#walkEnter').disabled=!desired;if(desired)$('#walkRoom').value=desired.name;}
function enterWalk(id=$('#walkFloor').value,room=$('#walkRoom').value){
 if(!walkMode)savedView={mode,selection,low,roof,section,trace,cut:$('#cut').value,position:camera.position.clone(),target:controls.target.clone()};
 if($('#walkFloor').value!==id)setupPlaces(id);
 walkFloor=id;const f=data.floors[floorIndex()],entry=f.walkEntries.find(e=>e.name===room)||f.walkEntries[0];if(!entry)return;$('#walkRoom').value=entry.name;
 walkMode=true;interiorLight.visible=true;mode='stacked';selection='all';low=false;roof=true;section=false;furniture=true;
 $('#mode').value=mode;$('#low').checked=false;$('#roof').checked=true;$('#section').checked=false;$('#furniture').checked=true;$('#cut').value=100;
 controls.enabled=false;controls.enableDamping=false;pressed.clear();rebuild();model.updateMatrixWorld(true);walkFoot=whiteModel.state.elevations[floorIndex()]/1000;walkEye=Number($('#eye').value)/1000;
 camera.fov=75;camera.near=.02;camera.updateProjectionMatrix();camera.position.set(entry.point[0]/1000-centerX,walkFoot+walkEye,entry.point[1]/1000-centerY);
 // Face toward the centre of the room's nearest open area, not a fixed world direction.
 const aim=entry.lookAt?{x:entry.lookAt[0],y:entry.lookAt[1]}:f.furniture.length?f.furniture.reduce((a,it)=>{const cx=(it.bounds[0]+it.bounds[2])/2,cy=(it.bounds[1]+it.bounds[3])/2,dist=Math.hypot(cx-entry.point[0],cy-entry.point[1]);return dist>750&&dist<a.dist?{x:cx,y:cy,dist}:a},{x:entry.point[0],y:entry.point[1]-1000,dist:Infinity}):{x:entry.point[0],y:entry.point[1]-1000};
 $('#floors').querySelectorAll('button').forEach(b=>b.classList.toggle('active',b.dataset.floor===id));walkYaw=Math.atan2(-(aim.x-entry.point[0]),-(aim.y-entry.point[1]));walkPitch=-.16;applyLook();$('#walk-pad').hidden=false;$('#walkExitOverlay').hidden=false;$('#walkHud').hidden=false;$('#walkHud').textContent=f.name+' · '+entry.name;if(innerWidth<751)$('#canvas').scrollIntoView({block:'start'});$('#walkExit').hidden=false;$('#walkEnter').textContent='进入所选房间';document.body.classList.add('walking');$('#walkLocation').textContent=f.name+' · '+entry.name;$('#status').textContent='漫游：WASD / 方向键移动，拖动转头，Esc返回鸟瞰';
 for(const selector of ['#mode','#low','#roof','#section','#cut','#fit','#top','#basementView'])$(selector).disabled=true;
}
function exitWalk(){if(!walkMode)return;walkMode=false;interiorLight.visible=false;pressed.clear();pointer.active=false;controls.enabled=true;controls.enableDamping=true;camera.fov=40;camera.near=.05;camera.updateProjectionMatrix();$('#walk-pad').hidden=true;$('#walkExitOverlay').hidden=true;$('#walkHud').hidden=true;$('#walkExit').hidden=true;document.body.classList.remove('walking');$('#walkEnter').textContent='进入房间漫游';$('#walkLocation').textContent='';for(const selector of ['#mode','#low','#roof','#section','#cut','#fit','#top','#basementView'])$(selector).disabled=false;
 if(savedView){({mode,selection,low,roof,section,trace}=savedView);$('#mode').value=mode;$('#low').checked=low;$('#roof').checked=roof;$('#section').checked=section;$('#trace').checked=trace;$('#cut').value=savedView.cut;rebuild();camera.position.copy(savedView.position);controls.target.copy(savedView.target);controls.update()}
 $('#floors').querySelectorAll('button').forEach(b=>b.classList.toggle('active',b.dataset.floor===selection));$('#status').textContent='Three.js / WebGL · 家具白模';
}
function segmentDistance(x,y,a,b){const dx=b[0]-a[0],dy=b[1]-a[1],d=dx*dx+dy*dy,t=d?Math.max(0,Math.min(1,((x-a[0])*dx+(y-a[1])*dy)/d)):0;return Math.hypot(x-a[0]-t*dx,y-a[1]-t*dy)}
function nearPoly(x,y,p,r=175){if(pointInPoly(x,y,p))return true;for(const ring of [p.outer,...p.holes])for(let i=1;i<ring.length;i++)if(segmentDistance(x,y,ring[i-1],ring[i])<r)return true;return false}
function blocked(x,z,foot){const xx=(x+centerX)*1000,yy=(z+centerY)*1000,eye=foot+walkEye;for(let i=0;i<data.floors.length;i++){const f=data.floors[i],base=whiteModel.state.elevations[i]/1000,top=base+resolved.levels[i].wallHeight/1000;if(foot<top-.04&&eye>base+.08){if([...f.walls,...f.columns,...f.windows].some(p=>nearPoly(xx,yy,p)))return true}if(furniture)for(const original of f.furniture){const it=dimensionItem(f,original),height=furnitureHeight(f,it);const lo=base+it.baseMm/1000,hi=lo+height/1000;if(height>200&&foot<hi-.1&&eye>lo+.1&&it.footprint.some(p=>nearPoly(xx,yy,p)))return true}}
 for(const d of doorObstacles){const base=whiteModel.state.elevations[d.floor]/1000;if(foot<base+d.height/1000-.1&&eye>base+.1&&nearPoly(xx,yy,d.poly))return true}
 return false;
}
function supportAt(x,z,foot){groundRay.set(new THREE.Vector3(x,foot+.29,z),new THREE.Vector3(0,-1,0));groundRay.far=.65;const hit=groundRay.intersectObjects(supports,false)[0];return hit?{y:hit.point.y,mesh:hit.object}:null}
function moveWalk(dx,dz){const start=camera.position,dist=Math.hypot(dx,dz),n=Math.max(1,Math.ceil(dist/.06));for(let i=0;i<n;i++){
 const attempt=(x,z)=>{const hit=supportAt(x,z,walkFoot);if(!hit||hit.y-walkFoot>.27||walkFoot-hit.y>.3||blocked(x,z,hit.y))return false;
 for(const [a,b] of [[.13,0],[-.13,0],[0,.13],[0,-.13]]){const s=supportAt(x+a,z+b,hit.y);if(!s||Math.abs(s.y-hit.y)>.28)return false}
 upRay.set(new THREE.Vector3(x,hit.y+.15,z),new THREE.Vector3(0,1,0));upRay.far=walkEye+.03-.15;if(upRay.intersectObjects(supports,false).length)return false;
 start.x=x;start.z=z;walkFoot=hit.y;start.y=walkFoot+walkEye;let owner=hit.mesh;while(owner&&!owner.userData.floor)owner=owner.parent;if(owner&&owner.userData.floor!==walkFloor){walkFloor=owner.userData.floor;setupPlaces(walkFloor);$('#walkLocation').textContent=data.floors[floorIndex()].name+' · 行走中';$('#walkHud').textContent=$('#walkLocation').textContent}return true};
 if(!attempt(start.x+dx/n,start.z+dz/n)){if(Math.abs(dx)>1e-8)attempt(start.x+dx/n,start.z);if(Math.abs(dz)>1e-8)attempt(start.x,start.z+dz/n)}
 }}
function walkTick(dt){if(!walkMode)return;let forward=Number(pressed.has('KeyW')||pressed.has('ArrowUp'))-Number(pressed.has('KeyS')||pressed.has('ArrowDown')),side=Number(pressed.has('KeyD')||pressed.has('ArrowRight'))-Number(pressed.has('KeyA')||pressed.has('ArrowLeft'));const len=Math.hypot(forward,side);if(len){const speed=(pressed.has('ShiftLeft')?2.2:1.25)*Math.min(dt,.05)/len;moveWalk((-Math.sin(walkYaw)*forward+Math.cos(walkYaw)*side)*speed,(-Math.cos(walkYaw)*forward-Math.sin(walkYaw)*side)*speed)}applyLook()}
window.addEventListener('keydown',e=>{if(e.code==='Escape'&&walkMode){e.preventDefault();exitWalk();return}if(!walkMode||/^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName))return;if(['KeyW','KeyA','KeyS','KeyD','ArrowUp','ArrowDown','ArrowLeft','ArrowRight','ShiftLeft'].includes(e.code)){e.preventDefault();pressed.add(e.code)}});
window.addEventListener('keyup',e=>pressed.delete(e.code));window.addEventListener('blur',()=>pressed.clear());
renderer.domElement.addEventListener('pointerdown',e=>{if(!walkMode)return;pointer.active=true;pointer.x=e.clientX;pointer.y=e.clientY;renderer.domElement.setPointerCapture(e.pointerId)});
renderer.domElement.addEventListener('pointermove',e=>{if(!walkMode||!pointer.active)return;walkYaw-=(e.clientX-pointer.x)*.004;walkPitch=Math.max(-1.35,Math.min(1.35,walkPitch-(e.clientY-pointer.y)*.004));pointer.x=e.clientX;pointer.y=e.clientY;applyLook()});
for(const event of ['pointerup','pointercancel'])renderer.domElement.addEventListener(event,()=>pointer.active=false);
for(const button of document.querySelectorAll('[data-walk-key]')){button.addEventListener('pointerdown',e=>{e.preventDefault();button.setPointerCapture(e.pointerId);pressed.add(button.dataset.walkKey)});for(const event of ['pointerup','pointercancel','lostpointercapture'])button.addEventListener(event,()=>pressed.delete(button.dataset.walkKey))}
$('#walkEnter').onclick=()=>enterWalk();$('#walkExit').onclick=exitWalk;$('#walkExitOverlay').onclick=exitWalk;$('#walkFloor').onchange=()=>setupPlaces($('#walkFloor').value);$('#walkRoom').onchange=()=>{if(walkMode)enterWalk()};$('#eye').oninput=()=>{walkEye=Number($('#eye').value)/1000;$('#eyeValue').textContent=walkEye.toFixed(2)+' m';if(walkMode)camera.position.y=walkFoot+walkEye};
for(const f of data.floors){const o=document.createElement('option');o.value=f.id;o.textContent=f.name;$('#walkFloor').append(o)}
setupPlaces(data.view.entryFloor||data.floors[0].id);

window.whiteModel={data,scene,model,renderer,camera,controls,choose,rebuild,fit,enterWalk,exitWalk,moveWalk,blocked,supportAt,get walk(){return {active:walkMode,floor:walkFloor,foot:walkFoot,eye:walkEye,yaw:walkYaw}},get state(){return this._state},set state(v){this._state=v}};

const dimensionEntries=[];
for(const f of data.floors)for(const it of [...f.furniture.filter(it=>it.kind==='cabinet'),...f.doors,...f.windowOpenings]){
 dimensionEntries.push({f,it});const o=document.createElement('option');o.value=dimId(f,it);o.textContent=f.name+' · '+it.label;$('#dimensionObject').append(o);}
function selectedDimension(){return dimensionEntries.find(({f,it})=>dimId(f,it)===$('#dimensionObject').value)}
function showDimension(){if(!selectedDimension()){$('#dimensionSettings').hidden=true;return}const {f,it}=selectedDimension(),v=dimensionItem(f,it),cab=it.kind==='cabinet',win=it.kind==='window';$('#cabinetRoleLabel').hidden=!cab;$('#sillLabel').hidden=!win;$('#cabinetRole').value=v.cabinetRole||'counter';$('#dimensionHeight').value=cab?furnitureHeight(f,v):win?v.headMm:v.heightMm;$('#dimensionHeight').disabled=cab&&v.cabinetRole==='full';$('#dimensionSill').value=v.sillMm||0;$('#dimensionNote').textContent=(cab&&v.cabinetRole==='full'?'到顶柜随所在空间净高变化。':'高度为预览值，可按立面图调整。')+' '+(it.heightBasis||'')+' 原图依据：'+it.sourceHandles.join(' / ');}
function saveDimension(){const {f,it}=selectedDimension(),cab=it.kind==='cabinet',win=it.kind==='window',height=Math.max(300,Math.min(100000,+$('#dimensionHeight').value||2200));const v=cab?{cabinetRole:$('#cabinetRole').value,heightMm:height}:win?{headMm:height,sillMm:Math.max(0,Math.min(height-100,+$('#dimensionSill').value||0))}:{heightMm:height};dimensionOverrides[dimId(f,it)]=v;try{localStorage.setItem(dimKey,JSON.stringify(dimensionOverrides))}catch{}rebuild();showDimension();}
$('#dimensionObject').onchange=showDimension;
$('#cabinetRole').onchange=()=>{const defaults={counter:850,low:600,bar:1000,appliance:2000};$('#dimensionHeight').value=defaults[$('#cabinetRole').value]||resolved.byId[selectedDimension().f.id].clearHeight;saveDimension()};
$('#dimensionHeight').onchange=saveDimension;$('#dimensionSill').onchange=saveDimension;
$('#dimensionReset').onclick=()=>{const {f,it}=selectedDimension();delete dimensionOverrides[dimId(f,it)];try{localStorage.setItem(dimKey,JSON.stringify(dimensionOverrides))}catch{}rebuild();showDimension()};
$('#dimensionExport').onclick=()=>save(data.projectId+'-柜体门窗参数.json',new Blob([JSON.stringify({version:1,projectId:data.projectId,overrides:dimensionOverrides},null,2)],{type:'application/json'}));
$('#dimensionImport').onchange=async e=>{const file=e.target.files[0];if(!file)return;try{const doc=JSON.parse(await file.text());if(doc.projectId&&doc.projectId!==data.projectId)throw new Error('Parameters belong to a different project');if(!doc.overrides||typeof doc.overrides!=='object')throw new Error('Missing overrides');const imported=validateOverrides(data,doc.overrides);dimensionOverrides={...dimensionOverrides,...imported};for(const [key,aliases] of Object.entries(data.overrideAliases||{}))if(imported[key])for(const alias of aliases)if(!imported[alias])dimensionOverrides[alias]={...imported[key]};localStorage.setItem(dimKey,JSON.stringify(dimensionOverrides));rebuild();showDimension();$('#dimensionNote').textContent='已导入 '+Object.keys(imported).length+' 项设置';}catch(err){$('#dimensionNote').textContent='Import failed: '+err.message;}finally{e.target.value=''}};
showDimension();

$('#furnColor').checked=furnColor;
if(data.view.cutCabinets===false)$('#low').parentElement.lastChild.textContent=' 剖低墙体（柜体显示实际高度）';
$('#slab').value=data.defaults.slab;$('#projectTitle').textContent=data.name;document.title=data.name;$('#projectNotes').textContent=(data.notes||[]).join('\n');
rebuild();resize();fit();$('#status').textContent='Three.js / WebGL · 家具白模与室内漫游';
let lastFrame=performance.now();function animate(now=performance.now()){requestAnimationFrame(animate);const dt=(now-lastFrame)/1000;lastFrame=now;if(walkMode)walkTick(dt);else controls.update();renderer.render(scene,camera)}animate();
