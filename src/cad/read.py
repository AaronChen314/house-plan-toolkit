"""Source-preserving DXF inspection. No semantic recolouring or bearing inference."""
from pathlib import Path
import argparse,json,hashlib
import ezdxf
from ezdxf import path as dp,bbox

def inspect(source,box=None):
 doc=ezdxf.readfile(source);rows=[];issues=[]
 # 嵌套块在装修图里很常见，递归展开会指数爆炸（实测 425 图元的图展成十几万次、吃满内存）。
 # 三重设限：深度、同一 INSERT 链不重复、总行数上限。
 MAX_DEPTH=2;MAX_ROWS=50000;truncated=[False];EXPAND=[False]
 def capped(identity,reason):
  if not truncated[0]:issues.append({'id':identity,'message':reason})
  truncated[0]=True
 def visit(e,chain=(),layer='0',color=7,depth=0):
  handle=e.dxf.get('handle') or ('virtual-'+str(len(rows)));identity='/'.join((*chain,handle))
  effective_layer=e.dxf.layer if e.dxf.layer!='0' else layer
  aci=e.dxf.get('color',256);resolved=doc.layers.get(effective_layer).color if aci==256 and effective_layer in doc.layers else color if aci==0 else aci
  if e.dxftype()=='INSERT':
   if not EXPAND[0]:
    row={'id':identity,'handle':handle,'blockPath':list(chain),'type':'INSERT','layer':e.dxf.layer,'effectiveLayer':effective_layer,'aci':aci,'resolvedAci':resolved,'linetype':e.dxf.get('linetype','BYLAYER'),'insert':[round(e.dxf.insert.x,3),round(-e.dxf.insert.y,3)],'block':e.dxf.name};rows.append(row);return
   if depth>=MAX_DEPTH: capped(identity,'Nested block depth exceeded (max %d)'%MAX_DEPTH);return
   if handle in chain: capped(identity,'Cyclic block reference');return
   if len(rows)>=MAX_ROWS: capped(identity,'Entity limit reached (%d)'%MAX_ROWS);return
   # Pair originals with transformed entities when possible; keep block instance path.
   originals=list(doc.blocks[e.dxf.name]);virtual=list(e.virtual_entities(skipped_entity_callback=lambda ent,reason:issues.append({'id':identity,'message':reason})))
   for i,v in enumerate(virtual):
    if len(rows)>=MAX_ROWS: capped(identity,'Entity limit reached (%d)'%MAX_ROWS);break
    original=originals[i].dxf.handle if len(originals)==len(virtual) else 'virtual-'+str(i)
    v.dxf.handle=original;visit(v,(*chain,handle),effective_layer,resolved,depth+1)
   for attr in e.attribs:visit(attr,(*chain,handle),effective_layer,resolved,depth+1)
   return
  b=bbox.extents([e]);
  if box and b.has_data and (b.extmax.x<box[0] or b.extmin.x>box[2] or b.extmax.y<box[1] or b.extmin.y>box[3]):return
  row={'id':identity,'handle':handle,'blockPath':list(chain),'type':e.dxftype(),'layer':e.dxf.layer,'effectiveLayer':effective_layer,'aci':aci,'resolvedAci':resolved,'linetype':e.dxf.get('linetype','BYLAYER')}
  try:
   if e.dxftype() in ['TEXT','MTEXT','ATTRIB','ATTDEF']:
    p=e.dxf.insert;row.update(text=e.plain_text() if hasattr(e,'plain_text') else e.dxf.text,at=[p.x,-p.y],height=(e.dxf.get('char_height',100) if e.dxftype()=='MTEXT' else e.dxf.get('height',100)),rotation=-e.dxf.get('rotation',0))
   else:row['points']=[[float(p.x),float(-p.y)] for p in dp.make_path(e).flattening(.5)]
  except (TypeError,ValueError,AttributeError) as exc:
   row['unrenderedReason']=str(exc);issues.append({'id':identity,'type':e.dxftype(),'message':'Retained in index; preview geometry unsupported'})
  rows.append(row)
 for e in sorted(doc.modelspace(), key=lambda x: 1 if x.dxftype()=='INSERT' else 0):visit(e)
 return {'schema':'cad-source/v1','truncated':truncated[0],'source':{'file':Path(source).name,'sha256':hashlib.sha256(Path(source).read_bytes()).hexdigest(),'insunits':doc.units},'coordinateSystem':{'x':'right','y':'down','units':'source drawing units','transform':'x=CAD.x; y=-CAD.y; block transforms resolved'},'cropCad':box,'entities':rows,'issues':issues}

if __name__=='__main__':
 p=argparse.ArgumentParser(description=__doc__);p.add_argument('source');p.add_argument('--out',required=True);p.add_argument('--box',nargs=4,type=float);p.add_argument('--blocks',action='store_true',help='展开块内图元（家具块很多，默认只索引顶层）');a=p.parse_args()
 if a.blocks: EXPAND[0]=True
 out=Path(a.out);out.mkdir(parents=True,exist_ok=True)
 data=inspect(a.source,a.box)
 (out/'source.json').write_text(json.dumps(data,ensure_ascii=False,indent=2))
 print(json.dumps({'entities':len(data['entities']),'issues':len(data['issues']),'truncated':data.get('truncated',False),'output':str(out/'source.json')}))
