"""PDF/图片 → 底图 PNG。只做栅格化，不做识别：识别交给 cadvec 或人。"""
from pathlib import Path
import argparse, json
import fitz


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('source')
    p.add_argument('--out', required=True)
    p.add_argument('--dpi', type=int, default=200)
    p.add_argument('--page', type=int, default=0)
    a = p.parse_args()
    out = Path(a.out); out.mkdir(parents=True, exist_ok=True)
    doc = fitz.open(a.source)
    if a.page < 0 or a.page >= doc.page_count:
        print(json.dumps({'error': f'页码超出范围：{a.page}（共 {doc.page_count} 页）'}))
        raise SystemExit(2)
    page = doc.load_page(a.page)
    pix = page.get_pixmap(dpi=a.dpi)
    target = out / 'underlay.png'
    pix.save(target)
    # PDF 单位 pt = 1/72 inch；一个像素对应多少毫米，供 studio 设比例
    mm_per_px = 25.4 / a.dpi
    print(json.dumps({
        'pages': doc.page_count,
        'page': a.page,
        'dpi': a.dpi,
        'width': pix.width,
        'height': pix.height,
        'mmPerPx': round(mm_per_px, 6),
        'output': str(target)
    }, ensure_ascii=False))


if __name__ == '__main__':
    main()
