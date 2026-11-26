"""PDF / 图片 / DXF → 底图 PNG。只做栅格化，不做识别：识别交给 AI 或人。"""
from pathlib import Path
import argparse, json, sys
import fitz

PX_MM = 4.0  # DXF 底图：1 像素 = 4 mm（14m 的户型约 3500px，够 AI 看清又不过大）


def from_pdf(src, out_dir, dpi, page_no):
    doc = fitz.open(src)
    if page_no < 0 or page_no >= doc.page_count:
        return {'error': f'页码超出范围：{page_no}（共 {doc.page_count} 页）'}
    page = doc.load_page(page_no)
    pix = page.get_pixmap(dpi=dpi)
    target = out_dir / 'underlay.png'
    pix.save(target)
    return {'pages': doc.page_count, 'page': page_no, 'dpi': dpi, 'width': pix.width,
            'height': pix.height, 'mmPerPx': round(25.4 / dpi, 6), 'origin': [0, 0], 'output': str(target)}


def from_dxf(src, out_dir):
    import ezdxf
    from ezdxf import path as ezpath
    doc = ezdxf.readfile(src)
    msp = doc.modelspace()
    make_path = getattr(ezpath, 'make_path', None) or getattr(ezpath, 'from_entity')
    segs, xs, ys = [], [], []
    for e in msp:
        try:
            p = make_path(e)
        except Exception:
            continue
        if not p:
            continue
        try:
            pts = [(v.x, v.y) for v in p.flattening(1.0)]
        except Exception:
            continue
        for a, b in zip(pts, pts[1:]):
            segs.append((a, b))
            xs += [a[0], b[0]]; ys += [a[1], b[1]]
    if not segs:
        return {'error': 'DXF 里没有可画的线'}
    minx, maxx, miny, maxy = min(xs), max(xs), min(ys), max(ys)
    w_pt, h_pt = (maxx - minx) / PX_MM, (maxy - miny) / PX_MM
    page = fitz.open().new_page(width=w_pt, height=h_pt)
    # y 轴翻转：DXF 向上为正，图片向下为正
    def to_pt(x, y):
        return fitz.Point((x - minx) / PX_MM, (maxy - y) / PX_MM)
    for a, b in segs:
        page.draw_line(to_pt(*a), to_pt(*b), color=(0, 0, 0), width=0.3)
    pix = page.get_pixmap(dpi=72)  # 1pt = 1px
    target = out_dir / 'underlay.png'
    pix.save(target)
    return {'pages': 1, 'page': 0, 'dpi': 72, 'width': pix.width, 'height': pix.height,
            'mmPerPx': PX_MM, 'origin': [round(minx, 3), round(miny, 3)], 'output': str(target), 'segments': len(segs)}


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('source')
    p.add_argument('--out', required=True)
    p.add_argument('--dpi', type=int, default=200)
    p.add_argument('--page', type=int, default=0)
    a = p.parse_args()
    out = Path(a.out); out.mkdir(parents=True, exist_ok=True)
    suffix = Path(a.source).suffix.lower()
    info = from_dxf(a.source, out) if suffix == '.dxf' else from_pdf(a.source, out, a.dpi, a.page)
    print(json.dumps(info, ensure_ascii=False))
    if info.get('error'):
        sys.exit(2)


if __name__ == '__main__':
    main()
