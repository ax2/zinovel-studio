"""Independent PNG/OOXML placement inspection for illustrated publication exports."""
import argparse
import hashlib
import io
import json
import posixpath
from pathlib import Path
from zipfile import ZipFile
import xml.etree.ElementTree as ET
from PIL import Image

parser=argparse.ArgumentParser()
parser.add_argument('docx')
parser.add_argument('snapshot')
parser.add_argument('output')
parser.add_argument('--pdf')
args=parser.parse_args()
snapshot=json.loads(Path(args.snapshot).read_text(encoding='utf-8-sig'))
resources=snapshot['content'].get('resources',[])
chapters=snapshot['content']['chapters']
ordered=[r for r in resources if r['placement']=='cover']
for chapter in chapters:
    ordered += [r for r in resources if r['placement']=='chapter-start' and r['chapterId']==chapter['id']]
    ordered += [r for r in resources if r['placement']=='chapter-end' and r['chapterId']==chapter['id']]
expected={r['image']['sha256']:r['image'] for r in resources}
ns={'w':'http://schemas.openxmlformats.org/wordprocessingml/2006/main','wp':'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing','a':'http://schemas.openxmlformats.org/drawingml/2006/main','r':'http://schemas.openxmlformats.org/officeDocument/2006/relationships'}
with ZipFile(args.docx) as archive:
    assert archive.testzip() is None
    xml=ET.fromstring(archive.read('word/document.xml'))
    rels={r.attrib['Id']:r.attrib for r in ET.fromstring(archive.read('word/_rels/document.xml.rels'))}
    media={name:archive.read(name) for name in archive.namelist() if name.startswith('word/media/') and not name.endswith('/')}
    actual={hashlib.sha256(data).hexdigest():data for data in media.values()}
    assert len(media)==len(expected) and set(actual)==set(expected)
    for sha,image in expected.items():
        data=actual[sha]
        assert len(data)==image['bytes']
        with Image.open(io.BytesIO(data)) as decoded:
            assert decoded.format=='PNG' and decoded.size==(image['width'],image['height'])
            decoded.verify()
    drawings=xml.findall('.//wp:inline',ns)
    assert not xml.findall('.//wp:anchor',ns)
    assert len(drawings)==len(ordered)
    section=xml.find('.//w:sectPr',ns)
    page=section.find('w:pgSz',ns).attrib
    margin=section.find('w:pgMar',ns).attrib
    width=(int(page['{'+ns['w']+'}w'])-int(margin['{'+ns['w']+'}left'])-int(margin['{'+ns['w']+'}right']))*635
    height=(int(page['{'+ns['w']+'}h'])-int(margin['{'+ns['w']+'}top'])-int(margin['{'+ns['w']+'}bottom']))*635
    placements=[]
    for drawing,resource in zip(drawings,ordered):
        props=drawing.find('wp:docPr',ns).attrib
        assert props['descr']==resource['alt'].replace('\r\n','\n').replace('\r','\n')
        embed=drawing.find('.//a:blip',ns).attrib['{'+ns['r']+'}embed']
        rel=rels[embed]
        assert rel.get('TargetMode')!='External'
        target=posixpath.normpath('word/'+rel['Target'])
        assert target in media
        assert hashlib.sha256(media[target]).hexdigest()==resource['image']['sha256']
        size=drawing.find('wp:extent',ns).attrib
        cx,cy=int(size['cx']),int(size['cy'])
        assert 0<cx<=width and 0<cy<=height
        assert abs(cx*resource['image']['height']-cy*resource['image']['width'])<=max(resource['image']['width'],resource['image']['height'])
        placements.append({'placement':resource['placement'],'sha256':resource['image']['sha256'],'cx':cx,'cy':cy,'alt':props['descr']})
report={'status':'passed','docxSha256':hashlib.sha256(Path(args.docx).read_bytes()).hexdigest(),'snapshotHash':snapshot['hash'],'images':len(expected),'placements':placements,'scope':'Independent standard-library OOXML and Pillow decoding; rendered PDF is separately identified'}
if args.pdf:
    import pdfplumber
    boxes=[]
    with pdfplumber.open(args.pdf) as pdf:
        for index,page in enumerate(pdf.pages):
            for image in page.images:
                assert image['x0']>=-1 and image['x1']<=page.width+1
                assert image['top']>=-1 and image['bottom']<=page.height+1
                boxes.append({'page':index+1,'x0':image['x0'],'x1':image['x1'],'top':image['top'],'bottom':image['bottom']})
    assert len(boxes)>=len(ordered)
    report['renderedImageBounds']=boxes
Path(args.output).parent.mkdir(parents=True,exist_ok=True)
Path(args.output).write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n',encoding='utf8')
print(json.dumps({'status':'passed','images':len(expected),'placements':len(ordered),'renderedImages':len(report.get('renderedImageBounds',[]))}))
