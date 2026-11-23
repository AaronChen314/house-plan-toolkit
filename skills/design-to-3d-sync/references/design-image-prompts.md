# 设计出图 prompt 模板

用于“基础图 + 风格意向图 → 彩平图 / 室内效果图”。模板中的图片编号按实际传入顺序替换；基础图始终是 Image 1，风格图从 Image 2 开始。中文说明给设计者看，交给生图模型的 prompt 可以直接使用英文主体。

## 通用约束

每张图都保留以下边界：

- Image 1 是几何基础图，控制墙、门窗、家具数量与位置、镜头和画面边界。
- Image 2 及之后只控制材质、配色、灯光、软装和表面质感。
- 不新增或删除门洞、窗洞、房间、家具、楼梯和梁柱。
- 不改变基础图的镜头、视平线、焦距和裁切。
- 不生成文字、数字、尺寸线、指北针或水印；这些由数据图层叠加。
- 墙面、柜体、门框和窗框保持垂直，避免广角、鱼眼和结构拉伸。
- 不使用参考图中的户型、家具布局或房间数量。

## 彩平图

基础图要求：正上方正交投影，白模或已确认的平面核对图；隐藏天花和悬挂物，保留墙线、门窗、家具占地和房间边界。

    Use case: architectural-visualization
    Asset type: residential interior color floor plan
    Primary request: turn the orthographic plan in Image 1 into a polished material color plan.
    Input images: Image 1 is the geometry-locked orthographic floor plan; Images 2-3 are style references for materials, palette and lighting only.
    Scene/backdrop: straight top-down view of the complete floor plan.
    Subject: walls, doors, windows, built-in cabinets, movable furniture and floor finishes already present in Image 1.
    Style/medium: high-end interior design color plan, realistic material swatches, clean editorial presentation.
    Composition/framing: exact same plan orientation, room boundaries, wall lines, openings and furniture footprints as Image 1; no perspective; no camera tilt.
    Lighting/mood: soft even daylight, gentle contact shadows, no hard spotlights.
    Color palette: follow the style references, keep a restrained neutral base with walnut, warm white and stone tones where requested.
    Materials/textures: wood herringbone floor, stone or tile in wet areas, fabric upholstery, matte painted walls, realistic but subtle texture scale.
    Constraints: preserve every wall, opening, room boundary and furniture footprint from Image 1; change only surface materials, color, lighting and small surface details; walls cut at about 1.1 m; no ceiling; no hanging lights; no people; no text; no dimensions; no north arrow; no watermark; no new furniture.
    Avoid: perspective, isometric view, fisheye, distorted walls, floating objects, extra doors or windows, changed room shapes, readable generated text.

生成后再由设计数据叠加房间名、面积、尺寸线和指北针。不要把这些内容交给生图模型。

## 室内效果图

基础图要求：已经固定的三维机位渲染，机位、焦距、视平线和画面边界确认；风格图只负责材质与光线。

    Use case: architectural-visualization
    Asset type: residential interior perspective render
    Primary request: create a photoreal interior visualization from the fixed camera view in Image 1, using the visual language of Images 2-4.
    Input images: Image 1 is the geometry-locked camera render; Images 2-4 are style references for materials, lighting, palette and soft furnishing only.
    Scene/backdrop: the exact room, wall, window and furniture layout shown in Image 1.
    Subject: the existing architecture and furniture in Image 1; keep their positions, proportions and silhouettes.
    Style/medium: high-end interior design magazine photography, realistic materials, natural perspective, restrained color grading.
    Composition/framing: preserve the camera position, eye level, focal length, crop and vertical lines of Image 1.
    Lighting/mood: soft daylight, low contrast, gentle ambient bounce, lamps emitting warm light where present; no harsh light spots.
    Color palette: take only the palette and material relationships from the style references.
    Materials/textures: realistic wood grain, stone, plaster, linen, leather or lacquer as specified by the references; correct texture scale.
    Constraints: keep all walls, windows, doors, openings, ceiling form, built-in cabinets and furniture unchanged; change only materials, lighting, soft furnishings and surface details; no new furniture; no extra doors or windows; no people; no text; no logo; no watermark.
    Avoid: fisheye, exaggerated wide angle, tilted verticals, plastic surfaces, CGI look, over-sharpening, oversaturation, distorted geometry.

## 剖切鸟瞰

