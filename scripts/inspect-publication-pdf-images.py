"""Independent tagged-PDF image geometry and raster-color checks for synthetic exports."""
import argparse, hashlib, json
from pathlib import Path
import pdfplumber
import pypdf
import pypdfium2 as pdfium
from PIL import Image
p=argparse.ArgumentParser();p.add_argument('pdf');p.add_argument('snapshot');p.add_argument('images');p.add_argument('output');p.add_argument('--margin',type=int,default=16);a=p.parse_args()
s=json.loads(Path(a.snapshot).read_text(encoding='utf-8-sig'));resources=s['content']['resources'];ordered=[r for r in resources if r['placement']=='cover']
for c in s['content']['chapters']:
    for position in ['chapter-start','chapter-end']: ordered += [r for r in resources if r['placement']==position and r['chapterId']==c['id']]
reader=pypdf.PdfReader(a.pdf);alts=[]
def visit(node):
    node=node.get_object() if hasattr(node,'get_object') else node
    if isinstance(node,list):
        for x in node:visit(x)
    elif isinstance(node,dict):
        if node.get('/S')=='/Figure' and node.get('/Alt'):alts.append(str(node['/Alt']))
        if '/K' in node:visit(node['/K'])
visit(reader.trailer['/Root'].get('/StructTreeRoot',{}))
assert alts==[r['alt'] for r in ordered], 'Frozen image alternative text is missing or reordered in PDF tags'
boxes=[]
with pdfplumber.open(a.pdf) as pdf:
    for n,page in enumerate(pdf.pages):
        for image in page.images:
            margin=a.margin*72/25.4;bottom=page.height-(a.margin+4)*72/25.4
            assert image['x0']>=margin-1 and image['x1']<=page.width-margin+1
            assert image['top']>=margin-1 and image['bottom']<=bottom+1
            boxes.append({'page':n,'box':[image['x0'],image['top'],image['x1'],image['bottom']],'sourceSize':image['srcsize']})
assert len(boxes)==len(ordered), 'Image placement count differs from frozen snapshot'
out=Path(a.output);out.mkdir(parents=True,exist_ok=True);pdf=pdfium.PdfDocument(a.pdf);pages=[];samples=[]
try:
    for n in range(len(pdf)):
        page=pdf[n];bitmap=page.render(scale=1.5);rendered=bitmap.to_pil().convert('RGB');name=f'image-page-{n+1:03}.png';rendered.save(out/name);pages.append(name)
        for placement,resource in zip(boxes,ordered):
            if placement['page']!=n:continue
            x0,y0,x1,y1=placement['box'];w,h=resource['image']['width'],resource['image']['height']
            # Chromium quantizes a constrained image edge to a CSS pixel (0.75 pt).
            aspect_error=min(abs((x1-x0)-(y1-y0)*w/h),abs((y1-y0)-(x1-x0)*h/w))
            assert aspect_error<=0.76, f'Aspect error exceeds one CSS pixel: {aspect_error}'
            path=Path(a.images)/(resource['image']['sha256']+'.png');raw=path.read_bytes();assert hashlib.sha256(raw).hexdigest()==resource['image']['sha256']
            with Image.open(path) as source:
                rgba=source.convert('RGBA');white=Image.new('RGBA',rgba.size,'white');white.alpha_composite(rgba);source_rgb=white.convert('RGB')
                differences=[]
                for fx,fy in [(0.25,0.25),(0.5,0.5),(0.75,0.75),(0.2,0.8),(0.8,0.2)]:
                    selected=None
                    for dy in [0,-2,2,-4,4,-6,6,-8,8]:
                        for dx in [0,-2,2,-4,4,-6,6,-8,8]:
                            sx=min(w-3,max(2,int(w*fx)+dx));sy=min(h-3,max(2,int(h*fy)+dy))
                            extrema=source_rgb.crop((sx-2,sy-2,sx+3,sy+3)).getextrema()
                            if all(high-low<=24 for low,high in extrema):selected=(sx,sy);break
                        if selected:break
                    assert selected is not None, 'Synthetic sample has no flat patch; do not compare antialiased shape boundaries'
                    sx,sy=selected;fx=(sx+0.5)/w;fy=(sy+0.5)/h
                    expected=source_rgb.getpixel((sx,sy))
                    actual=rendered.getpixel((min(rendered.width-1,int((x0+(x1-x0)*fx)*1.5)),min(rendered.height-1,int((y0+(y1-y0)*fy)*1.5))))
                    difference=max(abs(x-y) for x,y in zip(expected,actual));assert difference<=12, f'Image sample differs: {expected} vs {actual}'
                    differences.append(difference)
            samples.append({'placement':resource['placement'],'page':n+1,'sha256':resource['image']['sha256'],'maximumSampleDifference':max(differences),'samples':len(differences),'aspectRoundingErrorPoints':aspect_error})
        bitmap.close();page.close()
finally:pdf.close()
report={'status':'passed','pdfSha256':hashlib.sha256(Path(a.pdf).read_bytes()).hexdigest(),'snapshotHash':s['hash'],'pages':len(pages),'placements':boxes,'imageSamples':samples,'alternativeText':alts,'renderedPages':pages,'scope':'Independent pypdf structure, pdfplumber image bounds and PDFium raster sampling of synthetic frozen images; not exhaustive photo fidelity or screen-reader certification'}
(out/'pdf-image-inspection.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n',encoding='utf8');print(json.dumps({'status':'passed','pages':len(pages),'placements':len(boxes),'samples':len(samples)*5}))