基础图要求：已确认的鸟瞰或轴测白模，楼层关系和开洞可见。

    Use case: architectural-visualization
    Asset type: residential cutaway dollhouse render
    Primary request: turn the white-model bird's-eye view in Image 1 into a material-rich cutaway visualization.
    Input images: Image 1 is the geometry-locked bird's-eye model; Images 2-3 are style references for materials, palette and lighting only.
    Scene/backdrop: the exact floor plan, room arrangement and openings shown in Image 1.
    Subject: walls, floors, built-in cabinets and furniture already present in Image 1.
    Style/medium: refined architectural dollhouse render, realistic materials, clean editorial presentation.
    Composition/framing: preserve the same plan orientation, floor relationship, cut height and camera angle as Image 1.
    Lighting/mood: soft natural daylight, gentle ambient occlusion, no dramatic spotlights.
    Color palette: follow the style references, keep a calm neutral base.
    Materials/textures: wood floor, stone, plaster, fabric and cabinetry with realistic scale.
    Constraints: keep every wall, opening, room boundary, floor level, stair and furniture footprint; change only materials, lighting and surface detail; no roof; no people; no text; no watermark; no invented furniture or rooms.
    Avoid: perspective distortion, changed floor count, floating walls, extra doors or windows, CG plastic look.

## 立面与定制柜

基础图要求：正立面或柜体立面，分格、层板和门缝清楚。

    Use case: architectural-visualization
    Asset type: residential millwork elevation
    Primary request: apply the referenced materials and lighting to the cabinet elevation in Image 1.
    Input images: Image 1 is the geometry-locked elevation; Image 2 is the material and color reference.
    Scene/backdrop: straight-on elevation of the built-in cabinetry shown in Image 1.
    Subject: the exact cabinet modules, shelves, open niches, doors, drawers and end panels in Image 1.
    Style/medium: high-end interior millwork presentation, realistic veneer and upholstered panel materials.
    Composition/framing: preserve the elevation outline, module divisions, shelf heights, door seams and reveal lines of Image 1.
    Lighting/mood: soft even studio light with gentle shadow in recesses.
    Color palette: walnut veneer paired with warm off-white leather-textured panels where specified.
    Materials/textures: realistic wood grain, leather texture, matte lacquer, subtle edge details.
    Constraints: do not change cabinet width, height, module count, shelf heights or opening positions; no new handles or decorative objects; no text; no dimensions; no watermark.
    Avoid: perspective, distorted verticals, changed module layout, floating shelves, oversaturated wood.

## 材质与收口细节

基础图要求：近景渲染或材质样板，构件边界和纹理尺度清楚。

    Use case: architectural-visualization
    Asset type: interior material and detail close-up
    Primary request: render the material and finish detail shown in Image 1 using the material language in Image 2.
    Input images: Image 1 is the geometry-locked close-up; Image 2 is the material, color and texture reference.
    Scene/backdrop: the exact edge, joint, panel or surface shown in Image 1.
    Subject: the existing material surface, trim, reveal, cabinet edge or upholstery detail in Image 1.
    Style/medium: high-end interior detail photography, realistic material response, restrained editorial finish.
    Composition/framing: preserve the crop, angle, scale and visible edge geometry of Image 1.
    Lighting/mood: soft directional light, gentle highlights, readable texture without glare.
    Color palette: follow the material reference only.
    Materials/textures: realistic wood grain, leather, stone, plaster, metal or fabric with correct physical scale.
    Constraints: keep every visible edge, joint, thickness and reveal unchanged; no new objects; no text; no logo; no watermark; no exaggerated reflections.
    Avoid: plastic surfaces, fake grain, oversharpening, oversaturation, distorted edges, changed material thickness.

## 生成记录

每张图在 render-manifest.json 中记录：

    {
      "id": "living-room-01",
      "kind": "interior-perspective",
      "base": "render/living-room-01.png",
      "styleRefs": ["style/neutral-walnut.jpg", "style/soft-daylight.jpg"],
      "prompt": "实际提交的 prompt",
      "tool": "built-in imagegen",
      "model": "provider default or explicit model",
      "size": "1536x1024",
      "seed": null,
      "output": "visuals/living-room-01.png",
      "checks": {
        "geometry": "pass",
        "openings": "pass",
        "furniture": "pass",
        "text": "none"
      },
      "status": "generated"
    }

status 只表示生图完成，不代表设计或施工验收通过。几何、标注和空间关系仍需按 design-image-render skill 的验收项检查。
